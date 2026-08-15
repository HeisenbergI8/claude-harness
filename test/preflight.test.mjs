// Preflight decides whether a run is allowed to start. Both directions are load-bearing: a check that
// refuses a healthy repo makes `/build` unusable, and one that passes an unhealthy one is the failure
// the file exists to prevent — twenty iterations spent verifying a dependency that was never up.
//
// The combiner is tested directly rather than through the network, for the reason the script's own
// self-test gives: a test that needs a live service fails on a train and gets deleted.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  combine,
  hasIterationChecks,
  preflight,
  reachableCheck,
  resolveTarget
} from '../template/.claude/harness/preflight.mjs'
import { decide } from '../template/.claude/harness/task-driver.mjs'
import { load } from '../template/.claude/harness/config.mjs'
import { REPO, makeRepo } from './helpers.mjs'

// ── The combiner ───────────────────────────────────────────────────────────────

test('an empty set of checks is vacuously ok', () => {
  assert.equal(combine([]).ok, true)
  assert.equal(combine([]).reason, null)
})

test('one failure fails the set, and the FIRST failure names the reason', () => {
  const result = combine([{ ok: true }, { ok: false, reason: 'unreachable' }, { ok: false, reason: 'dirty tree' }])

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unreachable', 'the driver needs one sentence, not a list')
  assert.equal(result.failed.length, 2)
})

// ── Target resolution ──────────────────────────────────────────────────────────

test('an env reference resolves, and a plain URL is untouched', () => {
  assert.equal(resolveTarget('${env:BASE}/health', { BASE: 'http://x' }), 'http://x/health')
  assert.equal(resolveTarget('http://localhost:3000', {}), 'http://localhost:3000')
})

// "not set" and "unreachable" need different fixes. Reporting the second for the first sends someone
// to check a server that is perfectly fine.
test('an unset variable is reported as unset, never as unreachable', async () => {
  const result = await reachableCheck('${env:NOTHING_HERE}', {})

  assert.equal(result.ok, false)
  assert.match(result.reason, /is not set$/)
})

test('any HTTP response counts as reachable, including a 404', async () => {
  const result = await reachableCheck('http://example.test', {}, async () => ({ status: 404 }))

  assert.equal(result.ok, true, 'a root that 404s is still something listening')
})

test('a transport error is unreachable', async () => {
  const result = await reachableCheck('http://example.test', {}, async () => {
    throw new Error('ECONNREFUSED')
  })

  assert.equal(result.ok, false)
})

// ── Scope ──────────────────────────────────────────────────────────────────────

test('clean-tree is checked at entry and NOT between iterations', async () => {
  const repo = makeRepo({ config: { commands: { verify: 'true', verifyFast: 'true' } } })

  execFileSync('git', ['init', '-q'], { cwd: repo.root })
  execFileSync('git', ['add', '-A'], { cwd: repo.root })

  const config = { ...load(repo.root), root: repo.root }
  const entry = await preflight({ config, scope: 'entry' })
  const iteration = await preflight({ config, scope: 'iteration' })

  assert.ok(entry.checks.some(check => check.name === 'clean-tree'))
  assert.ok(
    !iteration.checks.some(check => check.name === 'clean-tree'),
    'by iteration two the loop has been editing on purpose — a dirty tree is expected, not a fault'
  )

  repo.cleanup()
})

test('a project that configures nothing pays nothing between iterations', () => {
  assert.equal(hasIterationChecks(load('/nonexistent-for-tests')), false)
  assert.equal(hasIterationChecks({ preflight: { reachable: ['http://x'] } }), true)
  assert.equal(hasIterationChecks({ preflight: { commands: ['true'] } }), true)
  assert.equal(hasIterationChecks({ preflight: { enabled: false, commands: ['true'] } }), false)
})

test('disabled preflight stands aside rather than failing', async () => {
  const result = await preflight({ config: { preflight: { enabled: false }, root: REPO } })

  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
})

// ── Command and tree checks ────────────────────────────────────────────────────

test('a failing declared command fails preflight and names itself', async () => {
  const config = { root: REPO, commands: {}, preflight: { cleanTree: false, treeGreen: false, commands: ['exit 3'] } }
  const result = await preflight({ config })

  assert.equal(result.ok, false)
  assert.match(result.reason, /exit 3/)
})

test('a red tree refuses the run, and says so without offering to fix it', async () => {
  const config = { root: REPO, commands: { verifyFast: 'exit 1' }, preflight: { cleanTree: false } }
  const result = await preflight({ config })

  assert.equal(result.ok, false)
  assert.match(result.reason, /red tree/)
})

test('with no fast verify command declared, tree-green passes rather than blocking', async () => {
  const config = { root: REPO, commands: {}, preflight: { cleanTree: false } }
  const result = await preflight({ config })

  assert.equal(result.ok, true)
})

// ── The driver's half: counted, not immediate ──────────────────────────────────

const runState = extra => ({
  runId: 'r1',
  iteration: 1,
  phaseIteration: 0,
  redIterations: 0,
  spawns: 0,
  planPath: '.claude/plans/p/p.md',
  startedAt: new Date().toISOString(),
  lastBeatAt: new Date().toISOString(),
  budget: { iterations: 8, runMs: 1e9, iterationMs: 1e9, spawns: 14 },
  ...extra
})

const config = { taskLoop: { budget: { iterations: 8, runMs: 1e9, iterationMs: 1e9, spawns: 14 } }, preflight: { maxConsecutiveFailures: 2 } }

test('ONE failed precondition does not halt the run', () => {
  const verdict = decide(runState(), {
    signals: { verdict: { next: { phase: 1, title: 'x', passed: 0, total: 2 } } },
    preflight: { ok: false, reason: 'api unreachable', failures: 1 },
    config
  })

  assert.equal(verdict.action, 'drive', 'one dropped connection must not kill a four-hour run')
})

test('the second consecutive failure halts, naming the reason verbatim', () => {
  const verdict = decide(runState(), {
    signals: { verdict: { next: { phase: 1, title: 'x', passed: 0, total: 2 } } },
    preflight: { ok: false, reason: 'api unreachable', failures: 2 },
    config
  })

  assert.equal(verdict.action, 'halt')
  assert.match(verdict.why, /api unreachable/)
})

test('a passing precondition never halts, whatever the history', () => {
  const verdict = decide(runState({ preflightFailures: 5 }), {
    signals: { verdict: { next: { phase: 1, title: 'x', passed: 0, total: 2 } } },
    preflight: { ok: true, reason: null, failures: 0 },
    config
  })

  assert.equal(verdict.action, 'drive')
})

test('a run with no preflight configured is decided exactly as before', () => {
  const verdict = decide(runState(), {
    signals: { verdict: { next: { phase: 1, title: 'x', passed: 0, total: 2 } } },
    preflight: null,
    config
  })

  assert.equal(verdict.action, 'drive')
})

// ── The script's own self-test ─────────────────────────────────────────────────

test('preflight --self-test passes', () => {
  const out = execFileSync('node', [join(REPO, 'template/.claude/harness/preflight.mjs'), '--self-test'], { encoding: 'utf8' })

  assert.match(out, /PASS {2}preflight/)
})
