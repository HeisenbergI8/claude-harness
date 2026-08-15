// The edit-check gate is the only gate here that deliberately SKIPS work, so the tests are mostly
// about the skips: each one must be able to defer a check and never to approve a broken tree.
//
// The suppression logic is a pure function for that reason — exercising it end-to-end would mean
// sleeping through the grace window in every case.

import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { decide } from '../template/.claude/harness/gate-edit-check.mjs'
import { editPayload, makeRepo, runHook } from './helpers.mjs'

const WINDOW = 15_000

// ── The decision ───────────────────────────────────────────────────────────────

test('with nothing suppressing it, the check runs', () => {
  assert.equal(decide({ mySeq: 1, currentSeq: 1, lastGreenAt: 0, now: 1_000_000, windowMs: WINDOW }).action, 'run')
})

// GRACE. Parallel tool calls in one message otherwise run this against a half-applied refactor, which
// reports errors the very next edit is about to fix.
test('a newer edit stands this one down — the later hook has the more complete tree', () => {
  const verdict = decide({ mySeq: 1, currentSeq: 2, lastGreenAt: 0, now: 1_000_000, windowMs: WINDOW })

  assert.equal(verdict.action, 'skip')
  assert.match(verdict.why, /newer edit/)
})

test('the LAST edit of a batch is the one that runs', () => {
  assert.equal(decide({ mySeq: 3, currentSeq: 3, lastGreenAt: 0, now: 1_000_000, windowMs: WINDOW }).action, 'run')
})

// WINDOW. A green result moments ago still stands.
test('a recent GREEN result suppresses the run', () => {
  assert.equal(decide({ mySeq: 1, currentSeq: 1, lastGreenAt: 999_000, now: 1_000_000, windowMs: WINDOW }).action, 'skip')
})

test('an old green result does not suppress it', () => {
  assert.equal(decide({ mySeq: 1, currentSeq: 1, lastGreenAt: 900_000, now: 1_000_000, windowMs: WINDOW }).action, 'run')
})

// THE ASYMMETRY THAT MAKES IT SAFE. A red result clears lastGreenAt, so the next edit checks
// immediately instead of waiting out the window: a broken tree gets fast feedback, a healthy one does
// not. `lastGreenAt: 0` is what "the last run was red" looks like on disk.
test('a red tree is NEVER suppressed by the window', () => {
  assert.equal(decide({ mySeq: 1, currentSeq: 1, lastGreenAt: 0, now: 1_000_000, windowMs: WINDOW }).action, 'run')
})

// ── Wiring ─────────────────────────────────────────────────────────────────────

const green = { commands: { verify: 'true', verifyFast: 'true', editCheck: 'true' } }
const red = { commands: { verify: 'true', verifyFast: 'true', editCheck: 'exit 1' } }

test('with no editCheck command declared, the hook does nothing at all', () => {
  const repo = makeRepo({ config: { commands: { verify: 'true', verifyFast: 'true' } } })

  assert.equal(runHook(repo, 'gate-edit-check.mjs', editPayload({ file: repo.path('src/a.ts') })), null)
  repo.cleanup()
})

test('a red check blocks with the output in front of the model', () => {
  const repo = makeRepo({ config: red })
  const response = runHook(repo, 'gate-edit-check.mjs', editPayload({ file: repo.path('src/a.ts') }))

  assert.equal(response.decision, 'block', 'exit 2 does not block on PostToolUse — it has to be a decision')
  assert.match(response.reason, /src\/a\.ts/)
  repo.cleanup()
})

test('a green check says nothing and records the time', () => {
  const repo = makeRepo({ config: green })

  assert.equal(runHook(repo, 'gate-edit-check.mjs', editPayload({ file: repo.path('src/a.ts') })), null)

  const state = JSON.parse(readFileSync(repo.path('.claude/.harness/edit-check-state.json'), 'utf8'))

  assert.ok(state.lastGreenAt > 0)
  repo.cleanup()
})

test('a file the project does not call source is left alone', () => {
  const repo = makeRepo({ config: red })

  assert.equal(
    runHook(repo, 'gate-edit-check.mjs', editPayload({ file: repo.path('README.md') })),
    null,
    'a turn that only touched a doc did not break the build'
  )
  repo.cleanup()
})

test('an explicit paths list overrides the source definition', () => {
  const repo = makeRepo({ config: { ...red, gates: { editCheck: { paths: ['only/**'] } } } })

  assert.equal(runHook(repo, 'gate-edit-check.mjs', editPayload({ file: repo.path('src/a.ts') })), null)
  assert.ok(runHook(repo, 'gate-edit-check.mjs', editPayload({ file: repo.path('only/b.ts') })))
  repo.cleanup()
})

test('disabling the gate in config stops it even with a command declared', () => {
  const repo = makeRepo({ config: { ...red, gates: { editCheck: { enabled: false } } } })

  assert.equal(runHook(repo, 'gate-edit-check.mjs', editPayload({ file: repo.path('src/a.ts') })), null)
  repo.cleanup()
})

test('a green result within the window suppresses the next edit', () => {
  const repo = makeRepo({ config: red })

  // A green run recorded a moment ago. The command is red, so without the window this would block.
  mkdirSync(repo.path('.claude/.harness'), { recursive: true })
  writeFileSync(repo.path('.claude/.harness/edit-check-state.json'), JSON.stringify({ seq: 0, lastGreenAt: Date.now() }))

  assert.equal(runHook(repo, 'gate-edit-check.mjs', editPayload({ file: repo.path('src/a.ts') })), null)
  repo.cleanup()
})

// A command that cannot start is a setup mistake, not a red tree. Blocking on it would block every
// edit forever, which is exactly how a gate gets ripped out.
test('a command that cannot run stands aside rather than blocking every edit', () => {
  const repo = makeRepo({ config: { commands: { verify: 'true', verifyFast: 'true', editCheck: 'definitely-not-a-real-binary-xyz' } } })

  assert.equal(runHook(repo, 'gate-edit-check.mjs', editPayload({ file: repo.path('src/a.ts') })), null)
  repo.cleanup()
})
