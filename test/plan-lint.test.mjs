// plan-lint turns a one-off measurement into an instrument. The cases that matter are the ones that
// stop it flattering itself: a directory with no plan must be EXCLUDED rather than scored as a perfect
// zero, and a comparison across two different plan sets must say so — because deleting the worst plan
// improves every average while changing nothing about the architect.

import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { cannotFail, compare, findPlans, scoreAll, totalsOf } from '../template/.claude/harness/plan-lint.mjs'
import { load } from '../template/.claude/harness/config.mjs'
import { makeRepo } from './helpers.mjs'

const CONFIG = { commands: { verify: 'npm test', verifyFast: 'npm test' } }

// A step whose check RUNS something can report failure; a grep for a token the step itself writes
// cannot, and a step with no check at all is unverifiable.
const plan = ({ real = 0, weak = 0, none = 0 }) => {
  const lines = ['# Plan', '', '## Plan Overview', '', 'Words.', '', '### Phase 1: Do it', '']
  let n = 0

  for (let i = 0; i < real; i += 1) {
    n += 1
    lines.push(`#### Step 1.${n}: real ${i}`, '', '**File:** `src/a.ts`', '', '**Verify:** `npm test`', '')
  }

  for (let i = 0; i < weak; i += 1) {
    n += 1
    lines.push(`#### Step 1.${n}: weak ${i}`, '', '**File:** `src/a.ts`', '', '**Verify:** `test -f src/a.ts`', '')
  }

  for (let i = 0; i < none; i += 1) {
    n += 1
    lines.push(`#### Step 1.${n}: none ${i}`, '', '**File:** `src/a.ts`', '', 'No check on this one.', '')
  }

  return lines.join('\n')
}

const withPlans = entries => {
  const repo = makeRepo({ config: CONFIG })

  for (const [name, body] of Object.entries(entries)) {
    if (body === null) {
      mkdirSync(repo.path(`.claude/plans/${name}`), { recursive: true })
      continue
    }

    mkdirSync(repo.path(`.claude/plans/${name}`), { recursive: true })
    writeFileSync(repo.path(`.claude/plans/${name}/${name}.md`), body)
  }

  return repo
}

// ── Discovery ──────────────────────────────────────────────────────────────────

test('a directory with no plan document is EXCLUDED, never scored as zero', () => {
  const repo = withPlans({ 'feature-a-plan': plan({ real: 2 }), 'feature-empty-plan': null })
  const found = findPlans(repo.path('.claude/plans'))

  assert.deepEqual(found.map(entry => entry.plan), ['feature-a-plan'])
  repo.cleanup()
})

test('a plan named <dir>-plan.md inside its directory is found', () => {
  const repo = makeRepo({ config: CONFIG })

  mkdirSync(repo.path('.claude/plans/some-dir'), { recursive: true })
  writeFileSync(repo.path('.claude/plans/some-dir/feature-x-plan.md'), plan({ real: 1 }))

  assert.deepEqual(findPlans(repo.path('.claude/plans')).map(entry => entry.plan), ['some-dir'])
  repo.cleanup()
})

test('a loose markdown file at the top level is still a plan', () => {
  const repo = makeRepo({ config: CONFIG })

  mkdirSync(repo.path('.claude/plans'), { recursive: true })
  writeFileSync(repo.path('.claude/plans/hand-written.md'), plan({ real: 1 }))

  assert.deepEqual(findPlans(repo.path('.claude/plans')).map(entry => entry.plan), ['hand-written'])
  repo.cleanup()
})

test('a missing plan directory scores nothing rather than throwing', () => {
  assert.deepEqual(findPlans('/nowhere/at/all'), [])
})

// ── Scoring ────────────────────────────────────────────────────────────────────

test('steps are classified into discriminating, weak and unverifiable', () => {
  const repo = withPlans({ 'feature-mixed-plan': plan({ real: 2, weak: 3, none: 1 }) })
  const [row] = scoreAll({ ...load(repo.root), root: repo.root })

  assert.equal(row.steps, 6)
  assert.equal(row.discriminating, 2)
  assert.equal(row.weak, 3)
  assert.equal(row.unverifiable, 1)
  assert.equal(cannotFail(row), 4, 'weak and unverifiable both fail to report failure')
  repo.cleanup()
})

