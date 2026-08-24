// Agent locks, in both directions — and the ALLOW half is much larger on purpose.
//
// This guard sits on the write path of every session in the repo. Its expensive failure is refusing a
// write that was fine: one of those and the mechanism is switched off, and then it protects nothing.
// So every scope rule is pinned in both directions, and the end-to-end cases drive the real scripts as
// real subprocesses against a repo built by the real installer.

import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import {
  decide,
  foldLocks,
  isHeld,
  moduleRootOf,
  overlaps,
  readLockEvents
} from '../template/.claude/harness/agent-locks.mjs'
import { makeRepo, runHook } from './helpers.mjs'

const MINUTE = 60_000
const STALE = 30 * MINUTE
const NOW = Date.parse('2026-08-24T12:00:00.000Z')
const ago = minutes => new Date(NOW - minutes * MINUTE).toISOString()

const ROOTS = ['src/views/apps/admin/*', 'packages/*', '.claude/plans/*', 'services/*/internal']
const SHARED = ['package.json', 'src/store/index.ts', 'CLAUDE.md', '.claude/.harness/**']

const scope = rel => moduleRootOf(rel, { roots: ROOTS, shared: SHARED })

// ── moduleRootOf: the module grain ─────────────────────────────────────────────
//
// The highest-risk function here. A bug in it is exactly the class of failure that produces a false
// refusal, so every configured shape is pinned rather than described.

for (const [file, expected] of [
  ['src/views/apps/admin/sc-winner/page.tsx', 'src/views/apps/admin/sc-winner/'],
  ['src/views/apps/admin/sc-winner/parts/deep/thing.ts', 'src/views/apps/admin/sc-winner/'],
  ['packages/ui/src/Button.tsx', 'packages/ui/'],
  ['.claude/plans/2026-08-payments/plan.md', '.claude/plans/2026-08-payments/'],
  ['services/billing/internal/ledger.go', 'services/billing/internal/'],

  // A file sitting AT the matched level is a file, not a directory. Locking the whole of `admin/`
  // because somebody touched a loose file in it would block every module under it.
  ['src/views/apps/admin/index.ts', 'src/views/apps/admin/index.ts'],

  // Nothing configured matches: exact-file scope. The narrowest true positive, and the default.
  ['src/store/slices/user.ts', 'src/store/slices/user.ts'],
  ['scripts/one-off.mjs', 'scripts/one-off.mjs'],
  ['docs/design.md', 'docs/design.md']
]) {
  test(`scope: ${file}`, () => assert.equal(scope(file), expected))
}

for (const file of ['package.json', 'src/store/index.ts', 'CLAUDE.md', '.claude/.harness/locks.jsonl']) {
  test(`scope: ${file} is shared and never locked`, () => assert.equal(scope(file), null))
}

test('scope: a path outside the repo is not judged', () => {
  assert.equal(scope('../elsewhere/file.ts'), null)
  assert.equal(scope(''), null)
})

test('scope: no roots configured means every file is its own lock', () => {
  assert.equal(moduleRootOf('src/views/apps/admin/sc-winner/page.tsx', {}), 'src/views/apps/admin/sc-winner/page.tsx')
})

// ── Containment respects segment boundaries ────────────────────────────────────

test('overlap: a module contains its own files', () => {
  assert.ok(overlaps('packages/ui/', 'packages/ui/src/Button.tsx'))
  assert.ok(overlaps('packages/ui/', 'packages/ui'))
  assert.ok(overlaps('packages/ui/src/Button.tsx', 'packages/ui/'))
})

test('overlap: a sibling whose name merely starts the same is NOT contained', () => {
  assert.equal(overlaps('src/views/apps/admin/sc-winner/', 'src/views/apps/admin/sc-winner-extra/'), false)
  assert.equal(overlaps('packages/ui/', 'packages/ui-legacy/'), false)
  assert.equal(overlaps('src/a.ts', 'src/a.ts.bak'), false)
})

test('overlap: an exact-file lock covers that file and nothing else', () => {
  assert.ok(overlaps('src/store/slices/user.ts', 'src/store/slices/user.ts'))
  assert.equal(overlaps('src/store/slices/user.ts', 'src/store/slices/order.ts'), false)
})

// ── Staleness is a property of reading ─────────────────────────────────────────

test('TTL: a fresh lock is held, a cold one is not', () => {
  assert.ok(isHeld({ session: 's1', refreshed: ago(2) }, NOW, STALE))
  assert.ok(isHeld({ session: 's1', refreshed: ago(29) }, NOW, STALE))
  assert.equal(isHeld({ session: 's1', refreshed: ago(31) }, NOW, STALE), false)
})

