#!/usr/bin/env node
// `/build` — the task loop's entry point, and the pause that keeps it out of the user's way.
//
// Registered on `UserPromptSubmit`. Reads the prompt, and:
//
//   /build <label>                        creates the run record ITSELF
//   /build --status | --halt | --resume   steers a live run
//   anything else, while a run is live    pauses the run
//
// ── A SKILL IS INSTRUCTIONS; THIS IS A MECHANISM ───────────────────────────────
//
// If the model is merely TOLD to create a run record and does not, there is no run — and the driver
// releases forever, which is INDISTINGUISHABLE FROM WORKING CORRECTLY. That is the
// directive-not-mechanism failure appearing at the loop's entry point, where it is least visible.
//
// So the hook writes the state. The skill carries only the narrative and the sizing judgement.
//
// ── WHY A USER MESSAGE PAUSES ──────────────────────────────────────────────────
//
// Stated rather than left implicit: a user message PAUSES the run, it does not amend the objective.
// The loop advances only while the user is silent. The alternative — a loop that reinterprets its goal
// from conversation — is how a run quietly becomes something nobody asked for.

import { load } from './config.mjs'
import { activeRun, halt, init, update } from './run-state.mjs'

// `/build*` is exempt from the pause, or the pause fires on the very message meant to clear it:
// `--resume` is itself a user prompt, and whether it worked would depend on hook-versus-skill ordering
// within the turn. Not something to leave to chance.
export const isBuildCommand = prompt => /^\s*\/build\b/.test(prompt ?? '')

export const parseBuild = prompt => {
  const text = (prompt ?? '').trim()

  if (!isBuildCommand(text)) return null

  const args = text.replace(/^\s*\/build\b/, '').trim().split(/\s+/).filter(Boolean)
  const flag = name => args.includes(`--${name}`)
  const value = name => {
    const at = args.indexOf(`--${name}`)

    return at === -1 ? null : (args[at + 1] ?? null)
  }

  return {
    status: flag('status'),
    halt: flag('halt'),
    resume: flag('resume'),
    plan: value('plan'),
    // The first non-flag token that is not a flag's VALUE. `--plan x.md build-thing` must not read
    // `x.md` as the label.
    label: args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--')) ?? null
  }
}

const emit = context => {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`
  )
  process.exit(0)
}

const readStdin = async () => {
  const chunks = []

  for await (const chunk of process.stdin) chunks.push(chunk)

  return Buffer.concat(chunks).toString('utf8')
}

const main = async () => {
  let payload = {}

  try {
    payload = JSON.parse(await readStdin())
  } catch {
    process.exit(0)
  }

  const config = load()

  if (config.taskLoop?.enabled === false) process.exit(0)

  const prompt = payload.prompt ?? ''
  const sessionId = payload.session_id ?? process.env.CLAUDE_SESSION_ID
  const existing = activeRun(sessionId, config)

  if (!isBuildCommand(prompt)) {
    // Any other user message pauses a live run. Silent when there is no run, which is every ordinary
    // turn.
    if (existing && !existing.paused) update(existing.runId, { paused: true }, config)

    process.exit(0)
  }

  const parsed = parseBuild(prompt)

  if (parsed.status) {
    if (!existing) emit('TASK LOOP: no active run.')

    emit(
      `TASK LOOP STATUS\n` +
        `  run: ${existing.runId}\n` +
        `  objective: ${existing.objective}\n` +
        `  plan: ${existing.planPath ?? '(none bound)'}\n` +
        `  iteration ${existing.iteration}/${existing.budget?.iterations ?? '?'} · spawns ${existing.spawns}\n` +
        `  paused: ${existing.paused}\n\n` +
        `This run claims EXCLUSIVE OWNERSHIP of the working tree. Do not start editing while it is live.`
    )
  }

  if (parsed.halt) {
    if (!existing) emit('TASK LOOP: no active run to halt.')

    halt(existing.runId, 'halted by the user', '', config)
    emit(`TASK LOOP: run ${existing.runId} halted at the user's request. Tell the user it is stopped.`)
  }

  if (parsed.resume) {
    if (!existing) emit('TASK LOOP: no active run to resume. Start one with `/build <label>`.')

    update(existing.runId, { paused: false }, config)
    emit(
      `TASK LOOP RESUMED — ${existing.objective}\n` +
        `Continue from phase ${existing.phaseCursor?.phase ?? '(re-read the cursor)'}. The phase may be ` +
        `PARTIALLY implemented — check what actually landed before writing anything.`
    )
  }

  if (!parsed.label) emit('TASK LOOP: `/build <label> [--plan <path>]` — what should this run be called?')

  if (existing) {
    emit(
      `TASK LOOP: run ${existing.runId} is already active for "${existing.objective}". ` +
        `Use \`/build --status\`, \`/build --halt\`, or \`/build --resume\`. Tell the user; start nothing.`
    )
  }

  const created = init({ objective: `Build ${parsed.label}`, label: parsed.label, planPath: parsed.plan, sessionId }, config)

  emit(
    `TASK LOOP STARTED — run ${created.runId}\n` +
      `  objective: ${created.objective}\n` +
      `  plan: ${created.planPath ?? '(none yet)'}\n\n` +
      // ── THE LOOP CAN ONLY DRIVE PLANNED WORK ────────────────────────────────
      //
      // Not a limitation to work around — a consequence of what the cursor reads. It advances through
      // `#### Step N.M` headings in a plan document, so work with no plan has no phases and nothing to
      // drive. The driver halts such a run after a few turns rather than releasing forever, because a
      // run that appeared to start and drove nothing would look exactly like the loop working.
      (created.planPath
        ? `Work phase by phase from the plan.`
        : `SIZE THE TASK FIRST. This loop drives a PLAN — if this work does not warrant one, say so and ` +
          `do it directly instead of starting a run that has nothing to advance through.\n\n` +
          `If it does: produce the plan, then bind it with ` +
          `\`node .claude/harness/run-state.mjs plan <path>\`. The loop halts if nothing is bound within ` +
          `a few turns.`) +
      `\n\nThe driver will re-invoke you after each turn until the plan is done or a cap is hit. ` +
      `This run claims exclusive ownership of the working tree.`
  )
}

if (process.argv[1]?.endsWith('build-trigger.mjs')) main()
