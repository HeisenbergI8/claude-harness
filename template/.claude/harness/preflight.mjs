#!/usr/bin/env node
// Entry conditions for a task-loop run, checked BEFORE an iteration is spent.
//
//   node .claude/harness/preflight.mjs              every check
//   node .claude/harness/preflight.mjs --iteration  only the checks that still mean something mid-run
//   node .claude/harness/preflight.mjs --json
//   node .claude/harness/preflight.mjs --self-test
//
// ── WHY THIS IS A GATE AND NOT A FIELD IN A REPORT ─────────────────────────────
//
// Reports carry lines like `Backend reachable: yes | no` for a human to read. A human reading "no"
// stops. A LOOP reading "no" carries on, and spends its entire budget verifying loading skeletons —
// every screen renders, every check passes, and none of it means anything.
//
// In the system this came from, that state was measured while the plan was being written. It is
// precisely the shape that burns twenty iterations before anyone looks.
//
// ── REFUSE, DO NOT REPAIR ──────────────────────────────────────────────────────
//
// A run that begins by fixing something it did not cause can no longer say which part of its own diff
// is its work — and "what did this run change" is the first question asked at halt time. Repairing
// here would also make the loop's first act unplanned, unrequested work.
//
// ── THIS FILE HAS NO MEMORY ────────────────────────────────────────────────────
//
// It answers "is this healthy RIGHT NOW", which is a question with no history. One flaky response is
// not evidence a dependency is down, and killing a four-hour run over a single dropped connection is
// its own failure — so the COUNTING lives in the run record (`preflightFailures`), where the driver
// can see it, and `preflight.maxConsecutiveFailures` decides when it becomes a halt.
//
// ── EVERYTHING IS OPT-IN ───────────────────────────────────────────────────────
//
// A project that configures nothing gets `cleanTree` and `treeGreen`, both of which are free. The
// network checks cost nothing when the list is empty, which is the default.

import { execFileSync, spawnSync } from 'node:child_process'

import { load } from './config.mjs'

const REACH_TIMEOUT_MS = 5000

// ── Individual checks ──────────────────────────────────────────────────────────
//
// Each returns { name, ok, reason?, entryOnly? } where `reason` is the HALT REASON verbatim, so no
// caller ever has to invent wording for a condition it did not evaluate.

// `${env:NAME}` resolves from the environment. A value that resolves to nothing is reported as UNSET,
// never as unreachable: those need different fixes, and reporting "unreachable" for an unset variable
// sends someone to check a server that is fine.
export const resolveTarget = (target, env = process.env) =>
  String(target).replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_, name) => env[name] ?? '')

export const reachableCheck = async (target, env = process.env, fetchImpl = fetch) => {
  const url = resolveTarget(target, env)
  const name = `reachable ${target}`

  if (!url.trim()) return { name, ok: false, reason: `${target} resolves to nothing — the variable it names is not set` }

  try {
    // HEAD first, and ANY HTTP RESPONSE COUNTS AS UP. A service whose root 404s is still listening;
    // only a transport error or a timeout means it is not there.
    await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(REACH_TIMEOUT_MS) })

    return { name, ok: true }
  } catch {
    return { name, ok: false, reason: `${url} is unreachable` }
  }
}

const runs = (command, cwd) => {
  const result = spawnSync(command, { shell: true, cwd, stdio: 'pipe', encoding: 'utf8' })

  return result.status === 0
}

export const commandCheck = (command, cwd) =>
  runs(command, cwd) ? { name: command, ok: true } : { name: command, ok: false, reason: `\`${command}\` failed` }

export const treeGreenCheck = (command, cwd) => {
  if (!command) return { name: 'tree-green', ok: true, note: 'no fast verify command declared' }

  return runs(command, cwd)
    ? { name: 'tree-green', ok: true }
    : { name: 'tree-green', ok: false, reason: 'started on a red tree — fix it, or this run cannot say which failures are its own' }
}

// ENTRY ONLY. By iteration two the loop has been editing on purpose, so a dirty tree is the expected
// state rather than a fault.
//
// Untracked files are ignored DELIBERATELY: scratch notes, editor droppings and the harness's own
// state directory are not changes to the project, and refusing to start because someone left a
// TODO.md lying around would make this the first check anyone disables.
export const cleanTreeCheck = cwd => {
  try {
    const porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim()

    return porcelain
      ? { name: 'clean-tree', ok: false, entryOnly: true, reason: 'dirty tree — this run could not be told apart from the changes already in it' }
      : { name: 'clean-tree', ok: true, entryOnly: true }
  } catch {
    // Not a git tree, or git is unavailable. Attribution is impossible either way, but that is a fact
    // about the environment rather than a failing precondition, so it does not block.
    return { name: 'clean-tree', ok: true, entryOnly: true, note: 'not a git working tree' }
  }
}

