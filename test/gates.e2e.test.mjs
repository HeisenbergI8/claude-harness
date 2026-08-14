// The gates as Claude Code actually runs them: a real payload on stdin, a real config on disk, a real
// verify command executed by a real shell.
//
// The pure-function tests prove the LOGIC. These prove the WIRING — that the decision the logic reaches
// is the decision the hook actually emits. A harness can pass every unit test and still be inert,
// which is the failure mode the heartbeat exists for and the one these tests close by hand.

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { after, test } from 'node:test'

import { bashPayload, editPayload, makeRepo, runHook, stopPayload } from './helpers.mjs'

const spawnSelftest = repo => {
  const result = spawnSync('node', ['.claude/harness/selftest.mjs'], { cwd: repo.root, encoding: 'utf8' })

  return { status: result.status, stdout: `${result.stdout}${result.stderr}` }
}

const repos = []

// `false` and `true` are the shell builtins: a guaranteed-red and guaranteed-green verify command that
// needs no toolchain and cannot be flaky.
const fresh = ({ verifyFast = 'true', ...rest } = {}) => {
  const repo = makeRepo({
    config: {
      commands: { verify: 'npm run verify', verifyFast },
      source: { include: ['src/**'], exclude: [] },
      // The declared verifyFast is a shell builtin that no builtin pattern recognises, so it is declared
      // explicitly — exactly what the selftest tells a real user to do.
      evidence: { patterns: [{ kind: 'verify:fast', match: '^(true|false)$' }] },
      ...rest
    }
  })

  repos.push(repo)

  return repo
}

after(() => repos.forEach(repo => repo.cleanup()))

// ── claim-check ────────────────────────────────────────────────────────────────

test('claim-check blocks a turn that edited source and verified nothing', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  const response = runHook(repo, 'claim-check.mjs', stopPayload({}))

  assert.equal(response?.decision, 'block')
  assert.match(response.reason, /ran no verification/)
})

test('claim-check allows the same turn once something has run', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))
  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'npm run verify', ok: true }))

  assert.equal(runHook(repo, 'claim-check.mjs', stopPayload({})), null)
})

test('claim-check blocks a green claim with nothing behind it', () => {
  const repo = fresh()
  const response = runHook(repo, 'claim-check.mjs', stopPayload({ message: 'Done — all tests pass.' }))

  assert.equal(response?.decision, 'block')
  assert.match(response.reason, /NO verification command ran/)
})

test('claim-check stands aside after maxBlocks so a session can never be trapped', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  const first = runHook(repo, 'claim-check.mjs', stopPayload({}))
  const second = runHook(repo, 'claim-check.mjs', stopPayload({}))
  const third = runHook(repo, 'claim-check.mjs', stopPayload({}))

  assert.equal(first?.decision, 'block')
  assert.equal(second?.decision, 'block')
  assert.equal(third, null, 'the third must stand aside')
})

test('claim-check respects stop_hook_active', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  assert.equal(runHook(repo, 'claim-check.mjs', stopPayload({ active: true })), null)
})

test('claim-check can be switched off', () => {
  const repo = fresh({ gates: { claimCheck: { enabled: false } } })

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  assert.equal(runHook(repo, 'claim-check.mjs', stopPayload({})), null)
})

// ── verify-gate ────────────────────────────────────────────────────────────────

test('verify-gate is silent on a green tree', () => {
  const repo = fresh({ verifyFast: 'true' })

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  assert.equal(runHook(repo, 'verify-gate.mjs', stopPayload({})), null)
})

test('verify-gate blocks on a red tree', () => {
  const repo = fresh({ verifyFast: 'echo "error TS2345: nope" && false' })

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  const response = runHook(repo, 'verify-gate.mjs', stopPayload({}))

  assert.equal(response?.decision, 'block')
  assert.match(response.reason, /is red/)
})

test('verify-gate climbs block -> escalate -> HALT on one unchanged failure', () => {
  const repo = fresh({ verifyFast: 'echo "error TS2345: nope" && false' })

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  const first = runHook(repo, 'verify-gate.mjs', stopPayload({}))
  const second = runHook(repo, 'verify-gate.mjs', stopPayload({}))
  const third = runHook(repo, 'verify-gate.mjs', stopPayload({}))
  const fourth = runHook(repo, 'verify-gate.mjs', stopPayload({}))

  assert.match(first.reason, /is red/)
  assert.match(second.reason, /SAME FAILURE, attempt 2/)
  assert.match(third.reason, /HALT/)

  assert.ok(existsSync(repo.path('.claude/.harness/halt-report.md')), 'a halt must leave a report')
  assert.match(repo.read('.claude/.harness/halt-report.md'), /survived 3 attempts/)

  // After a halt the gate must never block that run again, or it becomes the trap it exists to avoid.
  assert.equal(fourth, null)
})

