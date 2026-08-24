#!/usr/bin/env node
// PreToolUse guard on Write/Edit: refuses a write into a scope another Claude Code session is holding,
// and takes the lock for this session on the way past.
//
// See agent-locks.mjs for the record this reads and why it is an append-only log. This file is the
// decision.
//
// ── OFF UNTIL YOU TURN IT ON ───────────────────────────────────────────────────
//
// `locks.enabled` defaults to false. This is the promotion ladder in docs/design.md applied to the
// gate's own shipping: a check wired to block on day one fires on a legitimate action in week one and
// is deleted in week two. It is also honestly scoped — a repo where only one session ever runs gets
// nothing from this but a chance to be wrong, and a repo that gives each session its own `git worktree`
// has solved the problem completely and better.
//
// ── AUTO-CLAIM, NOT EXPLICIT CLAIM ─────────────────────────────────────────────
//
// Requiring the model to declare a lock loses at exactly the moment it matters — under pressure, mid
// refactor, which is when it forgets. Claiming on first write is invisible when nothing goes wrong and
// load-bearing when it does.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────────
//
// Nothing here is a mutex. Two sessions writing the same shared file at the same instant is a git merge
// problem and locks do not help. This narrows one specific failure: a session editing a module while
// another session has work in progress there, and neither can see the other.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import { deny, load, readPayload, scopeKey } from './config.mjs'
import { appendLockEvents, claimEvents, compactLocks, decide, readLocks, relativeTo } from './agent-locks.mjs'
import { beat } from './hook-heartbeat.mjs'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// Every path a write-family call can name. `notebook_path` is the NotebookEdit spelling, and a guard
// reading only `file_path` is silently inert on notebooks.
export const filesFrom = payload =>
  [payload?.tool_input?.file_path, payload?.tool_input?.notebook_path].filter(value => typeof value === 'string' && value)

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const writeState = (path, state) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state)}\n`)
  } catch {
    /* a counter that cannot be written costs one extra block, not a crashed turn */
  }
}

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const config = load()

  beat('guard-agent-locks', payload, config)

  // The kill switch is an environment variable on purpose. When this mechanism is the thing going
  // wrong, one shell command away is the right distance; a config file to edit is another file that can
  // be half-written while you are trying to get unstuck.
  if (process.env.AGENT_LOCKS_DISABLE === '1') process.exit(0)
  if (config.locks?.enabled !== true) process.exit(0)
  if (config.errors.length) process.exit(0)

  // RE-CHECKED IN THE SCRIPT. The `matcher` in settings.json is a declarative hint, not a contract, and
  // a guard that trusts it will one day run against a Bash payload and read `tool_input.command` as a
  // file path.
  if (!WRITE_TOOLS.has(payload.tool_name)) process.exit(0)

  // No session id means no way to tell whose write this is. Every path would look foreign, so every
  // write would be denied — stand aside instead.
  const session = payload.session_id ?? process.env.CLAUDE_SESSION_ID

  if (!session) process.exit(0)

  const root = config.root ?? process.cwd()
  const files = filesFrom(payload)
    .map(file => relativeTo(root, file))
    // Outside the repo is guard-write's job, and locks are per-checkout. Judging a path this record
    // cannot describe would be inventing a verdict.
    .filter(rel => rel && !rel.startsWith('..'))

  if (!files.length) process.exit(0)

  const now = Date.now()
  const statePath = config.statePaths.lockState
  const state = readJson(statePath, {})
  const key = scopeKey(payload)

  const verdict = decide({
    files,
    locks: readLocks(config, now),
    session,
    now,
    roots: config.locks?.roots ?? [],
    shared: config.locks?.shared ?? [],
    blocked: state[key] ?? 0,
    maxBlocks: config.locks?.maxBlocks ?? 2
  })

  if (process.argv.includes('--status')) {
    console.log(JSON.stringify({ session, files, verdict }, null, 2))
    process.exit(0)
  }

  if (verdict.action === 'deny') {
    state[key] = (state[key] ?? 0) + 1
    writeState(statePath, state)
    deny(verdict.reason)
  }

  // A write that got through ends the streak. Counting consecutive denials rather than total ones is
  // what stops an unrelated conflict an hour later from arriving pre-exhausted.
  if (state[key]) {
    delete state[key]
    writeState(statePath, state)
  }

  if (verdict.claims.length) {
    appendLockEvents(config, claimEvents(verdict.claims, session, new Date(now).toISOString()))
    compactLocks(config, now)
  }

  process.exit(0)
}

// EVERY failure here exits 0. This guard sits on the write path of every session in the repo; a bug in
// it that threw would take the whole session with it, and a mechanism that can trap a session is one
// people switch off entirely rather than debug.
if (basename(process.argv[1] ?? '') === 'guard-agent-locks.mjs') {
  main().catch(error => {
    console.error(`guard-agent-locks: ${error?.message ?? error}`)
    process.exit(0)
  })
}
