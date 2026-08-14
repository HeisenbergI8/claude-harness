#!/usr/bin/env node
// Stop gate: the review agents run on every tier above trivial, and the only thing that has ever made
// them run is remembering to launch them.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────
//
// It does not spawn anything. A hook is a shell command; it cannot call the Agent tool. All it can do is
// refuse the turn and NAME what to launch. This is a reminder with a blocking backstop, not an
// executor, and describing it as "automatic" would overstate it.
//
// ── THE PREDICATE IS THE WHOLE DESIGN ──────────────────────────────────────────
//
// `Stop` fires at the end of EVERY turn, including "what does this file do?". There is no "task
// finished" event to hang this on, so it needs a proxy — and a bad proxy is not a small cost. A gate
// that nags wrongly gets switched off, and then it protects nothing.
//
// The proxy is the signal the model ALREADY emits when it believes it is done: a full `verify` run.
// `record-activity` records the full and fast gates as two distinct kinds, so "still working" and
// "wrapping up" are already distinguishable in the ledger, at no cost and with no new signal invented.
//
// Consequence, stated plainly: a turn that ends on the FAST gate does not fire this. That is a MISS,
// accepted deliberately. Misses are the cheap failure here; false fires are the expensive one.
//
// ── ONE BLOCK, EVER ────────────────────────────────────────────────────────────
//
// Not two. The verify gate escalates because a red tree is a defect; this is a judgement call, and
// "that was trivial, skip it" is a legitimate answer that should cost three words.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { block, load, readPayload, scopeKey, turnKey } from './config.mjs'
import { beat } from './hook-heartbeat.mjs'
import { readLedgerFile, readTurn } from './record-activity.mjs'
import { activeRun } from './run-state.mjs'

// A plan whose implementation log was written within this window is the plan this work belongs to.
// Loose on purpose: naming the wrong auditor costs a correction, and the reason string says how to
// override it.
const PLAN_RECENT_MS = 2 * 60 * 60 * 1000

const REVIEW_AGENTS = ['tester', 'auditor', 'change-auditor']

// ── The decision, as a pure function ───────────────────────────────────────────
export const decide = ({ edits = [], verifyGreen = false, agentsRun = [], buildActive = false, alreadyNudged = false }) => {
  if (alreadyNudged) return { action: 'pass', why: 'already nudged for this turn' }

  // The task driver owns verification inside a run and has its own spawn budget. Two mechanisms
  // independently demanding subagents would exhaust that budget and halt the run with an error that
  // looks unrelated to its cause.
  if (buildActive) return { action: 'pass', why: 'task-loop run active — the driver owns this' }

  if (!edits.length) return { action: 'pass', why: 'no tracked source edited this turn' }
  if (!verifyGreen) return { action: 'pass', why: 'no green full verify — still mid-task' }

  // Filtered HERE as well as in the ledger reader, and not by accident. ANY subagent completion reaches
  // the ledger, so trusting the raw list would let an unrelated search agent silence the gate.
  const reviewed = [...new Set(agentsRun)].filter(agent => REVIEW_AGENTS.includes(agent))

  if (reviewed.length) return { action: 'pass', why: `already ran: ${reviewed.join(', ')}` }

  return { action: 'nudge', why: 'source changed, full verify green, no review agent ran' }
}

// Which auditor applies. One traces a written plan step by step and needs a plan directory; the other
// audits the diff against the request. Presence of a recent plan decides it.
export const pickAuditor = (config, now = Date.now()) => {
  const root = config.plan?.dir ?? '.claude/plans'

  try {
    for (const entry of readdirSync(root)) {
      const log = join(root, entry, 'implementation-log.md')

      if (existsSync(log) && now - statSync(log).mtimeMs < PLAN_RECENT_MS) return { agent: 'auditor', plan: entry }
    }
  } catch {
    /* no plans directory is the common case, and it means change-auditor */
  }

  return { agent: 'change-auditor', plan: null }
}

const reason = ({ edits, auditor }) => {
  const shown = edits.slice(0, 6).map(file => `  ${file}`).join('\n')
  const more = edits.length > 6 ? `\n  …and ${edits.length - 6} more` : ''

  return (
    `You edited ${edits.length} tracked source file(s) and the full verify passed, but neither review ` +
    `agent has run this turn:\n${shown}${more}\n\n` +
    `Launch BOTH IN ONE MESSAGE with \`run_in_background: true\`:\n` +
    `  · \`tester\` — does it actually work\n` +
    `  · \`${auditor.agent}\` — was the request delivered, and nothing else` +
    (auditor.plan ? ` (plan: ${auditor.plan})` : '') +
    `\n\nDEMAND AN ARTIFACT FROM THE TESTER. A behavioural PASS must carry a screenshot path, a spec ` +
    `filename, or a command and its exit code — something the user can open. "The page works" with ` +
    `nothing behind it is NOT VERIFIED, and you must relay it to the user as not verified. A claim with ` +
    `no artifact is worse than silence, because it stops anyone else looking.\n\n` +
    `Concurrency is not an optimisation here — they share no data, so running them in sequence adds the ` +
    `slower one's wall clock to the faster one's for the same result.\n\n` +
    `IF THIS DID NOT NEED THEM — a rename, a label, a comment — say so to the user in one line and ` +
    `finish. This gate blocks ONCE and will not ask again.`
  )
}

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const config = load()

  beat('review-gate', payload, config)

  if (config.gates?.reviewGate?.enabled === false) process.exit(0)
  if (payload.stop_hook_active === true) process.exit(0)

  const turn = turnKey(payload)
  const key = `${scopeKey(payload)}:${turn}`
  const statePath = config.statePaths.reviewState

  let state = {}

  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    state = {}
  }

  const { edits, verifyGreen, agentsRun } = readTurn(readLedgerFile(config), turn, REVIEW_AGENTS)

  let buildActive = false

  try {
    buildActive = Boolean(activeRun(payload.session_id, config))
  } catch {
    // A driver that cannot be read is not a reason to nag. Fail toward silence.
    buildActive = true
  }

  const verdict = decide({ edits, verifyGreen, agentsRun, buildActive, alreadyNudged: state.lastKey === key })

  if (process.argv.includes('--status')) {
    console.log(JSON.stringify({ turn, edits, verifyGreen, agentsRun, buildActive, verdict }, null, 2))
    process.exit(0)
  }

  if (verdict.action !== 'nudge') process.exit(0)

  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify({ lastKey: key })}\n`)
  } catch {
    /* one extra nudge is better than a crashed turn */
  }

  block(reason({ edits, auditor: pickAuditor(config) }))
}

if (process.argv[1]?.endsWith('review-gate.mjs')) main()
