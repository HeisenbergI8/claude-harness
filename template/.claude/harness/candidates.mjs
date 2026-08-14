#!/usr/bin/env node
// The EPISODIC layer beneath the lesson store.
//
//   lessons/     semantic memory — distilled, curated, injected, and therefore expensive
//   candidates   episodic memory — raw incidents, captured automatically, NEVER injected, therefore free
//
//   node .claude/harness/candidates.mjs record    UserPromptSubmit — a user message shaped like a correction
//   node .claude/harness/candidates.mjs reflect   Stop            — the agent's OWN admission of error
//   node .claude/harness/candidates.mjs finding   SubagentStop    — a review agent's run worth distilling
//   node .claude/harness/candidates.mjs list | status | clear --before <ISO>
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
//
// The obvious auto-capture signal is "the same command failed and later passed". Measured against a
// real session with five genuine mistakes in it, that signal caught NONE of them — every one was a
// reasoning error with no failing command. Capture then falls back on the agent volunteering that it
// erred, which is the least reliable possible source.
//
// ── CAPTURE GENEROUSLY, DISTIL STRICTLY ────────────────────────────────────────
//
// A missed candidate is a lesson lost. A noisy one is a line somebody skims. Those costs are not
// symmetric, so the patterns below OVER-MATCH on purpose.
//
// Strictness lives downstream, in the four-test bar for recording an actual lesson. NOTHING IN THIS
// PATH EVER WRITES A LESSON — that stays a deliberate human-reviewed act, which is what keeps the
// lesson store from becoming a log.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { load, readPayload, turnKey } from './config.mjs'

// ── USE vs MENTION ─────────────────────────────────────────────────────────────
//
// Same discipline as the claim checker, for the same reason: a message ABOUT a correction pattern is
// not a correction. Bold IS stripped here — unlike in claim-check — because this hunts self-corrections
// where the risk of a miss is low and the cost of a false capture is one skimmed line.
const strip = text =>
  String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/"[^"\n]{0,200}"/g, ' ')

// A user message shaped like a correction. Written from real corrections rather than from imagination —
// a first draft written by guessing at the phrasing missed about half of them.
export const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(that|it|this|you|i)\b/i,
  /\b(that|this|it)('s| is| was)\s+(wrong|incorrect|not right|backwards|the opposite)\b/i,
  /\bactually\b[^.?!]{0,40}\b(it|that|the)\b/i,
  /\byou (were|are|got)\s+(wrong|mistaken|confused)\b/i,
  /\bthat'?s not (what|how|why)\b/i,
  /\bi (said|asked for|wanted)\b/i,
  /\b(don'?t|do not|never)\s+(do|use|write|add|touch|change)\b/i,
  /\bwhy did you\b/i,
  /\bstop\b[^.?!]{0,20}\b(doing|adding|changing)\b/i,
  /\bundo\b|\brevert (that|it|this)\b/i,
  /\bi already (told|said|asked)\b/i,
  /\bnot what i (asked|meant|wanted)\b/i,
  /\bre-?read\b/i
]

// The agent's own admission. These are the shapes that precede a real lesson often enough to be worth
// capturing every time.
export const REFLECTION_PATTERNS = [
  /\bI (was|were) wrong\b/i,
  /\bI (made|introduced) (a|an) (mistake|error)\b/i,
  /\bmy (mistake|error|apologies)\b/i,
  /\bI should have\b/i,
  /\bI (incorrectly|wrongly|mistakenly)\b/i,
  /\bI assumed\b[^.?!]{0,60}\b(but|however|turned out)\b/i,
  /\bthat was (wrong|incorrect|a mistake)\b/i,
  /\bI missed\b/i,
  /\bcorrection\b/i,
  /\bI did not (actually |really )?(run|check|verify|read)\b/i
]

export const classify = (kind, text) => {
  const cleaned = strip(text)

  if (kind === 'record') return CORRECTION_PATTERNS.find(pattern => pattern.test(cleaned)) ?? null
  if (kind === 'reflect') return REFLECTION_PATTERNS.find(pattern => pattern.test(cleaned)) ?? null

  return null
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

const append = (config, entry) => {
  try {
    mkdirSync(dirname(config.statePaths.candidates), { recursive: true })
    appendFileSync(config.statePaths.candidates, `${JSON.stringify(entry)}\n`)
  } catch {
    /* capture is best-effort; it must never break a turn */
  }
}

// Text is truncated. This file is not injected, but it is read by a human during review, and a
// full assistant message per entry makes the review itself unreadable.
const excerpt = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)

const main = async () => {
  const config = load()
  const kind = process.argv[2]

  if (config.candidates?.enabled === false) process.exit(0)

  if (kind === 'list' || kind === 'status' || kind === 'clear') {
    const entries = readCandidates(config)

    if (kind === 'status') {
      const due = entries.length >= (config.candidates?.reviewAt ?? 15)

      console.log(`- candidates: ${entries.length}/${config.candidates?.reviewAt ?? 15}${due ? '  REVIEW DUE' : ''}`)
      process.exit(0)
    }

    if (kind === 'clear') {
      const before = process.argv[process.argv.indexOf('--before') + 1]

      if (!process.argv.includes('--before') || !before) {
        // Clearing everything is almost always wrong: the entries added since you started reading are
        // exactly the ones you have not reviewed.
        console.log('  refusing to clear everything — pass --before <ISO> so you only clear what you reviewed')
        process.exit(1)
      }

      const kept = entries.filter(entry => entry.at >= before)

      writeFileSync(config.statePaths.candidates, kept.map(entry => JSON.stringify(entry)).join('\n') + (kept.length ? '\n' : ''))
      console.log(`  cleared ${entries.length - kept.length}, kept ${kept.length}`)
      process.exit(0)
    }

    if (!entries.length) console.log('  no candidates captured')

    for (const entry of entries) {
      console.log(`  ${entry.at}  [${entry.kind}]${entry.agent ? ` ${entry.agent}` : ''}`)
      console.log(`      ${entry.text}`)
    }

    console.log(
      `\n  ${entries.length} captured. These are RAW — most will not become lessons, and that is the ` +
        `design. Distil strictly: recurrence, non-obviousness, behaviour change, and real cost.`
    )
    process.exit(0)
  }

  const payload = await readPayload()

  if (!payload) process.exit(0)

  const at = new Date().toISOString()

  if (kind === 'record') {
    const matched = classify('record', payload.prompt)

    if (matched) append(config, { at, kind: 'correction', turn: turnKey(payload), text: excerpt(payload.prompt) })
  }

  if (kind === 'reflect') {
    const matched = classify('reflect', payload.last_assistant_message)

    if (matched) {
      append(config, { at, kind: 'self-correction', turn: turnKey(payload), text: excerpt(payload.last_assistant_message) })
    }
  }

  if (kind === 'finding') {
    // A review agent completing is worth capturing unconditionally — its findings are exactly the
    // material a lesson gets distilled from, and there is no pattern to match against.
    const agent = payload.agent_type

    if (typeof agent === 'string' && ['tester', 'auditor', 'change-auditor'].includes(agent)) {
      append(config, {
        at,
        kind: 'review',
        agent,
        turn: turnKey(payload),
        text: excerpt(payload.last_assistant_message ?? `${agent} completed`)
      })
    }
  }

  process.exit(0)
}

if (process.argv[1]?.endsWith('candidates.mjs')) main()
