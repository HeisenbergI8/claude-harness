// The task loop's decision, and the entry point that creates its run.
//
// The decision is the part that must be right; the plumbing around it is exercised separately. Almost
// every case here pins a way the loop could abandon a run silently — which is the failure mode that
// looks exactly like the loop working.

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'

import { decide, haltReport } from '../template/.claude/harness/task-driver.mjs'
import { isBuildCommand, parseBuild } from '../template/.claude/harness/build-trigger.mjs'
import { decide as reviewDecide } from '../template/.claude/harness/review-gate.mjs'
import { DEFAULTS } from '../template/.claude/harness/config.mjs'
import { makeRepo } from './helpers.mjs'

const repos = []

after(() => repos.forEach(repo => repo.cleanup()))

const CONFIG = { taskLoop: DEFAULTS.taskLoop }

const state = (extra = {}) => ({
  runId: 'r1',
  objective: 'build the thing',
  planPath: '.claude/plans/x/x.md',
  iteration: 0,
  phaseIteration: 0,
  redIterations: 0,
  planlessIterations: 0,
  spawns: 0,
  startedAt: new Date().toISOString(),
  lastBeatAt: new Date().toISOString(),
  budget: DEFAULTS.taskLoop.budget,
  paused: false,
  halted: false,
  ...extra
})

const signals = (extra = {}) => ({ verdict: { next: { phase: '1', title: 'a', passed: 0, total: 3 } }, goalDone: false, ...extra })

const call = (s, options = {}) => decide(s, { config: CONFIG, signals: signals(), ...options })

// ── The fast path ──────────────────────────────────────────────────────────────

test('no active run releases immediately — this runs on every Stop forever', () => {
  assert.equal(decide(null, { config: CONFIG }).action, 'release')
})

test('an already-active stop hook releases', () => {
  assert.equal(call(state(), { payload: { stop_hook_active: true } }).action, 'release')
})

// ── Driving ────────────────────────────────────────────────────────────────────

test('a green tree with a bound plan drives', () => {
  const verdict = call(state())

  assert.equal(verdict.action, 'drive')
  assert.equal(verdict.next.phase, '1')
})

test('a paused run releases', () => {
  assert.equal(call(state({ paused: true })).action, 'release')
})

test('a red tree releases to the repair loop, and is counted', () => {
  const verdict = call(state(), { treeGreen: false })

  assert.equal(verdict.action, 'release')
  assert.equal(verdict.red, true, 'a red release must cost budget, or a red run never terminates')
})

// ── HALT CHECKS RUN UNCONDITIONALLY ────────────────────────────────────────────
//
// The single most important property here. Put `tree red -> release` above the halt conditions and a
// run that is red AND stuck releases every turn forever: the repair loop steps aside, the tree stays
// red, the driver keeps releasing, and NO HALT REPORT IS EVER WRITTEN. You come back to a run that
// looks like it just stopped, with nothing saying why.

test('a stuck phase halts EVEN WHEN THE TREE IS RED', () => {
  const verdict = call(state({ phaseIteration: 3 }), { treeGreen: false })

  assert.equal(verdict.action, 'halt')
  assert.match(verdict.why, /phase stuck/)
})

test('plan drift halts EVEN WHEN THE TREE IS RED', () => {
  const verdict = call(state(), { treeGreen: false, signals: signals({ verdict: { blockedBecause: 'plan-changed' } }) })

  assert.equal(verdict.action, 'halt')
})

test('the budget is reachable — a red run still exhausts it', () => {
  assert.equal(call(state({ iteration: 8 }), { treeGreen: false }).action, 'halt')
})

// ── Every halt condition ───────────────────────────────────────────────────────

for (const [label, patch, why] of [
  ['iteration budget', { iteration: 8 }, /iteration budget/],
  ['spawn budget', { spawns: 14 }, /spawn budget/],
  ['run wall clock', { startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() }, /run wall-clock/],
  ['iteration wall clock', { lastBeatAt: new Date(Date.now() - 40 * 60 * 1000).toISOString() }, /iteration wall-clock/],
  ['phase stuck', { phaseIteration: 3 }, /phase stuck/],
  ['red ceiling', { redIterations: 4 }, /tree red for 4 iterations/],
  ['no plan bound', { planPath: null, planlessIterations: 3 }, /no plan bound/]
]) {
  test(`halts on ${label}`, () => {
    const verdict = call(state(patch))

    assert.equal(verdict.action, 'halt', label)
    assert.match(verdict.why, why)
  })
}

test('halts when the plan is unfalsifiable', () => {
  const verdict = call(state(), { signals: signals({ unfalsifiable: true }) })

  assert.equal(verdict.action, 'halt')
  assert.match(verdict.why, /checks cannot fail/)
})

test('halts on needs-human and on low-confidence, naming which', () => {
  for (const blockedBecause of ['needs-human', 'low-confidence']) {
    const verdict = call(state(), { signals: signals({ verdict: { blockedBecause, needsHuman: 'phase 2: x' } }) })

    assert.equal(verdict.action, 'halt')
    assert.match(verdict.why, new RegExp(blockedBecause))
  }
})

// The only halt that means success — and the only signal that can end a run without a person.
test('goalDone halts as a SUCCESS', () => {
  const verdict = call(state(), { signals: signals({ goalDone: true }) })

  assert.equal(verdict.action, 'halt')
  assert.equal(verdict.why, 'done')
  assert.equal(verdict.success, true)
})

