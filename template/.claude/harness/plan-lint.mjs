#!/usr/bin/env node
// Scores every plan in the plan directory and, given two saved scorings, says what moved.
//
//   node .claude/harness/plan-lint.mjs                            a table, worst first
//   node .claude/harness/plan-lint.mjs --json --stamp 2026-08-15  save a scoring
//   node .claude/harness/plan-lint.mjs --compare before.json after.json
//
// ── THIS IS THE HALF THAT MAKES A BASELINE AN EVAL ─────────────────────────────
//
// `verify-plan --lint` already grades one plan's checks. What it cannot do is answer the question that
// decides whether a prompt change was worth making:
//
//   "the new architect cut unverifiable steps from 15% to 4% across 19 plans"
//
// A number written down once is a measurement. A number you can re-take and difference is an
// instrument. Until the scoring is a file, comparing means running a shell loop and reading two tables
// side by side — which nobody does twice.
//
// ── WHAT IT MEASURES, AND ITS LIMIT ────────────────────────────────────────────
//
// `verify-plan` classifies each step's `**Verify:**` command by whether it CAN REPORT FAILURE. A
// `grep -q` for a token the step itself writes passes the moment the text is typed — runnable, but not
// a gate. The classifier is a heuristic over command shape and its own accuracy has never been
// measured, so read a small delta as noise and a large one as signal.
//
// It is evidence about PLAN DOCUMENTS, never about delivered software.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from './config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// The architect writes `<dir>/<dir>.md`. A loose `.md` at the top level is scored too, because a plan
// written by hand is still a plan.
export const findPlans = planDir => {
  if (!existsSync(planDir)) return []

  const out = []

  for (const name of readdirSync(planDir)) {
    const path = join(planDir, name)
    let entry

    try {
      entry = statSync(path)
    } catch {
      continue
    }

    if (entry.isFile() && name.endsWith('.md')) {
      out.push({ plan: name.replace(/\.md$/, ''), path })
      continue
    }

    if (!entry.isDirectory()) continue

    const candidates = readdirSync(path).filter(file => file.endsWith('.md'))
    const document = candidates.find(file => file === `${name}.md`) ?? candidates.find(file => file.endsWith('-plan.md'))

    // A DIRECTORY WITH NO PLAN DOCUMENT IS EXCLUDED, NEVER SCORED AS ZERO. "No plan" and "a plan whose
    // checks are weak" are different facts, and averaging them together hides both.
    if (document) out.push({ plan: name, path: join(path, document) })
  }

  return out.sort((a, b) => a.plan.localeCompare(b.plan))
}

export const scoreOne = ({ plan, path }, cwd = process.cwd()) => {
  const result = spawnSync(process.execPath, [join(HERE, 'verify-plan.mjs'), path, '--lint', '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe'
  })

  const line = `${result.stdout ?? ''}`.trim().split('\n').filter(Boolean).pop()

  let parsed

  try {
    parsed = JSON.parse(line)
  } catch {
    // Unparseable is not clean: the plan is reported as unscorable rather than counted as perfect.
    return { plan, path, unscorable: true }
  }

  const tally = parsed.tally ?? {}

  return {
    plan,
    path,
    steps: tally.total ?? 0,
    discriminating: tally.discriminating ?? 0,
    weak: tally.weak ?? 0,
    unverifiable: tally.unverifiable ?? 0,
    blocked: tally.blocked ?? 0,
    duplicates: (parsed.duplicates ?? []).length,
    unterminatedFence: Boolean(parsed.unterminatedFence)
  }
}

// The headline: the share of steps whose check cannot report failure. `blocked` is excluded because a
// blocked check is a configuration problem, not a weak one — it is reported in its own column.
export const cannotFail = row => (row.weak ?? 0) + (row.unverifiable ?? 0)

export const totalsOf = rows =>
  rows.reduce(
    (acc, row) => {
      for (const key of ['steps', 'discriminating', 'weak', 'unverifiable', 'blocked', 'duplicates']) acc[key] += row[key] ?? 0

      return acc
    },
    { steps: 0, discriminating: 0, weak: 0, unverifiable: 0, blocked: 0, duplicates: 0 }
  )

export const scoreAll = (config = load()) => {
  const planDir = resolve(config.root ?? process.cwd(), config.plan?.dir ?? '.claude/plans')

  return findPlans(planDir)
    .map(entry => scoreOne(entry, config.root ?? process.cwd()))
    .filter(row => !row.unscorable)
    .sort((a, b) => cannotFail(b) / (b.steps || 1) - cannotFail(a) / (a.steps || 1))
}

const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0)

// ── compare ────────────────────────────────────────────────────────────────────

