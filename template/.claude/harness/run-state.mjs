#!/usr/bin/env node
// Run state for the task loop — the thing that makes iteration N+1 differ from N.
//
// Every turn otherwise starts blind: the activity ledger keys on `prompt_id`, and each iteration is a
// new one, so nothing an iteration learns survives the turn ending. A loop built on that repeats itself
// verbatim.
//
// STATE LIVES IN FILES, NEVER IN CONTEXT. That is what makes the loop resumable, inspectable, and
// independent of whether the model remembers anything.
//
//   <state>/runs/current.json      pointer: { runId, sessionId, lastBeatAt }
//   <state>/runs/<id>/state.json   the run record
//   <state>/runs/<id>/attempts.jsonl  what was tried, append-only
//
// Nothing here blocks anything. It is read and written by the hooks that decide.
//
//   node .claude/harness/run-state.mjs status
//   node .claude/harness/run-state.mjs plan <path>     bind a plan to the active run
//   node .claude/harness/run-state.mjs halt [reason]

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { load } from './config.mjs'

// A session that dies mid-run leaves the pointer behind. Without expiry, "no active run → release"
// quietly stops being true and every later turn is driven by a dead objective — which looks exactly
// like the loop working.
const STALE_MS = 2 * 60 * 60 * 1000

const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export const hashPlan = planPath => {
  try {
    return createHash('sha1').update(readFileSync(planPath, 'utf8')).digest('hex').slice(0, 12)
  } catch {
    return null
  }
}

const headSha = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim().slice(0, 12)
  } catch {
    return null
  }
}

export const statePath = (config, runId) => join(config.statePaths.runs, runId, 'state.json')
export const attemptsPath = (config, runId) => join(config.statePaths.runs, runId, 'attempts.jsonl')
export const haltReportPath = (config, runId) => join(config.statePaths.runs, runId, 'halt-report.md')

export const readPointer = (config = load()) => readJson(config.statePaths.runPointer)

export const clearPointer = (config = load()) => {
  try {
    rmSync(config.statePaths.runPointer, { force: true })
  } catch {
    /* already gone */
  }
}

// THE ONE FUNCTION EVERY CALLER SHOULD USE. Returns null — meaning "no run, release" — for all five
// reasons a pointer should be ignored, so no caller has to remember the list.
//
// `sessionId` matters: two Claude Code windows on this repo would both read this pointer and both
// drive. Ownership by convention is not ownership.
export const activeRun = (sessionId, config = load()) => {
  const pointer = readPointer(config)

  if (!pointer?.runId) return null
  if (sessionId && pointer.sessionId && pointer.sessionId !== sessionId) return null

  const age = Date.now() - Date.parse(pointer.lastBeatAt ?? 0)

  if (!Number.isFinite(age) || age > STALE_MS) {
    clearPointer(config)

    return null
  }

  const state = readJson(statePath(config, pointer.runId))

  if (!state || state.halted) return null

  return state
}

