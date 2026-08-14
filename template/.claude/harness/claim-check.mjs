#!/usr/bin/env node
// Stop gate: refuses to let a turn end on an unsupported claim about verification.
//
// The failure this exists for is "Done! Tests pass." when nothing ran — or when something ran and
// failed. `verify-gate.mjs` already blocks ending on a RED tree; it cannot catch a claim about a run
// that never happened while the tree is green. This can, because `record-activity.mjs` wrote down what
// actually ran.
//
// A false green is worse than a reported red. A red gate gets fixed; a false green gets shipped.
//
// Two independent checks, in increasing order of what they need:
//
//   A. SOURCE TOUCHED, NOTHING VERIFIED — needs only the ledger. Editing source and ending the turn
//      with no verification recorded at all is blocked outright.
//
//   B. CLAIM WITHOUT A RUN — needs `last_assistant_message` on the Stop payload, which is NOT
//      guaranteed to exist in every build. If it is absent this check silently does nothing and A
//      still applies. Run with `--probe` to see what your payload actually carries.
//
// Like every blocking gate here, it keeps a consecutive-block counter so it can never trap a session.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { block, load, readPayload, scopeKey, turnKey } from './config.mjs'
import { beat } from './hook-heartbeat.mjs'
import { readLedgerFile, readTurn } from './record-activity.mjs'

// ── USE vs MENTION ─────────────────────────────────────────────────────────────
//
// The patterns below hunt for an ASSERTION that a gate is green. A regex cannot tell that apart from the
// phrase being QUOTED — and this gate's own subject IS that assertion, so any message documenting it
// trips forever.
//
// This is not theoretical. In the harness this was extracted from, the raw matcher fired 29 times in a
// single session on: pasted command output inside a fenced block, a pattern list in a table, a proposed
// termination condition, and an acceptance criterion in a ticket. The 29th fired on the very table
// enumerating the first 28.
//
// Worse than noisy: pasting REAL command output as evidence is the practice you want to encourage, and
// the raw matcher penalised exactly that while a bare prose assertion — the thing this gate is FOR —
// looked identical to it.
//
// TWO DELIBERATE CHOICES:
//
//   1. Bold runs are NOT stripped. A genuine claim is often written **in bold for emphasis**, so
//      stripping it would let the exact sentence this gate exists for walk straight through.
//   2. Quoted spans are BOUNDED and single-line. An unbounded `"[^"]*"` swallows everything between two
//      distant quotes, which could hide a real claim sitting between them.
//
// This weakens check B slightly: output faked inside a fence is no longer read as a claim. That is an
// accepted trade. Check A does not depend on the message at all, and the ledger — not the prose — is
// what this gate is ultimately built on.
export const stripQuoted = text =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]{0,200}"/g, ' ')
    .replace(/[“”][^“”\n]{0,200}[“”]/g, ' ')

// Deliberately NARROW. These are claims of fact about a run, not hedged language. Every one of these
// must pass untouched:
//
//   "I have not run the tests yet"
//   "next I should run the tests"
//   "the suite failed — 3 of 40 are red"
//
// The gate exists for the one sentence that does real damage: asserting a green gate that was never run.
export const CLAIM_PATTERNS = [
  /\b\d+\s*\/\s*\d+\s+(tests?|passing|pass)\b/i,
  // `pass(es|ed|ing)?` — "the suite passes now" is the same assertion as "the suite passed", and
  // omitting the third-person singular let the most natural phrasing of the claim walk straight through.
  /\b(tests?|suite|specs?)\s+(all\s+)?pass(es|ed|ing)?\b/i,
  /\ball\s+tests?\s+(are\s+)?(green|passing|pass)\b/i,
  /\b(verify|typecheck|lint|build|baseline|gates?|checks?)\s+(is\s+|are\s+)?(green|clean|passing|passes|passed)\b/i,

  // NARROWED. Both of the next two fire on prose ABOUT exit codes rather than on a claim — "a zero exit
  // means PASS", "the baseline unchanged line is what proves it". `stripQuoted` does not help, because
  // these appear unquoted in ordinary explanation. Requiring a verification noun within ~45 characters
  // keeps every real claim shape and drops the descriptions.
  /\b(verify|typecheck|lint|tests?|build|baseline|gates?|checks?)\b[^.\n]{0,45}\bexit\s*=?\s*0\b/i,

  // "unchanged" followed by a noun is MODIFYING it ("the baseline unchanged line"), not asserting a
  // state. The negative lookahead separates them, and the copula stays optional so the real claim shape
  // "with the baseline unchanged at 316/318" still fires.
  /\b(baseline|suite|tests?)\s+(is\s+|are\s+|was\s+|remains?\s+)?unchanged\b(?!\s+(line|message|check|string|pattern|rule|text|claim|clause))/i,

  /\bI\s+ran\s+the\s+(tests?|suite|gates?|checks?)\b/i
]

