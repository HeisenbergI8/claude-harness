#!/usr/bin/env node
// Answers one question: is this harness actually working, or is it merely installed?
//
// Those are different states and they look identical from the outside. A hook can be registered in
// settings.json, be schema-valid, and never fire. A config can parse and describe commands that do not
// exist. An evidence pattern can be present and match nothing your project ever runs — in which case
// `claim-check` sees no runs and blocks honest turns.
//
// Wire this into your own verify command so the harness is checked by the same gate it enforces:
//
//   "verify": "... && node .claude/harness/selftest.mjs"
//
// Exit codes:  0 = healthy (warnings allowed)   1 = something is wrong and gates are degraded

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { classifyCommand, load } from './config.mjs'
import { INSTRUMENTED, foldBeats, readRegisteredHooks, silentHooks } from './hook-heartbeat.mjs'

const SCRIPTS = ['config.mjs', 'record-activity.mjs', 'claim-check.mjs', 'verify-gate.mjs', 'loop-breaker.mjs', 'hook-heartbeat.mjs']

const problems = []
const warnings = []
const notes = []

const config = load()
const root = config.root ?? process.cwd()

// ── 1. Config ──────────────────────────────────────────────────────────────────

if (!config.path) {
  warnings.push('no harness.config.json found — running on defaults, and the repair loop is inert')
} else {
  notes.push(`config: ${config.path.replace(`${root}/`, '')}`)
}

for (const error of config.errors) problems.push(`config: ${error}`)
for (const warning of config.warnings) warnings.push(`config: ${warning}`)

// The config belongs in version control. A definition of "verified" that can be widened without showing
// up in a diff is not a gate, it is a suggestion — so this is a warning, not a nicety.
if (config.path?.includes('/.claude/')) {
  warnings.push(
    'config lives under .claude/, which is gitignored in many projects. If yours ignores it, move the ' +
      'file to the repo root so changes to your gate definitions appear in a diff.'
  )
}

// ── 2. Scripts present ─────────────────────────────────────────────────────────

for (const script of SCRIPTS) {
  if (!existsSync(join(root, '.claude/harness', script))) problems.push(`missing script: .claude/harness/${script}`)
}

// ── 3. Commands ────────────────────────────────────────────────────────────────

if (!config.commands.verify && !config.commands.verifyFast) {
  warnings.push('no verify command declared — verify-gate.mjs will stand aside on every turn')
} else {
  notes.push(`verify:      ${config.commands.verify ?? '(unset)'}`)
  notes.push(`verify:fast: ${config.commands.verifyFast ?? '(unset)'}`)
}

// A declared command that the ledger cannot recognise is the quietest failure here: the command runs,
// nothing is recorded, and `claim-check` concludes no verification happened — blocking a turn that did
// everything right.
//
// Declared commands are normally recognised automatically, because `buildEvidencePatterns` derives a
// pattern from each one. The case that still slips through is a command whose leading binary is a TEXT
// TOOL — `"verify": "echo done"` — which classification drops on purpose, since talking about a command
// is not running one. That exemption is correct, and it makes such a command permanently invisible.
for (const [name, command] of Object.entries(config.commands)) {
  if (!command) continue

  if (!classifyCommand(config, command)) {
    problems.push(
      `commands.${name} ("${command}") is not recognisable as a verification run, so running it records ` +
        `NOTHING in the ledger and claim-check will block honest turns. This usually means the command ` +
        `starts with a text tool (echo, grep, cat), which is deliberately never counted as evidence.`
    )
  }
}

// Two distinct commands that classify the same way cannot be told apart downstream — "still working" and
// "wrapping up" collapse into one signal. Not fatal, but it silently removes a distinction the ledger is
// supposed to preserve.
if (
  config.commands.verify &&
  config.commands.verifyFast &&
  config.commands.verify !== config.commands.verifyFast &&
  classifyCommand(config, config.commands.verify) === classifyCommand(config, config.commands.verifyFast)
) {
  warnings.push(
    'commands.verify and commands.verifyFast are different commands that classify identically, so the ' +
      'ledger cannot distinguish a mid-task check from the closing gate.'
  )
}

// ── 4. Hook registration ───────────────────────────────────────────────────────

const settingsPath = join(root, '.claude/settings.json')
let settings = null

if (!existsSync(settingsPath)) {
  problems.push('no .claude/settings.json — no hook is registered, so no gate runs at all')
} else {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch (error) {
    problems.push(`.claude/settings.json is not valid JSON: ${error.message}`)
  }
}

if (settings) {
  const registered = readRegisteredHooks(settings)

  if (!registered.length) problems.push('.claude/settings.json registers no hooks')

  // A hook pointing at a script that does not exist fails silently on every turn.
  for (const hook of registered) {
    const candidate = join(root, '.claude/harness', `${hook.name}.mjs`)

    if (hook.name && !existsSync(candidate) && SCRIPTS.includes(`${hook.name}.mjs`)) {
      problems.push(`settings.json registers ${hook.name} but .claude/harness/${hook.name}.mjs is missing`)
    }
  }

  notes.push(`hooks registered: ${[...new Set(registered.map(hook => `${hook.name}@${hook.event}`))].join(', ')}`)

  // ── 5. Liveness ──────────────────────────────────────────────────────────────
  //
  // The check this file exists for. "Configured" and "firing" are different states, and only one of them
  // protects anything.
  let seen = {}

  try {
    seen = foldBeats(readFileSync(join(root, config.statePaths.heartbeatLog), 'utf8')).hooks
  } catch {
    /* no heartbeat yet is expected on a fresh install */
  }

  const fired = Object.keys(seen)

  if (!fired.length) {
    warnings.push('no hook has fired yet — run one turn, then re-run this selftest before trusting any gate')
  } else {
    for (const [name, entry] of Object.entries(seen)) {
      notes.push(`  ${name}: fired ${entry.fired}x on ${entry.event}, last ${entry.last}`)
    }

    const silent = silentHooks(registered, seen, INSTRUMENTED)

    if (silent.length) {
      problems.push(
        `registered but NEVER fired: ${[...new Set(silent.map(hook => hook.name))].join(', ')} — ` +
          `a hook that does not fire looks exactly like a hook with nothing to do. Restart the session ` +
          `after editing settings.json, then re-check.`
      )
    }
  }
}

// ── 6. State directory ─────────────────────────────────────────────────────────

const ledgerPath = join(root, config.statePaths.ledger)

if (existsSync(ledgerPath)) {
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).length
  const age = Math.round((Date.now() - statSync(ledgerPath).mtimeMs) / 1000)

  notes.push(`ledger: ${lines} event(s), last written ${age}s ago`)
} else {
  warnings.push('ledger is empty — record-activity has not written anything yet')
}

// ── Report ─────────────────────────────────────────────────────────────────────

const quiet = process.argv.includes('--quiet')

if (!quiet) {
  for (const note of notes) console.log(`- ${note}`)
}

for (const warning of warnings) console.log(`- WARN  ${warning}`)
for (const problem of problems) console.log(`- FAIL  ${problem}`)

if (problems.length) {
  console.log(`\nharness selftest: ${problems.length} problem(s). Gates are degraded until these are fixed.`)
  process.exit(1)
}

console.log(`- harness selftest: ok${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)
process.exit(0)
