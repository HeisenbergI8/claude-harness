#!/usr/bin/env node
// Records that a hook FIRED, and what its payload actually carried.
//
// Two jobs, both answering questions a harness otherwise has to guess at.
//
// 1. LIVENESS. The worst failure mode in a hook-based system is a hook that is configured and silently
//    does not fire. Nothing detects it on its own: a guard that never runs looks exactly like a guard
//    with nothing to do. Comparing the hooks REGISTERED in settings.json against the hooks that have
//    EVER fired turns that silence into an alarm. The harness this was extracted from lost a week to
//    per-agent `hooks:` frontmatter that was schema-valid and completely inert.
//
// 2. PAYLOAD SHAPE. Hook payload fields are not guaranteed across versions, and a gate built on a field
//    that does not exist is dead on arrival while looking healthy. This records the KEY NAMES seen per
//    event — never the values, which would put assistant message text on disk — so "does this payload
//    carry `last_assistant_message`?" is answered by evidence rather than by belief.
//
// Called by other hooks, never registered directly. Writes only; it can never block anything.
//
// ── APPEND-ONLY, AND THAT IS THE WHOLE DESIGN ──────────────────────────────────
//
// The natural implementation is a read-modify-write over one JSON object: read, increment, write back.
// It is also wrong. Several hooks are registered on `Stop` and every one of them beats, so N processes
// read the same file and the slowest write silently discards the others' increments.
//
// The damage is not a wrong count. The CLI below reports `registered but never fired` — so a hook whose
// beats were lost is reported as DEAD, and a false alarm is how an alarm gets ignored. It also makes
// this file useless as evidence about payload shape, which is the one question it exists to answer.
//
// So: one appended line per beat, which POSIX guarantees atomic below PIPE_BUF, and every line here is
// far under it. The `.json` view is still written, but as a DERIVED fold of the JSONL — readers keep
// the shape they expect and the source of truth cannot lose data.
//
// The view write is racy and deliberately left so. Two processes can fold and write it out of order,
// leaving it stale by one event until the next beat regenerates it from the complete log. A derived
// file that self-heals is a different class of problem from a source of truth that loses data.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { load } from './config.mjs'

// Folded back to one snapshot line per hook once the log passes this, so it cannot grow without bound.
// Snapshot lines carry `fired`, so compaction PRESERVES the running total rather than resetting it — a
// count that silently restarts looks exactly like a hook that stopped firing.
const COMPACT_AT = 2000

// ── The fold ───────────────────────────────────────────────────────────────────
//
// Exported and pure so the tests can assert it without touching disk. A line with a numeric `fired` is
// a compaction snapshot and contributes that many; every other line contributes one.
export const foldBeats = (text = '') => {
  const hooks = {}

  for (const line of text.split('\n')) {
    if (!line) continue

    let event

    try {
      event = JSON.parse(line)
    } catch {
      continue // a torn line is skipped rather than crashing every hook that beats
    }

    if (!event?.n) continue

    const entry = (hooks[event.n] ??= { fired: 0, keys: [] })

    entry.fired += typeof event.fired === 'number' ? event.fired : 1

    if (event.t) entry.last = event.t
    if (event.ev) entry.event = event.ev

    for (const key of event.k ?? []) {
      if (!entry.keys.includes(key)) entry.keys.push(key)
    }
  }

  return { hooks }
}

const readLog = path => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

// COMPACTION IS THE ONE RACY OPERATION LEFT, so only the main thread performs it. Agents append and
// never rewrite, and the main thread is never concurrent with itself, so the rewrite has a single
// writer by construction.
const compact = (paths, folded) => {
  if (process.env.CLAUDE_AGENT_TYPE) return

  const lines = readLog(paths.heartbeatLog).split('\n').filter(Boolean)

  if (lines.length < COMPACT_AT) return

  const snapshot = Object.entries(folded.hooks).map(([name, entry]) =>
    JSON.stringify({ n: name, fired: entry.fired, t: entry.last, ev: entry.event, k: entry.keys })
  )

  writeFileSync(paths.heartbeatLog, `${snapshot.join('\n')}\n`)
}