test('TTL: a lock set by hand never expires — a human decision outranks the clock', () => {
  assert.ok(isHeld({ session: 'manual-jross', refreshed: ago(5000) }, NOW, STALE))
})

test('TTL: an unreadable timestamp is not evidence anybody is working', () => {
  assert.equal(isHeld({ session: 's1', refreshed: 'not-a-date' }, NOW, STALE), false)
})

test('fold: refresh carries the original claim time forward', () => {
  const held = foldLocks(
    [
      { t: ago(20), path: 'packages/ui/', session: 's1', act: 'claim' },
      { t: ago(2), path: 'packages/ui/', session: 's1', act: 'refresh' }
    ],
    { now: NOW, staleMs: STALE }
  )

  assert.equal(held.length, 1)
  assert.equal(held[0].claimed, ago(20))
  assert.equal(held[0].refreshed, ago(2))
})

test('fold: a release ends the lock, and a later claim takes it again', () => {
  const events = [
    { t: ago(20), path: 'packages/ui/', session: 's1', act: 'claim' },
    { t: ago(10), path: 'packages/ui/', session: 's1', act: 'release' }
  ]

  assert.deepEqual(foldLocks(events, { now: NOW, staleMs: STALE }), [])
  assert.equal(
    foldLocks([...events, { t: ago(1), path: 'packages/ui/', session: 's2', act: 'claim' }], { now: NOW, staleMs: STALE })[0]
      .session,
    's2'
  )
})

test('fold: one session cannot release a lock another session holds', () => {
  const held = foldLocks(
    [
      { t: ago(5), path: 'packages/ui/', session: 's1', act: 'claim' },
      { t: ago(1), path: 'packages/ui/', session: 's2', act: 'release' }
    ],
    { now: NOW, staleMs: STALE }
  )

  assert.equal(held.length, 1)
  assert.equal(held[0].session, 's1')
})

test('fold: only the stale locks drop out of a mixed log', () => {
  const held = foldLocks(
    [
      { t: ago(1), path: 'packages/ui/', session: 's1', act: 'claim' },
      { t: ago(90), path: 'packages/api/', session: 's2', act: 'claim' },
      { t: ago(400), path: 'packages/db/', session: 'manual-jross', act: 'claim' }
    ],
    { now: NOW, staleMs: STALE }
  )

  assert.deepEqual(held.map(lock => lock.path).sort(), ['packages/db/', 'packages/ui/'])
})

test('fold: a torn line is discarded rather than crashing the reader', () => {
  const events = readLockEvents('{"t":"2026-08-24T11:59:00.000Z","path":"packages/ui/","session":"s1","act":"claim"}\n{not json\n')

  assert.equal(events.length, 1)
})

// ── decide(): the ALLOW half ───────────────────────────────────────────────────

const held = (path, session, minutesAgo = 1) => ({
  path,
  session,
  claimed: ago(minutesAgo + 5),
  refreshed: ago(minutesAgo)
})

const verdict = (files, locks, extra = {}) =>
  decide({ files, locks, session: 'mine', now: NOW, roots: ROOTS, shared: SHARED, ...extra })

test('ALLOW: an unlocked module is claimed on the first write', () => {
  const result = verdict(['packages/ui/src/Button.tsx'], [])

  assert.equal(result.action, 'allow')
  assert.deepEqual(result.claims, [{ path: 'packages/ui/', act: 'claim', claimed: undefined }])
})

test('ALLOW: writing to a module I already hold refreshes it rather than claiming twice', () => {
  const result = verdict(['packages/ui/src/Button.tsx'], [held('packages/ui/', 'mine', 10)])

  assert.equal(result.action, 'allow')
  assert.equal(result.claims.length, 1)
  assert.equal(result.claims[0].act, 'refresh')
  assert.equal(result.claims[0].claimed, ago(15))
})

test('ALLOW: a shared file is neither locked nor denied, even while somebody else is in the module', () => {
  const result = verdict(['package.json', 'src/store/index.ts'], [held('packages/ui/', 'theirs')])

  assert.equal(result.action, 'allow')
  assert.deepEqual(result.claims, [])
})

test('ALLOW: a neighbouring module is not a conflict', () => {
  assert.equal(verdict(['packages/api/index.ts'], [held('packages/ui/', 'theirs')]).action, 'allow')
})

test('ALLOW: a sibling whose name starts the same is not a conflict', () => {
  const locks = [held('src/views/apps/admin/sc-winner/', 'theirs')]

  assert.equal(verdict(['src/views/apps/admin/sc-winner-extra/page.tsx'], locks).action, 'allow')
})

test('ALLOW: a lock that went cold is simply not there any more', () => {
  const stale = { path: 'packages/ui/', session: 'theirs', claimed: ago(200), refreshed: ago(100) }

  // The guard reads through readLocks, which folds staleness out. decide() is given what is HELD.
  assert.equal(isHeld(stale, NOW, STALE), false)
  assert.equal(verdict(['packages/ui/src/Button.tsx'], []).action, 'allow')
})

