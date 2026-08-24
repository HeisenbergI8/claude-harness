#!/usr/bin/env node
// Agent locks: which Claude Code session currently owns which part of the tree.
//
// Two sessions in the same checkout — a second terminal, a second editor window, a cloud run — are
// independent models with no visibility into each other. The failure is not a merge conflict, which git
// would tell you about. It is silent:
//
//   Session B has uncommitted work in progress. Session A reads those files, sees nothing marking them
//   as anyone's, and edits them. Or A runs the fast check, sees B's half-finished module go red, and
//   sets about "fixing" it — because from inside A, a red check is indistinguishable from a defect.
//
// Nothing in Claude Code lets one session say "I am working here". This is that, as a record any other
// session's guard can read.
//
// ── THIS FILE OWNS THE FORMAT ──────────────────────────────────────────────────
//
// The guard, the release hook and the CLI all import from here. None of them parses the log itself.
// The worst bug class in a harness is a reader looking for a field the writer never emits: it fails
// silently, stays green, and the gate is dead for weeks. One place a field name can change, and it is
// the file that writes it.
//
// ── APPEND-ONLY, BECAUSE THE WHOLE POINT IS CONCURRENCY ────────────────────────
//
// The obvious implementation is a lock table read, modified and written back. It cannot be right here.
// This mechanism exists precisely because several processes are writing at once, so read-modify-write
// means the slower writer discards the faster one's claim — and a dropped claim produces exactly the
// stomp the lock was taken to prevent, silently, in the direction that fails open.
//
// So: one appended line per claim, refresh or release, and the current lock table is a FOLD over that
// log. POSIX append is atomic below PIPE_BUF and every line here is far under it.
//
// The fold is also what makes staleness free. An abandoned session's lock is not swept by anybody — it
// simply stops being held once nothing has refreshed it inside `locks.staleMs`, which is a property of
// reading rather than an operation somebody has to remember to run. There is no cleanup cron, no
// dependence on a `Stop` hook firing, and a crashed session costs nothing.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'

import { globToRegExp, load } from './config.mjs'

// A session id a person typed in by hand. Human decisions outrank the TTL: if somebody wrote the lock
// down themselves, they meant it, and it stays until they remove it.
export const MANUAL_PREFIX = 'manual-'

export const isManual = session => String(session ?? '').startsWith(MANUAL_PREFIX)

// ── The reader ─────────────────────────────────────────────────────────────────

const parseLine = line => {
  try {
    return JSON.parse(line)
  } catch {
    /* a torn line is discarded rather than crashing the hook */
    return null
  }
}

export const readLockEvents = text => (text ?? '').split('\n').filter(Boolean).map(parseLine).filter(Boolean)

export const readLockFile = config => {
  try {
    return readFileSync(config.statePaths.locks, 'utf8')
  } catch {
    return ''
  }
}

// ── The fold ───────────────────────────────────────────────────────────────────
//
// Last event per path wins. `claimed` is carried forward across refreshes so the report can say how long
// a session has held something, which is the one number that tells a person whether to wait or to go and
// ask. A release only counts from the session that holds the lock — a stale release line from a session
// that has since lost the path must not unlock somebody else's active work.
export const foldLocks = (events, { now = Date.now(), staleMs } = {}) => {
  const held = new Map()

  for (const event of events) {
    if (!event?.path || !event?.session || !event?.t) continue
    if (!Number.isFinite(Date.parse(event.t))) continue

    const current = held.get(event.path)

    if (event.act === 'release') {
      if (!current || current.session === event.session) held.delete(event.path)
      continue
    }

    held.set(event.path, {
      path: event.path,
      session: event.session,
      claimed: event.claimed ?? (current && current.session === event.session ? current.claimed : event.t),
      refreshed: event.t
    })
  }

  return [...held.values()].filter(lock => isHeld(lock, now, staleMs))
}

export const isHeld = (lock, now, staleMs) => {
  if (isManual(lock.session)) return true

  const age = now - Date.parse(lock.refreshed)

  // NOT `age <= staleMs` on an unparseable date: a lock whose timestamp cannot be read is not evidence
  // that anybody is working, and treating unknown as held is how one bad line blocks a repo forever.
  return Number.isFinite(age) && age <= staleMs
}

export const readLocks = (config, now = Date.now()) =>
  foldLocks(readLockEvents(readLockFile(config)), { now, staleMs: config.locks?.staleMs ?? 30 * 60 * 1000 })

// ── Scope ──────────────────────────────────────────────────────────────────────
//
// A lock path is either a directory (trailing `/`) or an exact file. Two scopes overlap when one
// contains the other, and containment respects SEGMENT boundaries in both directions — without that,
// a lock on `src/mod` blocks every write to `src/mod-legacy`, which is a false refusal on unrelated
// work and the fastest way to get this switched off.
const contains = (outer, inner) => {
  const prefix = outer.endsWith('/') ? outer : `${outer}/`

  return inner === outer || inner === outer.replace(/\/$/, '') || inner.startsWith(prefix)
}

export const overlaps = (a, b) => contains(a, b) || contains(b, a)