export const compare = (before, after) => {
  const beforeNames = new Set(before.plans.map(row => row.plan))
  const afterNames = new Set(after.plans.map(row => row.plan))

  const beforeBy = new Map(before.plans.map(row => [row.plan, row]))
  const common = after.plans.filter(row => beforeBy.has(row.plan))

  return {
    added: [...afterNames].filter(name => !beforeNames.has(name)),
    removed: [...beforeNames].filter(name => !afterNames.has(name)),
    beforeTotals: totalsOf(before.plans),
    afterTotals: totalsOf(after.plans),
    commonBefore: totalsOf(common.map(row => beforeBy.get(row.plan))),
    commonAfter: totalsOf(common),
    moved: common
      .map(row => ({ plan: row.plan, delta: cannotFail(row) - cannotFail(beforeBy.get(row.plan)) }))
      .filter(row => row.delta !== 0)
      .sort((a, b) => a.delta - b.delta)
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('plan-lint.mjs')) {
  const at = process.argv.indexOf('--compare')

  if (at !== -1) {
    const [beforePath, afterPath] = process.argv.slice(at + 1, at + 3)

    if (!beforePath || !afterPath) {
      console.error('usage: plan-lint.mjs --compare <before.json> <after.json>')
      process.exit(2)
    }

    const read = path => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        console.error(`cannot read ${path}: ${error.message}`)
        process.exit(2)
      }
    }

    const before = read(beforePath)
    const after = read(afterPath)
    const diff = compare(before, after)

    console.log('\nplan-lint compare')
    console.log(`  before  ${before.takenAt ?? '(undated)'}  ${before.plans.length} plan(s)`)
    console.log(`  after   ${after.takenAt ?? '(undated)'}  ${after.plans.length} plan(s)`)

    // COMPARING DIFFERENT PLAN SETS IS THE EASY WAY TO FAKE AN IMPROVEMENT. Deleting the worst plan
    // moves every average in the right direction while changing nothing about the architect.
    if (diff.added.length || diff.removed.length) {
      console.log(
        `\n  ! the plan set changed — ${diff.added.length} added, ${diff.removed.length} removed.\n` +
          '    The totals below are NOT like-for-like. Read the common-subset line.'
      )
    }

    console.log('\nTOTALS')

    for (const key of ['steps', 'discriminating', 'weak', 'unverifiable', 'blocked', 'duplicates']) {
      const delta = diff.afterTotals[key] - diff.beforeTotals[key]
      const arrow = delta === 0 ? '   ' : delta < 0 ? ' v ' : ' ^ '

      console.log(
        `  ${key.padEnd(16)} ${String(diff.beforeTotals[key]).padStart(6)} -> ${String(diff.afterTotals[key]).padStart(6)}${arrow}${delta > 0 ? '+' : ''}${delta}`
      )
    }

    const beforeShare = pct(cannotFail(diff.commonBefore), diff.commonBefore.steps)
    const afterShare = pct(cannotFail(diff.commonAfter), diff.commonAfter.steps)

    console.log(
      `\n  checks that cannot fail, COMMON PLANS ONLY:  ${beforeShare.toFixed(1)}% -> ${afterShare.toFixed(1)}%  ` +
        `(${afterShare - beforeShare >= 0 ? '+' : ''}${(afterShare - beforeShare).toFixed(1)} points)`
    )

    if (diff.moved.length > 0) {
      console.log('\nPER PLAN — steps whose check cannot fail, common plans only')
      for (const { plan, delta } of diff.moved) console.log(`  ${plan.padEnd(50)} ${delta > 0 ? '+' : ''}${delta}`)
    } else {
      console.log('\nPER PLAN — no common plan changed')
    }

    console.log(
      '\nThis is evidence about PLAN DOCUMENTS, not about delivered software.\n' +
        'The classifier is a heuristic on command shape — read small deltas as noise.\n'
    )
    process.exit(0)
  }

  const config = load()
  const rows = scoreAll(config)

  if (rows.length === 0) {
    console.log(`- plan-lint: no scorable plans in ${config.plan?.dir ?? '.claude/plans'}`)
    process.exit(0)
  }

  const totals = totalsOf(rows)

  if (process.argv.includes('--json')) {
    // takenAt is PASSED IN, never generated. A timestamp baked in at runtime would make two scorings
    // of identical plans differ, and this file exists to be diffed.
    const stampAt = process.argv.indexOf('--stamp')

    console.log(JSON.stringify({ takenAt: stampAt === -1 ? null : process.argv[stampAt + 1] ?? null, plans: rows, totals }, null, 2))
    process.exit(0)
  }

  console.log(`\nplan-lint — ${rows.length} plan(s) scored\n`)
  console.log(
    `TOTAL  ${totals.steps} steps · ${cannotFail(totals)} whose check cannot fail ` +
      `(${pct(cannotFail(totals), totals.steps).toFixed(1)}%) · ${totals.blocked} blocked · ${totals.duplicates} duplicate check(s)`
  )
  console.log('\nWORST FIRST — by share of steps whose check cannot report failure')
  console.log(`  ${'plan'.padEnd(46)} ${'steps'.padStart(5)} ${'weak'.padStart(5)} ${'unver'.padStart(5)} ${'blkd'.padStart(4)}  ${'cannot fail'.padStart(11)}`)

  for (const row of rows) {
    console.log(
      `  ${row.plan.slice(0, 46).padEnd(46)} ${String(row.steps).padStart(5)} ${String(row.weak).padStart(5)} ` +
        `${String(row.unverifiable).padStart(5)} ${String(row.blocked).padStart(4)}  ${`${pct(cannotFail(row), row.steps).toFixed(0)}%`.padStart(11)}`
    )
  }

  const fences = rows.filter(row => row.unterminatedFence)

  if (fences.length) {
    console.log(`\n  ! ${fences.length} plan(s) have an unterminated code fence — every step after it was invisible to this scoring:`)
    for (const row of fences) console.log(`    ${row.plan}`)
  }

  console.log(
    '\nSave a scoring with `--json --stamp <date> > before.json`, then `--compare before.json after.json`.\n' +
      'Directories with no plan document are excluded, never scored as zero.\n'
  )
}