test('ALLOW: several files in one module produce ONE claim, not one per file', () => {
  const result = verdict(['packages/ui/a.ts', 'packages/ui/b.ts', 'packages/ui/c.ts'], [])

  assert.deepEqual(result.claims.map(claim => claim.path), ['packages/ui/'])
})

test('ALLOW: my own exact-file lock does not block my next write to the same file', () => {
  const locks = [held('src/store/slices/user.ts', 'mine')]

  assert.equal(verdict(['src/store/slices/user.ts'], locks).action, 'allow')
})

test('ALLOW: nothing to write is nothing to judge', () => {
  assert.equal(verdict([], []).action, 'allow')
  assert.equal(verdict([], []).code, 'exempt')
})

// ── decide(): the DENY half ────────────────────────────────────────────────────

test('DENY: a write into a module another session holds', () => {
  const result = verdict(['packages/ui/src/Button.tsx'], [held('packages/ui/', 'theirs')])

  assert.equal(result.action, 'deny')
  assert.equal(result.conflict.session, 'theirs')
  assert.match(result.reason, /AGENT LOCK/)
  assert.match(result.reason, /packages\/ui\//)
})

test('DENY: a foreign lock on ONE FILE blocks the module claim that would swallow it', () => {
  const result = verdict(['packages/ui/src/Button.tsx'], [held('packages/ui/src/Other.tsx', 'theirs')])

  assert.equal(result.action, 'deny')
})

test('DENY: the message names the owner and how long they have held it, and does NOT say how to clear it', () => {
  const reason = verdict(['packages/ui/a.ts'], [held('packages/ui/', 'theirs', 4)]).reason

  assert.match(reason, /theirs/)
  assert.match(reason, /held 9 min/)
  assert.match(reason, /last write 4 min ago/)
  assert.match(reason, /git show HEAD:/)

  // A deny that names its own escape hatch is a deny the model clears instead of obeying.
  assert.doesNotMatch(reason, /--release|AGENT_LOCKS_DISABLE|maxBlocks|override/i)
})

test('DENY: a manual lock is named as one, so the reader knows a person put it there', () => {
  const reason = verdict(['packages/ui/a.ts'], [held('packages/ui/', 'manual-jross')]).reason

  assert.match(reason, /set by hand/)
})

// ── Bounded blocking ───────────────────────────────────────────────────────────

test('BOUNDED: after maxBlocks the guard stands aside — there is no state it can trap a session in', () => {
  const locks = [held('packages/ui/', 'theirs')]

  assert.equal(verdict(['packages/ui/a.ts'], locks, { blocked: 1, maxBlocks: 2 }).action, 'deny')

  const exhausted = verdict(['packages/ui/a.ts'], locks, { blocked: 2, maxBlocks: 2 })

  assert.equal(exhausted.action, 'stand-aside')

  // It does NOT claim on the way through. The other session still owns the module, and a second claim
  // would make the record say something untrue.
  assert.deepEqual(exhausted.claims, [])
})

// ── End to end: the real scripts, the real installer, real payloads ────────────
//
// Everything above can pass while the hook is completely inert. These drive the actual guard as a
// subprocess against a repo the actual installer built.

const withRepo = fn => {
  const repo = makeRepo({
    config: {
      commands: { verify: 'node -e "process.exit(0)"' },
      locks: { enabled: true, roots: ROOTS, shared: SHARED, maxBlocks: 2 }
    }
  })

  try {
    fn(repo)
  } finally {
    repo.cleanup()
  }
}

const write = ({ file, session, tool = 'Edit' }) => ({
  hook_event_name: 'PreToolUse',
  session_id: session,
  prompt_id: 't1',
  tool_name: tool,
  tool_input: { file_path: file }
})

const locksOf = repo => readLockEvents(repo.read('.claude/.harness/locks.jsonl'))

test('e2e ALLOW: an unlocked write is silent and claims the module', () => {
  withRepo(repo => {
    const out = runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/a.ts', session: 's1' }))

    assert.equal(out, null, 'an allowed write must say nothing')

    const events = locksOf(repo)

    assert.equal(events.length, 1)
    assert.equal(events[0].path, 'packages/ui/')
    assert.equal(events[0].session, 's1')
    assert.equal(events[0].act, 'claim')
  })
})

// SCRIPT NAMES NEST. `guard-agent-locks.mjs` ends with `agent-locks.mjs`, so the `endsWith` idiom used
// everywhere else in this harness made the guard run the library's CLI on import — printing `no active
// locks` and exiting 0 before it ever read its payload. It looked exactly like a guard with nothing to
// do. Reverting agent-locks.mjs to `endsWith` turns this red.
test('e2e: importing the library does not run its CLI', () => {
  withRepo(repo => {
    const output = execFileSync('node', [repo.path('.claude/harness/guard-agent-locks.mjs')], {
      input: JSON.stringify(write({ file: 'packages/ui/a.ts', session: 's1' })),
      cwd: repo.root,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_HOOK_TEST: '1' }
    })

    assert.doesNotMatch(output, /no active locks/)
    assert.equal(locksOf(repo).length, 1, 'the guard must reach its own decision, not the CLI')
  })
})

