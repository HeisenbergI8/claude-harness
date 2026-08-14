#!/usr/bin/env node
// PostToolUse recorder. Writes a per-turn ledger of what ACTUALLY happened: which source files were
// edited, which verification commands ran, whether each one passed, and which subagents completed.
//
// This is the foundation the rest of the harness stands on. Every other gate is an opinion about a
// model's behaviour; this is a record of it. A model asserting "tests pass" is a prompt. A ledger line
// with a command and an exit code is evidence.
//
// Nothing here blocks anything — it only observes. That separation is deliberate: the recorder must
// never have a reason to be switched off.
//
// Keyed on `prompt_id`, which the hook payload carries, so "this turn" is a real boundary rather than a
// guess about timing.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { classifyCommand, didFail, isSourceFile, load, readPayload, turnKey } from './config.mjs'
import { beat } from './hook-heartbeat.mjs'

const MAX_TURNS_KEPT = 20
const COMPACT_AT_LINES = 400

// ── THE CANONICAL READER — THE WRITER OWNS THE FORMAT ──────────────────────────
//
// Every consumer wants to "split on newlines, JSON.parse, swallow torn lines". Left alone, each one
// grows its own copy — and the format is defined HERE, by whatever `main()` appends.
//
// That is not a tidiness complaint. A harness ships a reader looking for fields the writer never
// emitted, and it stays dead and green for weeks, because the reader's test fabricated the shape the
// READER wanted rather than the shape the WRITER produces. Exporting the reader from the writer makes
// agreement structural instead of merely tested: there is one place a field name can change, and it is
// the same file that writes it. `test/reader-writer.test.mjs` exists solely to detect that class of bug,
// and it drives the real writer rather than a fixture.
//
// Deliberately thin. `readLedgerEvents` returns parsed events and nothing more — each consumer keeps its
// own domain logic, because a single reader serving all of them would need flags, and a helper with
// flags is the complexity this was supposed to remove.

const parseLine = line => {
  try {
    return JSON.parse(line)
  } catch {
    /* a torn line is discarded rather than crashing the hook */
    return null
  }
}

export const readLedgerEvents = text => (text ?? '').split('\n').filter(Boolean).map(parseLine).filter(Boolean)

export const eventsForTurn = (text, turn) => readLedgerEvents(text).filter(event => event.turn === turn)

export const readLedgerFile = config => {
  try {
    return readFileSync(config.statePaths.ledger, 'utf8')
  } catch {
    return ''
  }
}

// ── The turn view ──────────────────────────────────────────────────────────────
//
// The one derived shape more than one gate needs. `events` is the total recorded for this turn, edits or
// not — because "this turn was recorded and touched no source" and "nothing was recorded at all" are
// different facts, and only the first is safe to treat as an exemption. Conflating them is how a gate
// silently stops running.
export const readTurn = (text, turn, reviewAgents = []) => {
  const edits = []
  const runs = []
  const agentsRun = []
  let verifyGreen = false

  const turnEvents = eventsForTurn(text, turn)

  for (const event of turnEvents) {
    if (event.edit && !edits.includes(event.edit)) edits.push(event.edit)
    if (event.run) runs.push({ kind: event.run, ok: event.ok === true, cmd: event.cmd })
    if (event.run === 'verify' && event.ok === true) verifyGreen = true
    if (event.agent && (!reviewAgents.length || reviewAgents.includes(event.agent))) agentsRun.push(event.agent)
  }

  return { edits, runs, agentsRun, verifyGreen, events: turnEvents.length }
}

// Files touched across the whole session, newest last. Read from the ledger rather than from git, so it
// reflects what the agent actually edited rather than what happens to be dirty in the working tree.
// De-duplication keeps the LAST occurrence, not the first. A file touched in turn 1 and again in turn 4
// is a file being worked on now, and `.slice(-limit)` is only honestly "the most recently touched" if
// re-touching moves it to the end. Keeping first-seen order would silently rank a file by when it was
// first opened, which is the opposite of what a repair loop wants to report.
export const recentEdits = (text, limit = 6) => {
  const order = new Map()

  for (const event of readLedgerEvents(text)) {
    if (!event.edit) continue

    order.delete(event.edit)
    order.set(event.edit, true)
  }

  return [...order.keys()].slice(-limit)
}