// ── moduleRootOf: which scope a file belongs to ────────────────────────────────
//
// THE HIGHEST-RISK FUNCTION HERE, and the one that has to be configured rather than guessed. A bug in
// it produces false refusals, which is the failure this mechanism cannot survive.
//
// `locks.roots` are segment patterns naming the level at which your project's work divides — the module
// boundary. `src/views/apps/admin/*` means "one lock per directory under admin", so a rename touching
// nine files in one module takes one lock instead of nine. Each pattern segment matches one path
// segment and may contain `*`.
//
// WITH NO ROOTS CONFIGURED THIS RETURNS THE FILE ITSELF, deliberately. Exact-file scope is the narrowest
// possible true positive: two sessions editing the same file is a conflict in every project, in a way
// that "two sessions editing the same directory" is not. The generic default therefore cannot fire on
// work that was fine, and widening it to your module grain is an explicit act.
//
// Returns null for a file in `locks.shared` — see below.
export const moduleRootOf = (rel, { roots = [], shared = [] } = {}) => {
  if (typeof rel !== 'string' || !rel || rel.startsWith('..')) return null
  if (shared.some(pattern => globToRegExp(pattern).test(rel))) return null

  const parts = rel.split('/')

  for (const pattern of roots) {
    const segments = String(pattern).replace(/\/+$/, '').split('/')

    if (segments.length > parts.length) continue
    if (!segments.every((segment, index) => globToRegExp(segment).test(parts[index]))) continue

    const matched = parts.slice(0, segments.length).join('/')

    // A file sitting AT the matched level is locked as a file; anything deeper locks the directory.
    return segments.length === parts.length ? matched : `${matched}/`
  }

  return rel
}

export const relativeTo = (root, filePath) => relative(root, resolve(root, filePath)).split(sep).join('/')

// ── The decision, as a pure function ───────────────────────────────────────────
//
// No filesystem, no payload, no clock of its own. Returns the verdict and the lock events the caller
// should append — so the ALLOW half, which is the half that decides whether anyone keeps this switched
// on, is testable without spawning anything.
//
// `blocked` is the count of consecutive denials already issued in this scope. Past `maxBlocks` the guard
// stands aside: the model has been told, and a gate with no state from which the session can proceed is
// a gate that gets disabled. The lock is NOT claimed on the way through — the other session still owns
// it, and inventing a second claim would only make the record wrong.
export const decide = ({
  files = [],
  locks = [],
  session = '',
  now = Date.now(),
  roots = [],
  shared = [],
  blocked = 0,
  maxBlocks = 2
}) => {
  const claims = []

  for (const rel of files) {
    const root = moduleRootOf(rel, { roots, shared })

    if (!root) continue

    const conflict = locks.find(lock => lock.session !== session && overlaps(lock.path, root))

    if (conflict) {
      if (blocked >= maxBlocks) return { action: 'stand-aside', code: 'bounded', conflict, claims: [] }

      return { action: 'deny', code: 'foreign-lock', conflict, reason: denyReason(conflict, rel, now), claims: [] }
    }

    if (claims.some(claim => claim.path === root)) continue

    const own = locks.find(lock => lock.session === session && lock.path === root)

    claims.push({ path: root, act: own ? 'refresh' : 'claim', claimed: own?.claimed })
  }

  return { action: 'allow', code: claims.length ? 'owned' : 'exempt', claims }
}

const minutes = ms => Math.max(0, Math.round(ms / 60_000))

// ── THE DENY DOES NOT EXPLAIN HOW TO REMOVE THE LOCK ───────────────────────────
//
// The first draft of this message ended with `run --release-all to override`. The model has Bash. A deny
// that names its own escape hatch is a deny that gets cleared rather than obeyed, and then the mechanism
// is decoration with a state file attached.
//
// The escape hatch is real and documented — `locks.maxBlocks`, `AGENT_LOCKS_DISABLE=1`, and the CLI in
// this file — it is simply documented where a PERSON reads it. What the model is told is the true thing:
// somebody else is working here, stop and say so.
export const denyReason = (conflict, rel, now) => {
  const owner = isManual(conflict.session) ? `${conflict.session} (a lock set by hand)` : `session ${conflict.session}`
  const age = minutes(now - Date.parse(conflict.claimed))
  const idle = minutes(now - Date.parse(conflict.refreshed))

  return (
    `AGENT LOCK: ${rel} is inside ${conflict.path}, which is owned by ${owner} — ` +
    `held ${age} min, last write ${idle} min ago.\n\n` +
    `Another Claude Code session is working in this module right now. Its files on disk are somebody ` +
    `else's work in progress, not a mistake to correct.\n\n` +
    `Do not edit here, and do not repair failures coming from here — a red check in code you do not own ` +
    `is evidence about the tree, not a defect. To establish whether a failure is yours, compare against ` +
    `the committed version rather than stashing: \`git show HEAD:<path> | diff - <path>\`.\n\n` +
    `Tell the user which module is locked and what you wanted to change, then stop. They can see both ` +
    `sessions; you cannot.`
  )
}

// ── The writer ─────────────────────────────────────────────────────────────────

