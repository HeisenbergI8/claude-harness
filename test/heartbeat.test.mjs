// The heartbeat exists to tell "configured" apart from "firing". These tests protect that signal from
// the two things that destroy it: lost beats (which report a live hook as dead) and test-driven beats
// (which report a dead hook as live).

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { INSTRUMENTED, foldBeats, readRegisteredHooks, silentHooks } from '../template/.claude/harness/hook-heartbeat.mjs'

const line = event => `${JSON.stringify(event)}\n`

test('fold counts one per plain line', () => {
  const text = line({ n: 'claim-check', t: '2026-01-01T00:00:00Z', ev: 'Stop', k: ['session_id'] }).repeat(3)

  assert.equal(foldBeats(text).hooks['claim-check'].fired, 3)
})

// A compaction snapshot carries the running total. If compaction reset it, a healthy hook would look
// like one that had just stopped firing — the exact false alarm this file must not produce.
test('a compaction snapshot preserves the running total', () => {
  const text = line({ n: 'verify-gate', fired: 120, t: 'a', ev: 'Stop', k: [] }) + line({ n: 'verify-gate', t: 'b', ev: 'Stop', k: [] })

  assert.equal(foldBeats(text).hooks['verify-gate'].fired, 121)
})

test('payload keys accumulate as a union across events', () => {
  const text =
    line({ n: 'verify-gate', t: 'a', ev: 'Stop', k: ['session_id', 'prompt_id'] }) +
    line({ n: 'verify-gate', t: 'b', ev: 'SubagentStop', k: ['session_id', 'agent_type'] })

  assert.deepEqual(foldBeats(text).hooks['verify-gate'].keys, ['session_id', 'prompt_id', 'agent_type'])
  assert.equal(foldBeats(text).hooks['verify-gate'].event, 'SubagentStop', 'last event wins')
})

test('a torn line is skipped rather than crashing every hook that beats', () => {
  const text = line({ n: 'a', t: '1', ev: 'Stop', k: [] }) + '{"n":"b","t\n' + line({ n: 'c', t: '2', ev: 'Stop', k: [] })

  assert.deepEqual(Object.keys(foldBeats(text).hooks), ['a', 'c'])
})

test('empty input folds to nothing rather than throwing', () => {
  assert.deepEqual(foldBeats('').hooks, {})
  assert.deepEqual(foldBeats(undefined).hooks, {})
})

// ── Registration ───────────────────────────────────────────────────────────────

const SETTINGS = {
  hooks: {
    Stop: [
      {
        hooks: [
          { type: 'command', command: 'node', args: ['.claude/harness/claim-check.mjs'] },
          { type: 'command', command: 'node .claude/harness/verify-gate.mjs' }
        ]
      }
    ],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['.claude/harness/loop-breaker.mjs'] }] }]
  }
}

test('hooks are read from both the args form and the inline command form', () => {
  const registered = readRegisteredHooks(SETTINGS)

  assert.deepEqual(
    registered.map(hook => `${hook.name}@${hook.event}`).sort(),
    ['claim-check@Stop', 'loop-breaker@PostToolUse', 'verify-gate@Stop']
  )
})

test('a registered hook that never fired is reported as silent', () => {
  const seen = foldBeats(line({ n: 'claim-check', t: 'a', ev: 'Stop', k: [] })).hooks
  const silent = silentHooks(readRegisteredHooks(SETTINGS), seen, INSTRUMENTED)

  assert.deepEqual(silent.map(hook => hook.name).sort(), ['loop-breaker', 'verify-gate'])
})

// Only instrumented hooks can be reported on. Claiming a non-instrumented hook is dead would be an
// overclaim, and a false alarm is how an alarm gets ignored.
test('a hook that does not call beat() is never reported as silent', () => {
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['.claude/harness/other.mjs'] }] }] } }

  assert.deepEqual(silentHooks(readRegisteredHooks(settings), {}, INSTRUMENTED), [])
})

test('nothing registered means nothing silent', () => {
  assert.deepEqual(silentHooks([], {}, INSTRUMENTED), [])
  assert.deepEqual(readRegisteredHooks({}), [])
  assert.deepEqual(readRegisteredHooks(undefined), [])
})
