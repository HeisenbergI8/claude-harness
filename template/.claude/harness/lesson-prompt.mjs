#!/usr/bin/env node
// Stop gate: asks, once per session, whether anything that happened is worth writing down.
//
// ── WHY A BLOCK AND NOT A MESSAGE ──────────────────────────────────────────────
//
// The obvious implementation emits a note and hopes it is read. In the system this was extracted from,
// the note-emitting version of this idea fired in ZERO sessions across the entire life of the project —
// partly a bug, partly that a `systemMessage` is easy to skip past.
//
// A block is read, because the turn does not end until it is answered. That is a real cost, so it
// happens AT MOST ONCE PER SESSION and only when there is something specific to point at.
//
// ── IT NEVER WRITES A LESSON ───────────────────────────────────────────────────
//
// Nothing in the capture path does. Recording is a deliberate act with a four-test bar behind it, and
// automating it is precisely how a curated store becomes a log. This asks the question and gets out of
// the way.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { block, load, readPayload } from './config.mjs'

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const readCandidates = config => {
  try {
    return readFileSync(config.statePaths.candidates, 'utf8')
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
  } catch {
    return []
  }
}

// ── The decision, as a pure function ───────────────────────────────────────────
//
// Exported and tested. The expected rate is about one lesson per session, FREQUENTLY ZERO — so the bar
// for even asking is "something was captured this session that has not been reviewed".
export const decide = ({ candidates = [], askedThisSession = false, sessionStartedAt = null }) => {
  if (askedThisSession) return { action: 'pass', why: 'already asked this session' }

  const fresh = sessionStartedAt ? candidates.filter(entry => entry.at >= sessionStartedAt) : candidates

  // A review-agent completion on its own is not evidence that anything went wrong. Requiring a
  // correction or a self-correction keeps the question honest.
  const notable = fresh.filter(entry => entry.kind === 'correction' || entry.kind === 'self-correction')

  if (!notable.length) return { action: 'pass', why: 'nothing captured worth asking about' }

  return { action: 'ask', why: `${notable.length} incident(s) captured this session`, notable }
}

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const config = load()

  if (config.lessons?.enabled === false || config.candidates?.enabled === false) process.exit(0)
  if (payload.stop_hook_active === true) process.exit(0)

  const session = payload.session_id ?? 'unknown'
  const statePath = config.statePaths.lessonPromptState
  const state = readJson(statePath, {})

  const verdict = decide({
    candidates: readCandidates(config),
    askedThisSession: state.session === session,
    sessionStartedAt: state.startedAt
  })

  if (verdict.action !== 'ask') process.exit(0)

  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify({ session, startedAt: new Date().toISOString() })}\n`)
  } catch {
    /* one extra ask is better than a crashed turn */
  }

  block(
    `Before you finish: ${verdict.why} in this session.\n\n` +
      verdict.notable.slice(0, 3).map(entry => `  · [${entry.kind}] ${entry.text.slice(0, 160)}`).join('\n') +
      `\n\nIs any of it worth recording as a lesson in \`${config.lessons.dir}\`? The bar is FOUR tests, ` +
      `all of which must pass:\n\n` +
      `  1. RECURRENCE — will this plausibly happen again, in this project, on this stack?\n` +
      `  2. NON-OBVIOUSNESS — would a competent developer reading the code already know?\n` +
      `  3. BEHAVIOUR CHANGE — does it change what you would DO, not merely what you know?\n` +
      `  4. COST — did getting it wrong actually cost something real?\n\n` +
      `THE EXPECTED ANSWER IS USUALLY NO, and saying so in one line is a complete response. The store is ` +
      `capped, every entry is paid for in tokens on every matching prompt, and duplicating something ` +
      `already in your project docs is the main way it bloats.\n\n` +
      `This asks once per session and will not ask again.`
  )
}

if (process.argv[1]?.endsWith('lesson-prompt.mjs')) main()