export const appendLockEvents = (config, events) => {
  if (!events.length) return

  mkdirSync(dirname(config.statePaths.locks), { recursive: true })
  appendFileSync(config.statePaths.locks, events.map(event => JSON.stringify(event)).join('\n') + '\n')
}

export const claimEvents = (claims, session, now = new Date().toISOString()) =>
  claims.map(claim => ({ t: now, path: claim.path, session, act: claim.act, ...(claim.claimed ? { claimed: claim.claimed } : {}) }))

const COMPACT_AT_LINES = 300

// Rewrites the log as one line per lock still held. Safe to lose: the result is the same fold.
//
// ONLY THE MAIN THREAD COMPACTS, for the same reason the ledger does — a rewrite is the one operation
// here that is not append-atomic, and the main thread is never concurrent with itself. A subagent
// appends and never rewrites. Between compactions the file grows by one short line per write, which
// costs nothing.
export const compactLocks = (config, now = Date.now()) => {
  if (process.env.CLAUDE_AGENT_TYPE) return

  let lines

  try {
    lines = readFileSync(config.statePaths.locks, 'utf8').split('\n').filter(Boolean)
  } catch {
    return
  }

  if (lines.length < COMPACT_AT_LINES) return

  const held = readLocks(config, now)

  writeFileSync(
    config.statePaths.locks,
    held.map(lock => JSON.stringify({ t: lock.refreshed, path: lock.path, session: lock.session, act: 'claim', claimed: lock.claimed })).join('\n') +
      (held.length ? '\n' : '')
  )
}

export const releaseFor = (config, session, now = Date.now()) => {
  const mine = readLocks(config, now).filter(lock => lock.session === session)

  if (mine.length) {
    appendLockEvents(
      config,
      mine.map(lock => ({ t: new Date(now).toISOString(), path: lock.path, session, act: 'release' }))
    )
  }

  return mine
}

// ── CLI ────────────────────────────────────────────────────────────────────────
//
// For the person, not the model. Everything that removes a lock lives here rather than in the deny
// message the model reads.
//
//   node .claude/harness/agent-locks.mjs                       what is held right now
//   node .claude/harness/agent-locks.mjs --claim src/thing/     take a lock by hand, no expiry
//   node .claude/harness/agent-locks.mjs --release src/thing/   give one back
//   node .claude/harness/agent-locks.mjs --release-all          clear everything
const main = () => {
  const config = load()
  const now = Date.now()
  const argv = process.argv.slice(2)
  const flag = name => {
    const index = argv.indexOf(name)

    return index === -1 ? null : (argv[index + 1] ?? '')
  }

  const manual = `${MANUAL_PREFIX}${process.env.USER || process.env.USERNAME || 'user'}`

  if (argv.includes('--claim')) {
    const path = flag('--claim')

    if (!path) {
      console.error('--claim needs a repo-relative path. A directory should end with `/`.')
      process.exit(1)
    }

    appendLockEvents(config, [{ t: new Date(now).toISOString(), path, session: manual, act: 'claim' }])
    console.log(`claimed ${path} as ${manual} — held until you release it, TTL does not apply to a manual lock`)
    process.exit(0)
  }

  if (argv.includes('--release')) {
    const path = flag('--release')
    const lock = readLocks(config, now).find(entry => entry.path === path)

    if (!lock) {
      console.log(`no active lock on ${path}`)
      process.exit(0)
    }

    appendLockEvents(config, [{ t: new Date(now).toISOString(), path, session: lock.session, act: 'release' }])
    console.log(`released ${path}`)
    process.exit(0)
  }

  if (argv.includes('--release-all')) {
    const held = readLocks(config, now)

    appendLockEvents(
      config,
      held.map(lock => ({ t: new Date(now).toISOString(), path: lock.path, session: lock.session, act: 'release' }))
    )
    console.log(`released ${held.length} lock(s)`)
    process.exit(0)
  }

  const held = readLocks(config, now)

  if (!config.locks?.enabled) console.log('locks.enabled is false — the guard is registered but standing aside.\n')

  if (!held.length) {
    console.log('no active locks')
    process.exit(0)
  }

  for (const lock of held) {
    console.log(
      `${lock.path.padEnd(44)} ${lock.session.padEnd(38)} held ${minutes(now - Date.parse(lock.claimed))}m` +
        `, last write ${minutes(now - Date.parse(lock.refreshed))}m ago`
    )
  }

  process.exit(0)
}

// ── basename, NOT endsWith ─────────────────────────────────────────────────────
//
// SCRIPT NAMES NEST HERE. `guard-agent-locks.mjs` and `release-agent-locks.mjs` both END WITH
// `agent-locks.mjs`, so the `endsWith` idiom used everywhere else in this harness makes both of them
// run this file's CLI the moment they import it — printing `no active locks` and calling process.exit(0)
// before the guard has read its payload. The guard then looks like it fired and did nothing, which is
// the exact state the heartbeat exists to make visible and the hardest kind of dead gate to notice.
if (basename(process.argv[1] ?? '') === 'agent-locks.mjs') main()
