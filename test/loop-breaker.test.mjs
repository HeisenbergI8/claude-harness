// The loop breaker: ladder logic as a pure function, then the end-to-end behaviour that the pure
// function cannot express — de-duplication across two events, and the counter surviving the block.

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'

import { bashPayload, makeRepo, runHook } from './helpers.mjs'
import { decide } from '../template/.claude/harness/loop-breaker.mjs'
import { didFail } from '../template/.claude/harness/config.mjs'

const repos = []
const fresh = () => {
  const repo = makeRepo({ config: { commands: { verify: 'true', verifyFast: 'true' } } })

  repos.push(repo)

  return repo
}

after(() => repos.forEach(repo => repo.cleanup()))

// ── The ladder ─────────────────────────────────────────────────────────────────

test('one failure is silent', () => {
  assert.equal(decide({ count: 1 }).action, 'pass')
})

test('two failures inject a warning without blocking', () => {
  assert.equal(decide({ count: 2 }).action, 'inject')
})

test('three failures block', () => {
  assert.equal(decide({ count: 3 }).action, 'block')
})

// THE BUG THIS PINS: deleting the counter at the moment of blocking restarts it, so the same command
// can fail forever — blocked every third time, with the identical message, and never escalating.
// Blocking is a rung on the ladder, not the end of it.
test('a SECOND block halts rather than repeating itself', () => {
  assert.equal(decide({ count: 4, blocked: 1 }).action, 'halt')
  assert.equal(decide({ count: 9, blocked: 3 }).action, 'halt')
})

test('thresholds are configurable', () => {
  assert.equal(decide({ count: 4, injectAt: 4, blockAt: 8 }).action, 'inject')
  assert.equal(decide({ count: 8, injectAt: 4, blockAt: 8 }).action, 'block')
})

// ── Failure detection ──────────────────────────────────────────────────────────
//
// POSITIVE EVIDENCE ONLY. A breaker that fires spuriously gets switched off; one that occasionally
// misses is merely less useful.

test('an unrecognised payload shape is NOT treated as a failure', () => {
  assert.equal(didFail({ tool_response: { something: 'else' } }), false)
  assert.equal(didFail({}), false)
  assert.equal(didFail({ tool_response: null }), false)
})

test('every plausible failure field is honoured', () => {
  assert.equal(didFail({ tool_response: { exit_code: 1 } }), true)
  assert.equal(didFail({ tool_response: { exitCode: 2 } }), true)
  assert.equal(didFail({ tool_response: { is_error: true } }), true)
  assert.equal(didFail({ hook_event_name: 'PostToolUseFailure' }), true)

  assert.equal(didFail({ tool_response: { exit_code: 0 } }), false)
  assert.equal(didFail({ tool_response: { is_error: false } }), false)
})

// ── End to end ─────────────────────────────────────────────────────────────────

test('the ladder climbs: silent, inject, block', () => {
  const repo = fresh()
  const fail = id => runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run broken', ok: false, id }))

  assert.equal(fail('u1'), null, 'first failure is silent')

  const second = fail('u2')

  assert.ok(second?.hookSpecificOutput?.additionalContext, 'second failure injects')
  assert.match(second.hookSpecificOutput.additionalContext, /differ in KIND/)

  const third = fail('u3')

  assert.equal(third?.decision, 'block')
  assert.match(third.reason, /failed 3 times/)
})

test('the count survives the block, so a second block halts', () => {
  const repo = fresh()
  const fail = id => runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run broken', ok: false, id }))

  for (const id of ['u1', 'u2', 'u3']) fail(id)

  const fourth = fail('u4')
  const fifth = fail('u5')

  // Whichever of these lands on the second block must halt rather than repeat the same instruction.
  const halted = [fourth, fifth].some(response => response?.decision === 'block' && /HALT/.test(response.reason))

  assert.ok(halted, 'a repeated block must escalate to a halt')
})

test('a success resets the counter', () => {
  const repo = fresh()

  runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run flaky', ok: false, id: 'u1' }))
  runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run flaky', ok: false, id: 'u2' }))
  runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run flaky', ok: true, id: 'u3' }))

  assert.equal(
    runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run flaky', ok: false, id: 'u4' })),
    null,
    'after a pass, the next failure is a first failure again'
  )
})

test('different commands are counted separately', () => {
  const repo = fresh()

  runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run a', ok: false, id: 'u1' }))
  runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run b', ok: false, id: 'u2' }))

  assert.equal(runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run c', ok: false, id: 'u3' })), null)
})

// Both PostToolUse and PostToolUseFailure may fire for one command. Counting it twice would make the
// ladder fire at half the configured threshold.
test('the same tool_use_id is counted once across both events', () => {
  const repo = fresh()

  runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run broken', ok: false, id: 'same' }))
  runHook(repo, 'loop-breaker.mjs', {
    ...bashPayload({ command: 'npm run broken', ok: false, id: 'same' }),
    hook_event_name: 'PostToolUseFailure'
  })

  const third = runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run broken', ok: false, id: 'other' }))

  // Three hook invocations, two distinct commands: the count must be 2 (inject), not 3 (block). Counting
  // the duplicate would fire the whole ladder at half its configured threshold.
  assert.ok(third?.hookSpecificOutput?.additionalContext, 'expected an inject at count 2')
  assert.match(third.hookSpecificOutput.additionalContext, /failed 2 times/)
  assert.equal(third.decision, undefined, 'a duplicate must not have advanced the count to a block')
})

test('a subagent does not inherit the main thread count', () => {
  const repo = fresh()

  for (const id of ['u1', 'u2']) {
    runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run broken', ok: false, id }))
  }

  const asAgent = runHook(repo, 'loop-breaker.mjs', {
    ...bashPayload({ command: 'npm run broken', ok: false, id: 'u3' }),
    agent_id: 'tester-1'
  })

  assert.equal(asAgent, null, 'a different scope starts from zero')
})