// The property that makes it a loop rather than a nag, proven end to end rather than only in the unit.
test('verify-gate never halts while the failure keeps changing', () => {
  const repo = fresh({ verifyFast: 'echo "error TS$RANDOM: shifting" && false' })

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = runHook(repo, 'verify-gate.mjs', stopPayload({}))

    assert.equal(response?.decision, 'block')
    assert.ok(!/HALT/.test(response.reason), `halted on attempt ${attempt + 1} despite a changing failure`)
  }
})

test('verify-gate stands aside for a turn that edited no source', () => {
  const repo = fresh({ verifyFast: 'false' })

  // Recorded, but with no edits — a question, not a change.
  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'npm run verify', ok: true }))

  assert.equal(runHook(repo, 'verify-gate.mjs', stopPayload({})), null)
})

test('verify-gate stands aside for agents that cannot write source', () => {
  const repo = fresh({ verifyFast: 'false' })

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  for (const agent of ['tester', 'auditor', 'change-auditor']) {
    assert.equal(runHook(repo, 'verify-gate.mjs', stopPayload({ agent })), null, `${agent} must not be blocked`)
  }
})

test('verify-gate is inert when no command is declared', () => {
  const repo = fresh()

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  const bare = makeRepo({ config: { commands: { verify: null, verifyFast: null } } })

  repos.push(bare)
  runHook(bare, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  assert.equal(runHook(bare, 'verify-gate.mjs', stopPayload({})), null)
})

test('a green run clears a counter that was one step from halting', () => {
  const repo = fresh({ verifyFast: 'echo "error TS1: x" && false' })

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))
  runHook(repo, 'verify-gate.mjs', stopPayload({}))
  runHook(repo, 'verify-gate.mjs', stopPayload({}))

  // The tree turns green: rewrite the config so verifyFast passes, exactly as a real fix would.
  const green = makeRepo({
    config: { commands: { verify: 'npm run verify', verifyFast: 'true' }, source: { include: ['src/**'], exclude: [] } }
  })

  repos.push(green)
  runHook(green, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }))

  assert.equal(runHook(green, 'verify-gate.mjs', stopPayload({})), null)
})

// ── selftest ───────────────────────────────────────────────────────────────────

// A verify command starting with a text tool is invisible to the ledger, because classification
// deliberately drops those — talking about a command is not running one. The selftest must say so
// rather than let the project run for weeks with a gate that can never be satisfied.
test('selftest fails when a declared command can never be recorded', () => {
  const repo = makeRepo({ config: { commands: { verify: 'echo done', verifyFast: 'echo done' } } })

  repos.push(repo)

  const { status, stdout } = spawnSelftest(repo)

  assert.equal(status, 1, stdout)
  assert.match(stdout, /records\s+NOTHING in the ledger/)
})

test('selftest FAILS when a registered gate has never fired', () => {
  const repo = fresh()

  // Only record-activity beats. The other three are registered and silent — which is exactly the
  // "configured but inert" state this whole file exists to detect.
  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }), { env: { CLAUDE_HOOK_TEST: '0' } })

  const { status, stdout } = spawnSelftest(repo)

  assert.equal(status, 1)
  assert.match(stdout, /registered but NEVER fired/)
})

test('selftest passes once every gate has actually fired', () => {
  const repo = fresh()
  const live = { CLAUDE_HOOK_TEST: '0' }

  runHook(repo, 'record-activity.mjs', editPayload({ file: 'src/a.ts' }), { env: live })
  runHook(repo, 'record-activity.mjs', bashPayload({ command: 'npm run verify', ok: true }), { env: live })
  runHook(repo, 'loop-breaker.mjs', bashPayload({ command: 'npm run x', ok: true, id: 'u1' }), { env: live })
  runHook(repo, 'verify-gate.mjs', stopPayload({}), { env: live })
  runHook(repo, 'claim-check.mjs', stopPayload({}), { env: live })

  const { status, stdout } = spawnSelftest(repo)

  assert.equal(status, 0, stdout)
  assert.match(stdout, /selftest: ok/)
})