const compilePatterns = config => {
  const extra = []

  for (const source of config.gates?.claimCheck?.extraClaimPatterns ?? []) {
    try {
      extra.push(new RegExp(source, 'i'))
    } catch {
      /* a bad user pattern is ignored rather than allowed to trap every turn */
    }
  }

  return [...CLAIM_PATTERNS, ...extra]
}

// ── The decision, as a pure function ───────────────────────────────────────────
//
// Exported so the tests can assert both directions without spawning a process or fabricating a hook
// payload. A gate whose decision can only be exercised end-to-end is a gate whose ALLOW cases never get
// tested, and the ALLOW cases are the ones that decide whether people keep it switched on.
export const decide = ({ edits = [], runs = [], message = '', patterns = CLAIM_PATTERNS }) => {
  const green = runs.filter(run => run.ok)
  const red = runs.filter(run => !run.ok)

  // A. Source touched, nothing verified.
  if (edits.length > 0 && runs.length === 0) {
    return {
      action: 'block',
      code: 'unverified-edit',
      reason:
        `You edited ${edits.length} source file(s) this turn and ran no verification:\n` +
        `${edits.slice(0, 8).map(file => `  ${file}`).join('\n')}\n\n` +
        `Run the project's verify command before finishing, or state plainly to the user that the ` +
        `change is unverified and why. Saying so is fine. Implying otherwise is not.`
    }
  }

  if (!message) return { action: 'pass', code: 'no-message', reason: 'no assistant message on the payload' }

  const claim = patterns.find(pattern => pattern.test(stripQuoted(message)))

  if (!claim) return { action: 'pass', code: 'no-claim', reason: 'no verification claim detected' }

  if (runs.length === 0) {
    return {
      action: 'block',
      code: 'claim-without-run',
      reason:
        `Your message claims verification passed, but NO verification command ran this turn.\n\n` +
        `Matched: ${claim}\n\n` +
        `Either run it, or remove the claim. Reporting a green gate you did not run is the single most ` +
        `damaging thing you can do here — it is worse than reporting a failure, because a failure gets ` +
        `fixed and a false green gets shipped.`
    }
  }

  if (red.length > 0 && green.length === 0) {
    return {
      action: 'block',
      code: 'claim-against-red',
      reason:
        `Your message claims verification passed, but every run this turn FAILED ` +
        `(${red.map(run => run.kind).join(', ')}).\n\n` +
        `Matched: ${claim}\n\nCorrect the claim before finishing.`
    }
  }

  return { action: 'pass', code: 'claim-supported', reason: `supported by ${green.length} green run(s)` }
}

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const main = async () => {
  const payload = await readPayload()

  // No payload is not grounds to trap a turn.
  if (!payload) process.exit(0)

  const config = load()

  beat('claim-check', payload, config)

  if (process.argv.includes('--probe')) {
    console.error(
      JSON.stringify(
        { event: payload.hook_event_name, keys: Object.keys(payload), hasMessage: 'last_assistant_message' in payload },
        null,
        2
      )
    )
    process.exit(0)
  }

  if (config.gates?.claimCheck?.enabled === false) process.exit(0)

  // A gate cannot judge a turn while its own config is broken. Stand aside and let the selftest be loud.
  if (config.errors.length) process.exit(0)

  // `stop_hook_active` means we are already inside a blocked-and-resumed turn. Blocking again is how a
  // session gets trapped.
  if (payload.stop_hook_active === true) process.exit(0)

  const turn = turnKey(payload)
  const key = `${scopeKey(payload)}:${turn}`
  const statePath = config.statePaths.claimState
  const state = readJson(statePath, {})
  const maxBlocks = config.gates?.claimCheck?.maxBlocks ?? 2

  // Stand aside rather than trap the session. The model has been told twice; a third identical block is
  // noise, and noise is how a gate gets switched off.
  if ((state[key] ?? 0) >= maxBlocks) {
    delete state[key]
    writeState(statePath, state)
    process.exit(0)
  }

  const { edits, runs } = readTurn(readLedgerFile(config), turn)
  const message = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : ''
  const verdict = decide({ edits, runs, message, patterns: compilePatterns(config) })

  if (process.argv.includes('--status')) {
    console.log(JSON.stringify({ turn, edits, runs, hasMessage: Boolean(message), verdict }, null, 2))
    process.exit(0)
  }

  if (verdict.action !== 'block') process.exit(0)

  state[key] = (state[key] ?? 0) + 1
  writeState(statePath, state)
  block(verdict.reason)
}

function writeState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state)}\n`)
  } catch {
    /* a counter that cannot be written means one extra block, not a crashed turn */
  }
}

if (process.argv[1]?.endsWith('claim-check.mjs')) main()
