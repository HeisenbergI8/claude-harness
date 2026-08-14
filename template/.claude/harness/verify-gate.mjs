#!/usr/bin/env node
// Stop / SubagentStop gate: runs the project's fast verify command and refuses to let the turn end on a
// red tree.
//
// ── WHY THIS IS A LOOP AND NOT A BRAKE ─────────────────────────────────────────
//
// A blocking Stop hook re-invokes the model with `reason` as feedback. That is an ITERATION PRIMITIVE,
// and the obvious implementation wastes it: block twice saying "fix it", then delete the counter and
// stand aside. That version lets roughly one red tree in three walk through, and the two blocks it does
// issue carry no more information the second time than the first.
//
// Three things make it a loop instead:
//
//   PREDICATE   "is the tree red?"          -> red, keyed on WHICH failure
//   REASON      "fix it" (a complaint)      -> the next action, plus what was already tried
//   EXHAUSTION  reset-and-allow             -> escalate, then HALT with a written report
//
// ── PROGRESS, NOT ATTEMPTS, DRIVES ESCALATION ──────────────────────────────────
//
// This is the single most important idea in the file. Counting retries PUNISHES a loop that is
// converging — three different fixes producing three different failures is progress — and REWARDS one
// that thrashes with a reworded command.
//
// So each iteration fingerprints the failure SET. A changed fingerprint resets the counter; an unchanged
// one escalates. Line and column numbers are stripped before hashing, because the same error sliding
// down a file because something above it changed is not progress.
//
// ── FAILS OPEN ─────────────────────────────────────────────────────────────────
//
// On anything it cannot parse, cannot run, or cannot time. A gate that traps a session gets switched
// off, and then it protects nothing.

import { execSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import { block, load, readPayload, scopeKey, turnKey } from './config.mjs'
import { beat } from './hook-heartbeat.mjs'
import { readLedgerFile, readTurn, recentEdits } from './record-activity.mjs'

// ── The fingerprint ────────────────────────────────────────────────────────────
//
// Pure and exported so the tests can assert that three DIFFERENT failures never halt — which is the
// property that makes this a loop rather than a nag.
//
// The line filter is intentionally ecosystem-broad. A failure line it does not recognise degrades to
// `unparsed`, which is treated as "cannot tell" and never escalates: an unrecognised output must not
// halt a run.
// The `-{2,}` alternative is not decoration: `go test` reports failures as `--- FAIL: TestThing`, so a
// pattern anchored on a bare line start misses every Go failure and silently degrades the whole loop to
// `unparsed` — which blocks but never escalates. A gate that cannot recognise your ecosystem's failures
// still works; it just stops being a loop.
export const FAILURE_LINE =
  /error(\s+TS\d+|\[|:)|^\s*(-{2,}\s*)?(FAIL|FAILED|BLOCK|ERROR)\b|✖|✗|panic:|Exception|AssertionError|error\[E\d+\]/i

export const fingerprint = output => {
  const signatures = (output ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => FAILURE_LINE.test(line))
    .map(line =>
      line
        .replace(/\(\d+,\s*\d+\)/g, '') // tsc: (12,5)
        .replace(/:\d+:\d+/g, '') // most others: file.ts:12:5
        .replace(/\bline \d+\b/gi, '') // python-ish
        .replace(/\s+/g, ' ')
        .slice(0, 160)
    )

  const unique = [...new Set(signatures)].sort()

  if (!unique.length) return { hash: 'unparsed', lines: [] }

  return { hash: createHash('sha1').update(unique.join('\n')).digest('hex').slice(0, 12), lines: unique }
}

// ── The decision, as a pure function ───────────────────────────────────────────
//
// Exported and tested in BOTH directions. The ALLOW half is the important half: a green tree, a first
// failure, and three DIFFERENT failures in a row must never halt.
export const decide = ({ green, hash, previous = {}, maxSameFailure = 3 }) => {
  if (green) return { action: 'pass', count: 0, code: 'green' }
  if (previous.halted) return { action: 'pass', count: previous.count ?? 0, code: 'already-halted' }

  // An unparseable failure is "cannot tell". It still blocks — the tree IS red — but it never counts
  // toward escalation, because escalating on a signature you could not read is escalating on noise.
  if (hash === 'unparsed') return { action: 'block', count: 1, code: 'unparsed' }

  const sameFailure = previous.hash === hash
  const count = sameFailure ? (previous.count ?? 0) + 1 : 1

  if (count >= maxSameFailure) return { action: 'halt', count, code: 'halt' }
  if (sameFailure) return { action: 'escalate', count, code: 'same-failure' }

  return { action: 'block', count, code: 'new-failure' }
}

const readState = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

const writeState = (path, state) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
  } catch {
    /* a counter that cannot be written costs one extra block, not a crashed turn */
  }
}

