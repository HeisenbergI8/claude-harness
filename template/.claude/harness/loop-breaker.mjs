#!/usr/bin/env node
// Counts consecutive failures of the SAME shell command and escalates.
//
// ── WHY THIS CANNOT BE A PROMPT ────────────────────────────────────────────────
//
// You can write "after three failed attempts, stop and escalate" into an instruction file, and it will
// be ignored — not out of disobedience, but because NOT NOTICING is the failure. A model stuck in a loop
// does not invoke its own anti-loop rule, for the same reason a person who has lost their keys does not
// think to stop looking. The counter therefore lives outside the model.
//
//   N consecutive failures  -> inject a warning into context (non-blocking)
//   M consecutive failures  -> block the call outright, forcing escalation to the user
//   a SECOND block          -> halt; the directive has been given once and ignored
//
// ── THE COUNT SURVIVES THE BLOCK ───────────────────────────────────────────────
//
// The obvious implementation deletes the counter at the moment it blocks. That means the counter
// restarts the instant the block is issued, so the same command can fail forever — blocked every third
// time, with the identical message, no escalation, and no halt. Blocking is not the end of the ladder,
// it is a rung on it.
//
// The SUCCESS path still deletes, and that is correct: a command that passed has nothing left to count.
//
// ── REGISTERED ON BOTH POST-TOOL EVENTS ────────────────────────────────────────
//
// Which event a failed Bash command fires is not something to assume. This listens on both PostToolUse
// and PostToolUseFailure and de-duplicates on `tool_use_id`, so it is correct whichever one your build
// emits — and the state file records which events were actually seen, turning the question into evidence.
//
// Inspect what it sees with:  node .claude/harness/loop-breaker.mjs --debug < payload.json

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { block, didFail, inject, load, readPayload, scopeKey } from './config.mjs'
import { beat } from './hook-heartbeat.mjs'

const MAX_SEEN = 200

const readState = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { entries: {}, seen: [] }
  }
}

const writeState = (path, state) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    // Keep the seen-list bounded; it only exists to de-duplicate double-fired events.
    state.seen = (state.seen ?? []).slice(-MAX_SEEN)
    writeFileSync(path, `${JSON.stringify(state)}\n`)
  } catch {
    /* a counter that cannot be written costs one extra retry, not a crashed turn */
  }
}

// ── The decision, as a pure function ───────────────────────────────────────────
//
// Exported so the tests can drive the ladder without a filesystem or a subprocess.
export const decide = ({ count, blocked = 0, injectAt = 2, blockAt = 3 }) => {
  if (count >= blockAt && blocked >= 1) return { action: 'halt' }
  if (count >= blockAt) return { action: 'block' }
  if (count >= injectAt) return { action: 'inject' }

  return { action: 'pass' }
}

const main = async () => {
  const debug = process.argv.includes('--debug')
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const config = load()

  if (debug) {
    console.error(
      JSON.stringify({ event: payload.hook_event_name, tool_response: payload.tool_response, didFail: didFail(payload) }, null, 2)
    )
    process.exit(0)
  }

  beat('loop-breaker', payload, config)

  if (config.gates?.loopBreaker?.enabled === false) process.exit(0)

  const command = payload?.tool_input?.command

  if (typeof command !== 'string' || !command.trim()) process.exit(0)

  const statePath = config.statePaths.loopState
  const state = readState(statePath)
  const useId = payload.tool_use_id

  // Both candidate events may fire for one command; count it once.
  if (useId) {
    if ((state.seen ?? []).includes(useId)) process.exit(0)

    state.seen = [...(state.seen ?? []), useId]
  }

  // Scoped per agent, so a subagent's retries never inherit the main thread's count.
  const key = `${scopeKey(payload)}:${createHash('sha1').update(command.trim()).digest('hex').slice(0, 12)}`

  if (!didFail(payload)) {
    if (state.entries?.[key]) delete state.entries[key]

    writeState(statePath, state)
    process.exit(0)
  }

  state.entries ??= {}

  const entry = state.entries[key] ?? { count: 0, command: command.trim().slice(0, 200), events: [] }

  // Which event a failed command fires is not documented anywhere you can rely on. Recording it makes
  // the answer visible in the state file instead of a matter of belief.
  entry.events = [...new Set([...(entry.events ?? []), payload.hook_event_name ?? 'unknown'])]
  entry.count += 1

  const injectAt = config.gates?.loopBreaker?.injectAt ?? 2
  const blockAt = config.gates?.loopBreaker?.blockAt ?? 3
  const verdict = decide({ count: entry.count, blocked: entry.blocked ?? 0, injectAt, blockAt })

  if (verdict.action === 'block' || verdict.action === 'halt') entry.blocked = (entry.blocked ?? 0) + 1

  state.entries[key] = entry
  writeState(statePath, state)

  // Second block for the same command: the directive has already been given once and ignored. Halt
  // rather than repeat it — a third identical instruction is noise, and the user needs to know the agent
  // is stuck rather than watch it circle.
  if (verdict.action === 'halt') {
    block(
      `HALT — this command has been blocked ${entry.blocked} times and has now failed ${entry.count} ` +
        `times in total:\n\n    ${entry.command}\n\n` +
        `Do not run it again and do not try another variation. Stop and tell the user: the verbatim ` +
        `symptom, every hypothesis already tried, what you now believe the cause is, and what you would ` +
        `need in order to be sure.`
    )
  }

  if (verdict.action === 'block') {
    block(
      `This command has now failed ${entry.count} times unchanged:\n\n    ${entry.command}\n\n` +
        `Stop retrying it. Write down the hypotheses you have already disproved, then escalate to the ` +
        `user with: the verbatim symptom, every attempt so far, what you now believe the cause is, and ` +
        `what you would need in order to be sure.`
    )
  }

  if (verdict.action === 'inject') {
    inject(
      `This exact command has failed ${entry.count} times in a row. Before running it again: write down ` +
        `the hypothesis you have already disproved, and make your next attempt differ in KIND, not in ` +
        `detail. One more identical failure will be blocked.`,
      payload.hook_event_name ?? 'PostToolUse'
    )
  }

  process.exit(0)
}

if (process.argv[1]?.endsWith('loop-breaker.mjs')) main()