// ── The combiner ───────────────────────────────────────────────────────────────
//
// Pure, and the part that has actually been wrong. The FIRST failure names the halt reason: a report
// listing three problems still has to hand the driver one sentence.
export const combine = (checks = []) => {
  const failed = checks.filter(check => !check.ok)

  return { ok: failed.length === 0, checks, failed, reason: failed[0]?.reason ?? null }
}

export const preflight = async ({ config = load(), scope = 'entry', env = process.env, fetchImpl = fetch } = {}) => {
  const settings = config.preflight ?? {}
  const cwd = config.root ?? process.cwd()

  if (settings.enabled === false) return { ok: true, checks: [], failed: [], reason: null, skipped: true }

  const checks = []

  if (scope === 'entry' && settings.cleanTree !== false) checks.push(cleanTreeCheck(cwd))
  if (scope === 'entry' && settings.treeGreen !== false) checks.push(treeGreenCheck(config.commands?.verifyFast, cwd))

  for (const target of settings.reachable ?? []) checks.push(await reachableCheck(target, env, fetchImpl))
  for (const command of settings.commands ?? []) checks.push(commandCheck(command, cwd))

  return combine(checks)
}

// True when there is anything worth re-checking between iterations. Used by the driver so that a
// project which configured none of this pays nothing on every Stop.
export const hasIterationChecks = (config = load()) =>
  config.preflight?.enabled !== false && ((config.preflight?.reachable ?? []).length > 0 || (config.preflight?.commands ?? []).length > 0)

// ── --self-test ────────────────────────────────────────────────────────────────
//
// Pins the DECISION, not the network. A self-test that needs a live service fails on a train and gets
// deleted; one that pins how results are combined keeps working, and the combiner is the half that has
// actually been wrong.
const selfTest = async () => {
  let failures = 0
  let ran = 0

  const check = (label, actual, expected) => {
    ran += 1

    if (JSON.stringify(actual) === JSON.stringify(expected)) return

    failures += 1
    console.log(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }

  const reasonOf = checks => combine(checks).reason
  const okOf = checks => combine(checks).ok

  check('all green passes', okOf([{ ok: true }, { ok: true }]), true)
  check('a single failure fails the set', okOf([{ ok: false, reason: 'down' }]), false)
  check('an empty set is vacuously ok', okOf([]), true)
  check(
    'the FIRST failure names the halt reason',
    reasonOf([{ ok: true }, { ok: false, reason: 'unreachable' }, { ok: false, reason: 'dirty tree' }]),
    'unreachable'
  )

  // An unset variable and an unreachable service need different fixes.
  const unset = await reachableCheck('${env:NOT_SET_ANYWHERE}', {})

  check('an unset target is reported as unset', /is not set$/.test(unset.reason ?? ''), true)
  check('an unset target never claims to be reachable', unset.ok, false)

  // Env resolution, which is the part most likely to be quietly wrong.
  check('a plain URL is left alone', resolveTarget('http://localhost:3000', {}), 'http://localhost:3000')
  check('an env reference is substituted', resolveTarget('${env:BASE}/health', { BASE: 'http://x' }), 'http://x/health')

  // Any HTTP response means the thing is listening — including a 404.
  const notFound = await reachableCheck('http://example.test', {}, async () => ({ status: 404 }))

  check('a 404 still proves something is listening', notFound.ok, true)

  const refused = await reachableCheck('http://example.test', {}, async () => {
    throw new Error('ECONNREFUSED')
  })

  check('a transport error is unreachable', refused.ok, false)

  // The entry-only scope, which is what stops `clean-tree` failing every iteration of a working run.
  check('clean-tree is marked entry-only', cleanTreeCheck(process.cwd()).entryOnly, true)

  console.log(failures ? `  FAIL  preflight: ${ran - failures}/${ran} cases` : `  PASS  preflight: ${ran}/${ran} cases`)

  return failures ? 1 : 0
}

if (process.argv[1]?.endsWith('preflight.mjs')) {
  if (process.argv.includes('--self-test')) process.exit(await selfTest())

  const result = await preflight({ scope: process.argv.includes('--iteration') ? 'iteration' : 'entry' })

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result))
  } else if (result.skipped) {
    console.log('- preflight: disabled in harness.config.json')
  } else {
    for (const check of result.checks) {
      console.log(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}${check.reason ? ` — ${check.reason}` : ''}${check.note ? ` (${check.note})` : ''}`)
    }

    console.log(result.ok ? '\n  preflight passed' : `\n  preflight FAILED — ${result.reason}`)
  }

  process.exit(result.ok ? 0 : 1)
}