export const init = ({ objective, label, planPath, sessionId, budget = {} }, config = load()) => {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label ?? 'run'}`

  const state = {
    runId,
    objective,
    label: label ?? null,
    planPath: planPath ?? null,

    // Without planHash, amending the plan mid-run silently changes what the phase cursor MEANS.
    // Without baseSha, "what did this run change" and "roll it back" are both unanswerable at halt
    // time — which is exactly when they get asked.
    planHash: planPath ? hashPlan(planPath) : null,
    baseSha: headSha(),

    iteration: 0,
    phaseIteration: 0,
    redIterations: 0,
    planlessIterations: 0,

    // Consecutive failures of the between-iteration preconditions. It lives here rather than in
    // preflight.mjs because that file answers "is this healthy right now", a question with no history.
    preflightFailures: 0,
    spawns: 0,
    phaseCursor: null,

    startedAt: new Date().toISOString(),
    lastBeatAt: new Date().toISOString(),
    budget: { ...config.taskLoop.budget, ...budget },

    paused: false,
    halted: false,
    haltReason: null
  }

  writeJson(statePath(config, runId), state)
  writeJson(config.statePaths.runPointer, { runId, sessionId: sessionId ?? null, lastBeatAt: state.lastBeatAt })

  return state
}

export const update = (runId, patch, config = load()) => {
  const current = readJson(statePath(config, runId))

  if (!current) return null

  const next = { ...current, ...patch, lastBeatAt: new Date().toISOString() }

  writeJson(statePath(config, runId), next)

  const pointer = readPointer(config)

  if (pointer?.runId === runId) writeJson(config.statePaths.runPointer, { ...pointer, lastBeatAt: next.lastBeatAt })

  return next
}

// Halting is terminal and must leave something a person can read. A report nobody reads is a loop that
// stopped an hour ago without telling anyone.
export const halt = (runId, reason, report = '', config = load()) => {
  const state = update(runId, { halted: true, haltReason: reason }, config)

  if (report) {
    try {
      mkdirSync(dirname(haltReportPath(config, runId)), { recursive: true })
      writeFileSync(haltReportPath(config, runId), `${report}\n`)
    } catch {
      /* the block reason still carries the essentials */
    }
  }

  clearPointer(config)

  return state
}

// ── Attempts ───────────────────────────────────────────────────────────────────
//
// The highest-value file here. A debugging skill can ASK the model to keep an attempt ledger by hand;
// writing it mechanically is the whole point of moving the counter outside the model. An agent that can
// read its own failed hypotheses stops producing variations of them.
//
// The `hypothesis` field exists so an attempt records WHY it was made, not only what it touched. Two
// attempts that changed the same files for different reasons are different attempts.

export const recordAttempt = (runId, entry, config = load()) => {
  try {
    mkdirSync(dirname(attemptsPath(config, runId)), { recursive: true })
    appendFileSync(attemptsPath(config, runId), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {
    /* evidence, not a dependency */
  }
}

export const recentAttempts = (runId, count = 3, config = load()) => {
  try {
    return readFileSync(attemptsPath(config, runId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .slice(-count)
  } catch {
    return []
  }
}

export const describeAttempts = (runId, config = load()) =>
  recentAttempts(runId, 3, config)
    .map(
      (attempt, index) =>
        `  ${index + 1}. phase ${attempt.phase ?? '?'} — ${attempt.hypothesis ?? 'no hypothesis recorded'}` +
        `\n     touched: ${(attempt.filesTouched ?? []).join(', ') || '(nothing)'}`
    )
    .join('\n')

// ── CLI ────────────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('run-state.mjs')) {
  const config = load()
  const [, , command, ...rest] = process.argv

  if (command === 'status') {
    const pointer = readPointer(config)

    if (!pointer) {
      console.log('  no active run')
      process.exit(0)
    }

    const state = readJson(statePath(config, pointer.runId))
    const age = Math.round((Date.now() - Date.parse(pointer.lastBeatAt ?? 0)) / 1000)

    console.log(`  run: ${pointer.runId}`)
    console.log(`  objective: ${state?.objective ?? '(unreadable)'}`)
    console.log(`  session: ${pointer.sessionId ?? 'unowned'} · last beat ${age}s ago`)
    console.log(`  iteration ${state?.iteration ?? 0}/${state?.budget?.iterations ?? '?'} · phase ${state?.phaseCursor?.phase ?? '?'}`)
    if (state?.paused) console.log('  PAUSED — /build --resume to continue')
    if (state?.halted) console.log(`  HALTED — ${state.haltReason}`)
    process.exit(0)
  }

  if (command === 'halt') {
    const pointer = readPointer(config)

    if (!pointer) {
      console.log('  no active run')
      process.exit(0)
    }

    halt(pointer.runId, rest.join(' ') || 'halted by hand', '', config)
    console.log(`  halted ${pointer.runId}`)
    process.exit(0)
  }

  // A run is created BEFORE a plan exists — the planner has not run yet. Binding the plan afterwards is
  // what gives the cursor something to read, and it stamps `planHash` at that moment, so drift is
  // measured from when the plan became the contract rather than from when the run started.
  if (command === 'plan') {
    const pointer = readPointer(config)
    const planPath = rest[0]

    if (!pointer) {
      console.log('  no active run — start one with /build <label>')
      process.exit(1)
    }

    if (!planPath || !hashPlan(planPath)) {
      console.log(`  no such plan: ${planPath ?? '(none given)'}`)
      process.exit(1)
    }

    update(pointer.runId, { planPath, planHash: hashPlan(planPath) }, config)
    console.log(`  run ${pointer.runId} is now driven by ${planPath}`)
    process.exit(0)
  }

  console.log('usage: run-state.mjs <status|halt [reason]|plan <path>>')
}
