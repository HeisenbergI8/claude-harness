// THE TEST THAT CATCHES THE WORST CLASS OF BUG IN THIS HARNESS.
//
// A reader that looks for fields the writer never emits is dead and green: the gate silently stops
// working, and its unit tests keep passing because they fabricate the shape the READER wants rather than
// the shape the WRITER produces.
//
// So every assertion here drives the REAL writer, as a real subprocess, with a real hook payload, and
// then reads it back through the exported readers. Nothing is fabricated. If a field name changes in
// `record-activity.mjs` and a consumer is not updated, this goes red.

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'

import { bashPayload, editPayload, makeRepo, runHook, stopPayload } from './helpers.mjs'
import { readLedgerEvents, readTurn, recentEdits } from '../template/.claude/harness/record-activity.mjs'

const CONFIG = {
  commands: { verify: 'npm run verify', verifyFast: 'npm run typecheck' },
  source: { include: ['src/**', 'tests/**'], exclude: ['**/*.md'] }
}

const repos = []
const fresh = () => {
  const repo = makeRepo({ config: CONFIG })

  repos.push(repo)

  return repo
}

after(() => repos.forEach(repo => repo.cleanup()))

const ledger = repo => repo.read('.claude/.harness/ledger.jsonl')

test('a source edit is written, and the readers can see it', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/index.ts' }))

  const events = readLedgerEvents(ledger(repo))

  assert.equal(events.length, 1)
  assert.equal(events[0].edit, 'src/index.ts')
  assert.equal(events[0].turn, 't1')

  // The reader the gates actually use.
  assert.deepEqual(readTurn(ledger(repo), 't1').edits, ['src/index.ts'])
})

test('a non-source edit is not written at all', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'README.md' }))
  runHook(repo, 'record-activity.mjs', editPayload({ file: 'docs/design.md' }))

  assert.equal(readLedgerEvents(ledger(repo)).length, 0)
})

test('a verification command is written with its kind and exit status', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'npm run verify', ok: true }))

  const [event] = readLedgerEvents(ledger(repo))

  assert.equal(event.run, 'verify')
  assert.equal(event.ok, true)
  assert.equal(event.cmd, 'npm run verify')
})

test('a FAILED command is written with ok:false, from both failure signals', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'npm run verify', ok: false }))
  runHook(repo, 'record-activity.mjs', {
    ...bashPayload({ command: 'npm run typecheck' }),
    hook_event_name: 'PostToolUseFailure',
    tool_response: undefined
  })

  const events = readLedgerEvents(ledger(repo))

  assert.equal(events.length, 2)
  assert.ok(events.every(event => event.ok === false))
})

test('an ordinary command is not evidence and is not written', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'git status' }))
  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'ls src' }))

  assert.equal(readLedgerEvents(ledger(repo)).length, 0)
})

// verifyGreen is what a downstream gate keys on to tell "still working" from "wrapping up". It must be
// driven by the WRITER's own classification, not by a second opinion.
test('readTurn.verifyGreen tracks a green full verify only', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'npm run typecheck', ok: true }))
  assert.equal(readTurn(ledger(repo), 't1').verifyGreen, false, 'the fast gate is not the closing gate')

  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'npm run verify', ok: false }))
  assert.equal(readTurn(ledger(repo), 't1').verifyGreen, false, 'a red full verify is not green')

  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'npm run verify', ok: true }))
  assert.equal(readTurn(ledger(repo), 't1').verifyGreen, true)
})

test('turns are separated by prompt_id', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts', turn: 't1' }))
  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/b.ts', turn: 't2' }))

  assert.deepEqual(readTurn(ledger(repo), 't1').edits, ['src/a.ts'])
  assert.deepEqual(readTurn(ledger(repo), 't2').edits, ['src/b.ts'])
})

// The distinction that stops a gate silently exempting everything: "recorded, no edits" and "nothing
// recorded at all" are different facts, and only the first is safe to treat as an exemption.
test('readTurn.events distinguishes a recorded turn from an unknown one', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'npm run verify', turn: 't1' }))

  const recorded = readTurn(ledger(repo), 't1')
  const unknown = readTurn(ledger(repo), 't-nonexistent')

  assert.equal(recorded.edits.length, 0)
  assert.ok(recorded.events > 0, 'recorded but edit-free')

  assert.equal(unknown.edits.length, 0)
  assert.equal(unknown.events, 0, 'unknown, and must not be treated as an exemption')
})

test('a subagent completion is recorded against the same turn as the work', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts', turn: 't1' }))
  runHook(repo, 'record-activity.mjs', { ...stopPayload({ turn: 't1', agent: 'tester' }), tool_name: undefined })

  const turn = readTurn(ledger(repo), 't1')

  assert.deepEqual(turn.edits, ['src/a.ts'])
  assert.deepEqual(turn.agentsRun, ['tester'])
})

test('recentEdits is session-wide, de-duplicated and newest-last', () => {
  const repo = fresh()

  for (const [turn, file] of [
    ['t1', 'src/a.ts'],
    ['t1', 'src/b.ts'],
    ['t2', 'src/a.ts'],
    ['t2', 'src/c.ts']
  ]) {
    runHook(repo, 'record-activity.mjs', editPayload({ file, turn }))
  }

  assert.deepEqual(recentEdits(ledger(repo)), ['src/b.ts', 'src/a.ts', 'src/c.ts'])
})

test('a torn line is skipped rather than crashing the reader', () => {
  const events = readLedgerEvents('{"turn":"t1","edit":"src/a.ts"}\n{"turn":"t1","ed\n{"turn":"t1","run":"verify"}')

  assert.equal(events.length, 2)
})

// Concurrency is the reason the ledger is append-only JSONL rather than a rewritten object. Two agents
// firing hooks at once is normal, not exotic.
test('concurrent writers do not lose records', async () => {
  const repo = fresh()

  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      Promise.resolve().then(() =>
        runHook(repo, 'record-activity.mjs', editPayload({ file: `src/file-${index}.ts`, turn: 't1' }), {
          env: { CLAUDE_AGENT_TYPE: 'tester' }
        })
      )
    )
  )

  assert.equal(readTurn(ledger(repo), 't1').edits.length, 12)
})