test('e2e DENY: a second session is refused, and told who owns it', () => {
  withRepo(repo => {
    runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/a.ts', session: 's1' }))

    const out = runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/b.ts', session: 's2' }))

    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /AGENT LOCK/)
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /s1/)
  })
})

test('e2e ALLOW: the owner keeps writing, and the claim time is preserved across refreshes', () => {
  withRepo(repo => {
    runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/a.ts', session: 's1' }))
    assert.equal(runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/b.ts', session: 's1' })), null)

    const events = locksOf(repo)

    assert.equal(events.length, 2)
    assert.equal(events[1].act, 'refresh')
    assert.equal(events[1].claimed, events[0].t, 'a refresh carries the original claim time')
  })
})

test('e2e ALLOW: a shared file is written by both sessions and locks nothing', () => {
  withRepo(repo => {
    assert.equal(runHook(repo, 'guard-agent-locks.mjs', write({ file: 'package.json', session: 's1' })), null)
    assert.equal(runHook(repo, 'guard-agent-locks.mjs', write({ file: 'package.json', session: 's2' })), null)
    assert.equal(repo.read('.claude/.harness/locks.jsonl'), '')
  })
})

test('e2e ALLOW: a non-write tool passes through even though the matcher would not send it', () => {
  withRepo(repo => {
    const payload = { ...write({ file: 'packages/ui/a.ts', session: 's1' }), tool_name: 'Bash' }

    assert.equal(runHook(repo, 'guard-agent-locks.mjs', payload), null)
    assert.equal(repo.read('.claude/.harness/locks.jsonl'), '', 'a Bash payload must not take a lock')
  })
})

test('e2e ALLOW: the kill switch silences everything', () => {
  withRepo(repo => {
    runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/a.ts', session: 's1' }))

    const out = runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/b.ts', session: 's2' }), {
      env: { AGENT_LOCKS_DISABLE: '1' }
    })

    assert.equal(out, null)
  })
})

test('e2e ALLOW: locks.enabled false leaves the guard registered and standing aside', () => {
  const repo = makeRepo({ config: { commands: { verify: 'true' }, locks: { enabled: false, roots: ROOTS } } })

  try {
    runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/a.ts', session: 's1' }))

    const out = runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/b.ts', session: 's2' }))

    assert.equal(out, null)
    assert.equal(repo.read('.claude/.harness/locks.jsonl'), '')
  } finally {
    repo.cleanup()
  }
})

test('e2e BOUNDED: the third refusal stands aside instead of trapping the session', () => {
  withRepo(repo => {
    runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/a.ts', session: 's1' }))

    const attempt = () => runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/b.ts', session: 's2' }))

    assert.ok(attempt(), 'first is denied')
    assert.ok(attempt(), 'second is denied')
    assert.equal(attempt(), null, 'the third stands aside')
  })
})

test('e2e: release gives the module back, and says so once', () => {
  withRepo(repo => {
    runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/a.ts', session: 's1' }))

    const out = runHook(repo, 'release-agent-locks.mjs', { hook_event_name: 'Stop', session_id: 's1' })

    assert.match(out.systemMessage, /packages\/ui\//)

    // And now the other session can take it.
    assert.equal(runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/b.ts', session: 's2' })), null)

    // Silent when there was nothing to release.
    assert.equal(runHook(repo, 'release-agent-locks.mjs', { hook_event_name: 'Stop', session_id: 's3' }), null)
  })
})

test('e2e: a stale lock is not in the way, without anybody sweeping it', () => {
  withRepo(repo => {
    const cold = {
      t: new Date(Date.now() - 90 * MINUTE).toISOString(),
      path: 'packages/ui/',
      session: 'abandoned',
      act: 'claim'
    }

    runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/api/x.ts', session: 'seed' }))

    // Written directly, because the point is that no process had to run for this to expire.
    const path = repo.path('.claude/.harness/locks.jsonl')

    appendFileSync(path, `${JSON.stringify(cold)}\n`)

    assert.equal(runHook(repo, 'guard-agent-locks.mjs', write({ file: 'packages/ui/a.ts', session: 'fresh' })), null)
  })
})