// ── Planless patience is bounded ───────────────────────────────────────────────
//
// A run is created BEFORE a plan exists, so the driver must stand aside while planning happens. But a
// driver with no plan releases forever, which is indistinguishable from working correctly.

test('a planless run releases while planning, and the release is counted', () => {
  const verdict = call(state({ planPath: null, planlessIterations: 0 }))

  assert.equal(verdict.action, 'release')
  assert.equal(verdict.planless, true)
})

test('planless patience runs out', () => {
  assert.equal(call(state({ planPath: null, planlessIterations: 3 })).action, 'halt')
})

// ── The halt report ────────────────────────────────────────────────────────────

test('the halt report offers both ways out, and prefers stash over a destructive revert', () => {
  const report = haltReport(state({ phaseCursor: { phase: '2' } }), 'phase stuck', {
    diff: ' src/a.ts | 4 +-',
    working: ' M src/a.ts',
    attempts: '  1. phase 2 — tried the mapper'
  })

  assert.match(report, /Resume this work/)
  assert.match(report, /Abandon this work/)
  assert.match(report, /git stash push/)
  assert.match(report, /READ THIS FIRST/)
  assert.match(report, /phase 2/)

  // The destructive form must never appear as a RUNNABLE command. It does appear in prose — the report
  // explains why stash is preferred to it — and matching the whole document would flag that sentence.
  // Same use-versus-mention discipline the harness applies to everything else, including its own tests.
  const runnable = [...report.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]).join('\n')

  assert.ok(!/git checkout\s+--\s+\./.test(runnable), 'must not offer a destructive revert as a command to run')
  assert.ok(/git checkout -- \./.test(report), 'but it should still explain why stash is preferred to it')
})

test('the halt report is still readable when nothing was recorded', () => {
  const report = haltReport(state(), 'budget spent')

  assert.match(report, /no committed changes/)
  assert.match(report, /none recorded/)
})

// ── /build parsing ─────────────────────────────────────────────────────────────

test('build command detection', () => {
  assert.equal(isBuildCommand('/build thing'), true)
  assert.equal(isBuildCommand('  /build thing'), true)
  assert.equal(isBuildCommand('/buildings are nice'), false)
  assert.equal(isBuildCommand('please build the thing'), false)
  assert.equal(isBuildCommand(''), false)
})

test('build arguments parse, and a flag value is never mistaken for the label', () => {
  assert.equal(parseBuild('/build sponsors').label, 'sponsors')
  assert.equal(parseBuild('/build --plan .claude/plans/x/x.md sponsors').label, 'sponsors')
  assert.equal(parseBuild('/build --plan .claude/plans/x/x.md sponsors').plan, '.claude/plans/x/x.md')
  assert.equal(parseBuild('/build --status').status, true)
  assert.equal(parseBuild('/build --status').label, null)
  assert.equal(parseBuild('/build --resume').resume, true)
  assert.equal(parseBuild('not a build command'), null)
})

// ── The review gate predicate ──────────────────────────────────────────────────
//
// `Stop` fires on every turn including "what does this file do?". A gate that nags wrongly gets
// switched off, so the ALLOW cases are what matter.

test('review gate: nudges only when source changed AND the full verify went green', () => {
  assert.equal(reviewDecide({ edits: ['src/a.ts'], verifyGreen: true }).action, 'nudge')
})

for (const [label, input] of [
  ['no edits — a question, not a change', { edits: [], verifyGreen: true }],
  ['no green full verify — still mid-task', { edits: ['src/a.ts'], verifyGreen: false }],
  ['already reviewed', { edits: ['src/a.ts'], verifyGreen: true, agentsRun: ['tester'] }],
  ['already nudged this turn', { edits: ['src/a.ts'], verifyGreen: true, alreadyNudged: true }],
  ['a task-loop run owns verification', { edits: ['src/a.ts'], verifyGreen: true, buildActive: true }]
]) {
  test(`review gate ALLOW: ${label}`, () => assert.equal(reviewDecide(input).action, 'pass'))
}

// Any subagent completion reaches the ledger, so an unrelated search agent must not silence the gate.
test('review gate: an unrelated agent does not count as a review', () => {
  assert.equal(reviewDecide({ edits: ['src/a.ts'], verifyGreen: true, agentsRun: ['Explore'] }).action, 'nudge')
})

// ── Run state, end to end ──────────────────────────────────────────────────────

test('a run is created, bound to a plan, and halted', async () => {
  const repo = makeRepo({ config: { commands: { verify: 'true', verifyFast: 'true' } } })

  repos.push(repo)

  const { init, activeRun, update, halt } = await import(`file://${repo.path('.claude/harness/run-state.mjs')}`)

  const cwd = process.cwd()

  process.chdir(repo.root)

  try {
    const { load } = await import(`file://${repo.path('.claude/harness/config.mjs')}`)
    const config = load(repo.root)

    const created = init({ objective: 'x', label: 'thing', sessionId: 's1' }, config)

    assert.ok(created.runId)
    assert.equal(activeRun('s1', config)?.runId, created.runId)

    // Ownership by convention is not ownership: another session must not drive this run.
    assert.equal(activeRun('s2', config), null)

    update(created.runId, { iteration: 3 }, config)
    assert.equal(activeRun('s1', config).iteration, 3)

    halt(created.runId, 'done', 'report', config)
    assert.equal(activeRun('s1', config), null, 'a halted run is never active again')
  } finally {
    process.chdir(cwd)
  }
})