// ── Compaction ─────────────────────────────────────────────────────────────────
//
// Keeps the last MAX_TURNS_KEPT turns. Operates on LINES rather than parsed events, because it rewrites
// the file and must preserve the original bytes of every row it keeps. It shares `parseLine` so the
// torn-line rule cannot diverge between reading and rewriting.
const compact = config => {
  let lines

  try {
    lines = readFileSync(config.statePaths.ledger, 'utf8').split('\n').filter(Boolean)
  } catch {
    return
  }

  if (lines.length < COMPACT_AT_LINES) return

  const seen = []

  for (const line of lines) {
    const turn = parseLine(line)?.turn

    if (turn && !seen.includes(turn)) seen.push(turn)
  }

  const keep = new Set(seen.slice(-MAX_TURNS_KEPT))

  writeFileSync(config.statePaths.ledger, lines.filter(line => keep.has(parseLine(line)?.turn)).join('\n') + '\n')
}

// ── Event extraction ───────────────────────────────────────────────────────────
//
// Pure and exported so the tests can assert what a payload produces without spawning a process. Returns
// an array of ledger events, possibly empty.
export const eventsFromPayload = (payload, config) => {
  const events = []
  const turn = turnKey(payload)
  const tool = payload?.tool_name

  // WHICH subagent finished. A SubagentStop payload carries `prompt_id` alongside `agent_type`, which
  // means an agent completion lands on the SAME turn key as the edits that prompted it. That is what
  // lets a downstream gate ask "did the reviewers run for THIS work" instead of guessing from
  // timestamps. Verify it on your own build with `--probe` before depending on it.
  if (payload?.hook_event_name === 'SubagentStop') {
    const agent = payload.agent_type

    if (typeof agent === 'string' && agent) events.push({ turn, agent })
  }

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const file = payload?.tool_input?.file_path

    // Only files matching `source.include` count. Edits to docs, plans, or scratch are not the thing a
    // "tests pass" claim is about, and treating them as such trains the model to read the gate as noise.
    if (isSourceFile(config, file)) events.push({ turn, edit: file })
  }

  if (tool === 'Bash') {
    const command = payload?.tool_input?.command ?? ''
    const kind = classifyCommand(config, command)

    // `cmd` is recorded, truncated, because a downstream reader that wants to distinguish two runs of
    // the same KIND has nothing else to key on. Keep it short: this file is read on every turn.
    if (kind) events.push({ turn, run: kind, ok: !didFail(payload), cmd: command.trim().slice(0, 120) })
  }

  return events
}

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const config = load()

  beat('record-activity', payload, config)

  if (process.argv.includes('--probe')) {
    console.error(
      JSON.stringify(
        { event: payload.hook_event_name, keys: Object.keys(payload), events: eventsFromPayload(payload, config) },
        null,
        2
      )
    )
    process.exit(0)
  }

  const events = eventsFromPayload(payload, config)

  if (!events.length) process.exit(0)

  // ── APPEND-ONLY ─────────────────────────────────────────────────────────────
  //
  // This wants to be a read-modify-write over a single JSON object. With one writer that is fine. With
  // concurrent subagents — which any real pipeline runs, because a tester and an auditor share no data
  // and sequencing them only adds the slower one's wall clock to the faster one's — two processes read
  // the same file and the slower write silently discards the faster one's records.
  //
  // That matters more than a lost log line. `claim-check.mjs` reads this file to decide whether a claim
  // about a green gate is supported, so a dropped record turns an honest statement into a blocked turn —
  // or worse, hides an edit that should have demanded verification.
  //
  // One appended line per event fixes it structurally, with no lock: POSIX append is atomic below
  // PIPE_BUF and every line here is far under it.
  try {
    mkdirSync(dirname(config.statePaths.ledger), { recursive: true })
    appendFileSync(config.statePaths.ledger, events.map(event => JSON.stringify(event)).join('\n') + '\n')

    // COMPACTION IS THE ONE RACY OPERATION LEFT, so only the main thread does it. Agents append and
    // never rewrite; the main thread is never concurrent with itself, so the rewrite has a single writer
    // by construction. A file that grows a little between compactions costs nothing.
    if (!process.env.CLAUDE_AGENT_TYPE) compact(config)
  } catch {
    // The ledger is evidence, not a dependency. A recorder that crashes the turn it was observing has
    // made things worse than not existing.
  }

  process.exit(0)
}

// Only when RUN as a hook, never when imported for the readers above — `main()` awaits stdin, so an
// unguarded call would hang any importer forever.
if (process.argv[1]?.endsWith('record-activity.mjs')) main()