const attemptsPath = (config, key) => join(config.statePaths.attempts, `${key.replace(/[^\w.-]/g, '_')}.jsonl`)

const recordAttempt = (config, key, entry) => {
  try {
    mkdirSync(config.statePaths.attempts, { recursive: true })
    appendFileSync(attemptsPath(config, key), `${JSON.stringify(entry)}\n`)
  } catch {
    /* the attempt log is evidence, not a dependency */
  }
}

// The last three attempts are injected into every escalation, so the model can read its own failed
// hypotheses instead of reproducing them. This is the difference between "fix it" and a loop.
const priorAttempts = (config, key) => {
  try {
    return readFileSync(attemptsPath(config, key), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .slice(-3)
  } catch {
    return []
  }
}

const clearAttempts = (config, key) => {
  try {
    writeFileSync(attemptsPath(config, key), '')
  } catch {
    /* nothing to clear */
  }
}

export const haltReport = ({ hash, count, lines, attempts }) =>
  [
    `# Repair loop halted — ${new Date().toISOString()}`,
    '',
    `Failure signature \`${hash}\` survived ${count} attempts unchanged.`,
    '',
    '## What is failing',
    '',
    '```',
    ...lines.slice(0, 8),
    '```',
    '',
    '## What was tried',
    '',
    ...(attempts.length
      ? attempts.map(
          (attempt, index) => `${index + 1}. ${attempt.at} — touched ${attempt.files?.join(', ') || '(nothing recorded)'}`
        )
      : ['(no attempts recorded)']),
    '',
    'The loop stopped rather than continue producing variations of a failed fix.',
    'Nothing in this run will block on this signature again.'
  ].join('\n')

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const config = load()

  beat('verify-gate', payload, config)

  // Also beat under an EVENT-SCOPED name. This hook is registered on Stop AND SubagentStop, and the
  // heartbeat keys by hook name — so the two payloads' key sets merge and neither can be read on its
  // own. That defeats the heartbeat's second job ("what did the payload actually carry"), which is
  // precisely the question to answer before building anything that reads a SubagentStop field.
  beat(`verify-gate:${payload.hook_event_name ?? 'unknown'}`, payload, config)

  if (config.gates?.verifyGate?.enabled === false) process.exit(0)
  if (config.errors.length) process.exit(0)
  if (payload.stop_hook_active === true) process.exit(0)

  const command = config.commands.verifyFast

  // Nothing to run is not a failure. A harness installed but not yet configured must be inert, not
  // obstructive.
  if (!command) process.exit(0)

  // ── WHO CANNOT COMPLY ────────────────────────────────────────────────────────
  //
  // Read-only agents have no write access to source: an auditor typically ships with no Edit/Write tool
  // at all, and a tester is usually confined to test directories. A red tree is often the very thing
  // they were LAUNCHED to report on, so blocking them demands a repair they are structurally incapable
  // of making — and every block replays the agent's entire accumulated context, which on a long audit
  // is the most expensive thing this harness can do.
  //
  // The main thread still gets the full ladder. Nothing about the case this gate exists for changes.
  if (config.readOnlyAgents.includes(payload.agent_type)) process.exit(0)

  // A turn that edited no source did not break the tree, so a red result here is pre-existing and
  // blocking only replays the whole context to no end.
  //
  // The predicate is deliberately the STRICTER of the two readings: skip only when the turn IS in the
  // ledger and carries zero edits. An empty or unreadable ledger means UNKNOWN, and unknown runs the
  // gate. Conflating "recorded, no edits" with "nothing recorded" is how a gate silently stops running.
  const turn = turnKey(payload)
  const ledgerText = readLedgerFile(config)

  if (ledgerText) {
    const { edits, events } = readTurn(ledgerText, turn)

    if (events > 0 && edits.length === 0) process.exit(0)
  }

  const key = scopeKey(payload)
  const statePath = config.statePaths.verifyState
  const state = readState(statePath)

  // Backward compatible with an earlier format that stored a bare number.
  const previous = typeof state[key] === 'number' ? { count: state[key] } : (state[key] ?? {})

  let output = ''
  let green = false

  try {
    execSync(command, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: config.verifyTimeoutMs,
      env: { ...process.env, CLAUDE_HARNESS_GATE: '1' }
    })
    green = true
  } catch (error) {
    // A command that could not be STARTED (missing binary, bad shell) is a config problem, not a red
    // tree. Blocking the model for it is blaming the wrong party.
    if (error.code === 'ENOENT' || error.signal === 'SIGTERM') {
      process.exit(0)
    }

    output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
  }

  if (green) {
    // GREEN. The objective is met — clear the counter AND the attempt log, so the next objective starts
    // from nothing rather than inheriting a stale fingerprint.
    if (state[key]) {
      delete state[key]
      writeState(statePath, state)
      clearAttempts(config, key)
    }

    process.exit(0)
  }

  const { hash, lines } = fingerprint(output)
  const maxSameFailure = config.gates?.verifyGate?.maxSameFailure ?? 3
  const verdict = decide({ green, hash, previous, maxSameFailure })

  if (verdict.action === 'pass') process.exit(0)

  const print = output.split('\n').slice(-15).join('\n')
  const edits = recentEdits(ledgerText)

  recordAttempt(config, key, {
    at: new Date().toISOString(),
    hash,
    count: verdict.count,
    files: edits,
    failing: lines.slice(0, 4)
  })

  // ── HALT ─────────────────────────────────────────────────────────────────────
  //
  // The terminal state a two-block brake does not have. Three passes at one failure with no change in
  // it: blocking again produces variations of something that has already failed three times. Stop, write
  // down what happened, and hand back to a person.
  if (verdict.action === 'halt') {
    state[key] = { hash, count: verdict.count, halted: true }
    writeState(statePath, state)

    const report = haltReport({ hash, count: verdict.count, lines, attempts: priorAttempts(config, key) })

    try {
      mkdirSync(dirname(config.statePaths.haltReport), { recursive: true })
      writeFileSync(config.statePaths.haltReport, `${report}\n`)
    } catch {
      /* the message below still carries the essentials */
    }

    block(
      `HALT — the same failure has survived ${verdict.count} attempts and the loop is stopping.\n\n` +
        `Signature \`${hash}\`:\n${lines.slice(0, 6).join('\n')}\n\n` +
        `DO NOT attempt another fix. Tell the user plainly: the tree is red, what is failing, and what ` +
        `you tried. The full record is at \`${config.statePaths.haltReport}\`.`
    )
  }

  state[key] = { hash, count: verdict.count, halted: false }
  writeState(statePath, state)

  // ── ESCALATE ─────────────────────────────────────────────────────────────────
  //
  // Same failure again. Repeating "fix it" produces a variation of the fix that already failed, so the
  // directive changes: the KIND of fix must change, and the prior attempts are named so the model can
  // see its own history rather than rediscover it.
  if (verdict.action === 'escalate') {
    const tried = priorAttempts(config, key)
      .map(attempt => `  · ${attempt.files?.join(', ') || '(no source edits recorded)'}`)
      .join('\n')

    block(
      `SAME FAILURE, attempt ${verdict.count} of ${maxSameFailure}. The signature has not changed, so the ` +
        `last fix did not address the cause.\n\n${print}\n\n` +
        `Already tried:\n${tried || '  · (nothing recorded)'}\n\n` +
        `Change the KIND of fix, not its details: reproduce it smaller, or question an assumption you ` +
        `have not tested yet. One more repeat and this halts.`
    )
  }

  // ── FIRST SIGHT, or a DIFFERENT failure ──────────────────────────────────────
  //
  // A changed fingerprint means the last change moved the problem. That is progress, the counter resets,
  // and the reason names the next action rather than complaining.
  block(
    `\`${command}\` is red, so this turn is not complete.\n\n${print}\n\n` +
      `Next: fix the failure above, then let this gate re-run. If it turns out you cannot, say so to the ` +
      `user plainly rather than reporting success.`
  )
}

if (process.argv[1]?.endsWith('verify-gate.mjs')) main()