test('plans are ordered worst first by the share of steps that cannot fail', () => {
  const repo = withPlans({
    'feature-good-plan': plan({ real: 4, weak: 1 }),
    'feature-bad-plan': plan({ real: 1, weak: 4 })
  })

  const rows = scoreAll({ ...load(repo.root), root: repo.root })

  assert.deepEqual(rows.map(row => row.plan), ['feature-bad-plan', 'feature-good-plan'])
  repo.cleanup()
})

test('totals add the per-plan columns', () => {
  const totals = totalsOf([
    { steps: 5, discriminating: 2, weak: 2, unverifiable: 1, blocked: 0, duplicates: 1 },
    { steps: 3, discriminating: 3, weak: 0, unverifiable: 0, blocked: 2, duplicates: 0 }
  ])

  assert.deepEqual(totals, { steps: 8, discriminating: 5, weak: 2, unverifiable: 1, blocked: 2, duplicates: 1 })
})

// ── Compare, and the way it can be gamed ───────────────────────────────────────

const scoring = (takenAt, plans) => ({ takenAt, plans })
const row = (name, { steps, weak = 0, unverifiable = 0 }) => ({
  plan: name,
  steps,
  discriminating: steps - weak - unverifiable,
  weak,
  unverifiable,
  blocked: 0,
  duplicates: 0
})

test('an unchanged plan set reports no set change', () => {
  const before = scoring('a', [row('p1', { steps: 10, weak: 5 })])
  const after = scoring('b', [row('p1', { steps: 10, weak: 2 })])
  const diff = compare(before, after)

  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.moved, [{ plan: 'p1', delta: -3 }])
})

// THE ANTI-CHEAT. Deleting the worst plan moves every total in the right direction while nothing about
// the architect changed, so the set change is reported AND the common subset is computed separately.
test('deleting the worst plan is reported, and does not move the common subset', () => {
  const before = scoring('a', [row('good', { steps: 10, weak: 1 }), row('awful', { steps: 10, weak: 9 })])
  const after = scoring('b', [row('good', { steps: 10, weak: 1 })])
  const diff = compare(before, after)

  assert.deepEqual(diff.removed, ['awful'])
  assert.equal(cannotFail(diff.beforeTotals), 10)
  assert.equal(cannotFail(diff.afterTotals), 1, 'the raw totals do improve — which is exactly the trap')
  assert.equal(cannotFail(diff.commonBefore), 1)
  assert.equal(cannotFail(diff.commonAfter), 1, 'the like-for-like number is unmoved')
  assert.deepEqual(diff.moved, [], 'no common plan changed')
})

test('an added plan is reported as added', () => {
  const diff = compare(scoring('a', [row('p1', { steps: 4 })]), scoring('b', [row('p1', { steps: 4 }), row('p2', { steps: 4, weak: 4 })]))

  assert.deepEqual(diff.added, ['p2'])
  assert.deepEqual(diff.removed, [])
})

// ── The stamp ──────────────────────────────────────────────────────────────────
//
// The timestamp is passed in rather than generated, so two scorings of identical plans are identical
// files. A runtime `new Date()` here would make every scoring differ from every other and the diff
// meaningless — which is the whole point of the file.
test('two scorings of the same plans, same stamp, are byte-identical', async () => {
  const { execFileSync } = await import('node:child_process')
  const repo = withPlans({ 'feature-x-plan': plan({ real: 2, weak: 1 }) })

  const run = () =>
    execFileSync('node', [repo.path('.claude/harness/plan-lint.mjs'), '--json', '--stamp', '2026-08-15'], {
      cwd: repo.root,
      encoding: 'utf8'
    })

  assert.equal(run(), run())
  assert.match(run(), /"takenAt": "2026-08-15"/)
  repo.cleanup()
})

test('without --stamp the scoring is explicitly undated rather than stamped now', async () => {
  const { execFileSync } = await import('node:child_process')
  const repo = withPlans({ 'feature-x-plan': plan({ real: 1 }) })

  const out = execFileSync('node', [repo.path('.claude/harness/plan-lint.mjs'), '--json'], { cwd: repo.root, encoding: 'utf8' })

  assert.match(out, /"takenAt": null/)
  repo.cleanup()
})