export const beat = (name, payload, config = load()) => {
  // A hook driven by its own test suite must not register as ALIVE. Liveness here means "fired for a
  // real event", and a test harness calling a hook eight times would mark the newest, least-proven gate
  // as healthy on the strength of nothing. That inverts the one signal this file exists to give.
  if (process.env.CLAUDE_HOOK_TEST === '1') return
  if (config.gates?.heartbeat?.enabled === false) return

  try {
    const paths = config.statePaths

    mkdirSync(dirname(paths.heartbeatLog), { recursive: true })

    // Key names only. Values are never recorded — a payload can contain the whole assistant message.
    appendFileSync(
      paths.heartbeatLog,
      `${JSON.stringify({
        n: name,
        t: new Date().toISOString(),
        ev: payload?.hook_event_name ?? 'unknown',
        k: Object.keys(payload ?? {})
      })}\n`
    )

    const folded = foldBeats(readLog(paths.heartbeatLog))

    writeFileSync(paths.heartbeatView, `${JSON.stringify(folded, null, 2)}\n`)
    compact(paths, folded)
  } catch {
    // A heartbeat must never be the reason a hook fails.
  }
}

// ── Registered-vs-fired ────────────────────────────────────────────────────────
//
// Pure, exported, and tested. `registered` comes from settings.json; `seen` from the fold. Only hooks
// that actually call beat() can be reported on, so `instrumented` keeps the report honest: an absence
// outside that list is not evidence of death.
export const readRegisteredHooks = settings => {
  const registered = []

  for (const [event, matchers] of Object.entries(settings?.hooks ?? {})) {
    for (const matcher of matchers ?? []) {
      for (const hook of matcher.hooks ?? []) {
        const fromArgs = (hook.args ?? []).find(arg => typeof arg === 'string' && arg.endsWith('.mjs'))
        const fromCommand = typeof hook.command === 'string' ? hook.command.match(/([\w./-]+\.mjs)/)?.[1] : null
        const script = fromArgs ?? fromCommand

        if (script) registered.push({ event, name: script.split(/[\\/]/).pop().replace('.mjs', '') })
      }
    }
  }

  return registered
}

export const silentHooks = (registered, seen, instrumented) =>
  registered.filter(hook => instrumented.includes(hook.name) && !seen[hook.name])

// Hooks in this harness that call beat(). Anything registered but not listed here is simply not
// instrumented, and saying so is what stops the report overclaiming.
//
// The GUARDS are deliberately absent. They fire only when their tool is used, so "never fired" is the
// normal state for a session that wrote no files or ran no shell commands — reporting that as death
// would be a false alarm on every quiet session, and a false alarm is how an alarm gets ignored.
export const INSTRUMENTED = [
  'claim-check',
  'verify-gate',
  'loop-breaker',
  'record-activity',
  'review-gate',
  'task-driver',
  // Beats BEFORE it reads its own config, so a project that has not declared `commands.editCheck`
  // still shows a live hook rather than a dead one. "Registered but disabled" and "registered but
  // broken" must not look the same here.
  'gate-edit-check',
  // Same reasoning: beats BEFORE reading `locks.enabled`, so a repo that has not switched agent locks on
  // still shows a live hook. "Registered but off" must not look like "registered but broken".
  'guard-agent-locks'
]

// ── CLI ────────────────────────────────────────────────────────────────────────

const report = (config = load()) => {
  const lines = []
  const seen = foldBeats(readLog(config.statePaths.heartbeatLog)).hooks

  let settings = null

  try {
    settings = JSON.parse(readFileSync(join(config.root ?? process.cwd(), '.claude/settings.json'), 'utf8'))
  } catch {
    lines.push('  heartbeat: .claude/settings.json unreadable — cannot check registration')
  }

  for (const [name, entry] of Object.entries(seen)) {
    lines.push(`  ${name}: fired ${entry.fired}x on ${entry.event}, last ${entry.last}`)
    lines.push(`      payload keys: ${entry.keys.join(', ')}`)
  }

  if (settings) {
    const silent = silentHooks(readRegisteredHooks(settings), seen, INSTRUMENTED)

    if (silent.length) {
      lines.push(`  WARN  registered but never fired: ${[...new Set(silent.map(hook => hook.name))].join(', ')}`)
      lines.push('        "configured" and "firing" are different states — probe before relying on it.')
    }
  }

  if (!Object.keys(seen).length) lines.push('  heartbeat: nothing recorded yet — run a turn first')

  return lines.join('\n')
}

if (process.argv[1]?.endsWith('hook-heartbeat.mjs')) {
  const config = load()

  if (process.argv.includes('--reset')) {
    try {
      if (existsSync(config.statePaths.heartbeatLog)) writeFileSync(config.statePaths.heartbeatLog, '')
      if (existsSync(config.statePaths.heartbeatView)) writeFileSync(config.statePaths.heartbeatView, '{"hooks":{}}\n')
      console.log('  heartbeat: reset')
    } catch (error) {
      console.log(`  heartbeat: reset failed — ${error.message}`)
    }

    process.exit(0)
  }

  console.log(report(config))
}
