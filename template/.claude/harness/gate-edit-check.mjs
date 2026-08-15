#!/usr/bin/env node
// PostToolUse on a source edit: runs a fast check at the moment the file is written.
//
// OFF UNLESS CONFIGURED. `commands.editCheck` is null by default and this exits immediately.
//
// ── WHY AN EARLIER CHECK WHEN THE CLOSING GATE ALREADY EXISTS ──────────────────
//
// `verify-gate` catches everything eventually, at the end of the turn. This catches the class of
// defect that hand edits and merges produce — an unbalanced tag, a dropped import — while the model
// still has the file in front of it, instead of three edits later when the failure has to be traced
// back.
//
// THE GUARANTEE IS UNCHANGED BY ANY SKIP BELOW. `verify-gate` runs on Stop and SubagentStop, and
// `implement-plan` gates every phase boundary. This is early warning; those are the boundary. That is
// what makes suppression safe here: a skipped check can only DEFER a check, never approve a broken
// tree.
//
// ── WHY IT MUST BE CHEAP, AND HOW ──────────────────────────────────────────────
//
// A check that runs on every edit is a check that runs many times per turn, most of them worthless.
// Measured on 269 edits in one session of the project this came from: a full project typecheck per
// edit was 2.11s each, 568s total, and two facts made most of those runs pointless.
//
//   31% of edits landed within 0.4s of another — parallel tool calls in a single message. The check
//   ran on a HALF-APPLIED refactor, reported errors the very next edit was about to fix, and blocked
//   on them.
//
//   The median gap between edits was 10.7s, so sequential edits inside one phase re-ran a whole-project
//   check that could not meaningfully have changed.
//
// Two suppressions, both of which fail SAFE:
//
//   GRACE   Before running, wait `graceMs` and re-read a sequence counter. If another edit arrived,
//           that edit's hook has the more complete tree and will run instead. Trailing-edge debounce
//           for parallel batches.
//   WINDOW  If the last run was GREEN and less than `windowMs` ago, skip. A RED result is NEVER
//           suppressed: when the tree is broken the model is iterating on the fix and needs to know
//           the moment it goes green.
//
// ── WHY IT BLOCKS RATHER THAN EXITING 2 ────────────────────────────────────────
//
// Exit 2 does not block on PostToolUse. Putting the compiler output in front of the model requires
// `{"decision":"block"}`, which is what `block()` emits.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { block, classifyProbe, isSourceFile, load, readPayload } from './config.mjs'
import { beat } from './hook-heartbeat.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const readState = path => {
  try {
    return { seq: 0, lastGreenAt: 0, ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    return { seq: 0, lastGreenAt: 0 }
  }
}

// Concurrent hooks can interleave here. A lost write costs at most one redundant run, which is the safe
// direction — it can never cause a check to be skipped that was needed.
const writeState = (path, state) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state)}\n`)
  } catch {
    /* the state file is an optimisation; losing it only means running more often */
  }
}

// Exported so the suppression logic is testable without spawning a compiler or sleeping.
export const decide = ({ mySeq, currentSeq, lastGreenAt, now, windowMs }) => {
  if (currentSeq > mySeq) return { action: 'skip', why: 'a newer edit arrived — its hook has the more complete tree' }

  if (lastGreenAt && now - lastGreenAt < windowMs) return { action: 'skip', why: 'checked green moments ago' }

  return { action: 'run' }
}

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const config = load()

  beat('gate-edit-check', payload, config)

  const settings = config.gates?.editCheck ?? {}
  const command = config.commands?.editCheck

  if (settings.enabled === false || !command) process.exit(0)

  const filePath = payload.tool_input?.file_path

  if (typeof filePath !== 'string' || !filePath) process.exit(0)

  // Which files this applies to. An explicit `paths` list wins; otherwise the project's own definition
  // of source is reused rather than inventing a second one.
  const paths = settings.paths ?? []
  const applies = paths.length > 0 ? paths.some(pattern => globMatch(pattern, filePath, config)) : isSourceFile(config, filePath)

  if (!applies) process.exit(0)

  const statePath = join(config.root ?? process.cwd(), config.statePaths.editCheckState)
  const graceMs = settings.graceMs ?? 400
  const windowMs = settings.windowMs ?? 15_000

  // Claim a sequence number. Anything that arrives after this point is newer than this hook.
  const claimed = readState(statePath)
  const mySeq = (claimed.seq ?? 0) + 1

  writeState(statePath, { ...claimed, seq: mySeq })

  const early = decide({ mySeq, currentSeq: mySeq, lastGreenAt: claimed.lastGreenAt, now: Date.now(), windowMs })

  if (early.action === 'skip') process.exit(0)

  await sleep(graceMs)

  const after = decide({ mySeq, currentSeq: readState(statePath).seq ?? 0, lastGreenAt: claimed.lastGreenAt, now: Date.now(), windowMs })

  if (after.action === 'skip') process.exit(0)

  const result = spawnSync(command, {
    shell: true,
    cwd: config.root ?? process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: config.verifyTimeoutMs
  })

  if (result.status === 0) {
    writeState(statePath, { ...readState(statePath), lastGreenAt: Date.now() })
    process.exit(0)
  }

  // A command that could not START is not a red tree, and blocking on it would block every edit
  // forever over a setup mistake — which is exactly how a gate gets ripped out. `classifyProbe` is the
  // same reader the installer uses to tell "the binary is missing" from "your tree is red", so the two
  // cannot drift apart. The selftest is where a missing command gets reported.
  const verdict = classifyProbe({
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT' || Boolean(result.signal)
  })

  if (verdict.verdict === 'missing') process.exit(0)

  // Clearing lastGreenAt is what makes the NEXT edit check immediately instead of waiting out the
  // window: a broken tree gets fast feedback, a healthy one does not.
  writeState(statePath, { ...readState(statePath), lastGreenAt: 0 })

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(0, 20).join('\n')

  block(
    `\`${command}\` failed after editing ${filePath}. Fix it before continuing.\n\n${output || '(no output)'}\n\n` +
      `This is early warning, not the closing gate — the tree still has to be green at the end of the turn.`
  )
}

// The minimal glob from config.mjs works on repo-relative paths; the payload carries absolute ones.
const globMatch = (pattern, filePath, config) => {
  const root = config.root ?? process.cwd()
  const rel = filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath

  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*/g, match => (match === '**' ? '.*' : '[^/]*'))}$`).test(
    rel.split('\\').join('/')
  )
}

if (process.argv[1]?.endsWith('gate-edit-check.mjs')) main()
