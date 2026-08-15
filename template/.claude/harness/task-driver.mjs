#!/usr/bin/env node
// The task loop's driver. Registered on `Stop`, and on nothing else.
//
// A blocking Stop hook re-invokes the model with `reason` as feedback. That is the iteration primitive
// this whole loop is built on: CODE DECIDES WHETHER TO CONTINUE AND WHAT IS NEXT, THE MODEL DOES THE
// WORK.
//
//   node .claude/harness/task-driver.mjs            reads a hook payload on stdin
//   node .claude/harness/task-driver.mjs --status    what the driver would do, and whether it beats
//   node .claude/harness/task-driver.mjs --decide <state.json> [--signals <s.json>] [--red]
//
// ── STOP ONLY, NEVER SubagentStop ──────────────────────────────────────────────
//
// The verify gate is registered on both, and the pipeline runs a tester and an auditor CONCURRENTLY. A
// driver wired the same way would increment the iteration counter on every subagent completion — twice,
// from two processes, racing. The repair loop survives that because it keys on session:agent; the
// driver has no such key, so it is not given the chance.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { block, load, readPayload } from './config.mjs'
import { beat, foldBeats } from './hook-heartbeat.mjs'
import { hasIterationChecks, preflight } from './preflight.mjs'
import { activeRun, describeAttempts, halt, hashPlan, haltReportPath, update } from './run-state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const run = (file, args, options = {}) => {
  try {
    return { ok: true, out: execFileSync(file, args, { stdio: 'pipe', encoding: 'utf8', ...options }) }
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`, code: error.status ?? 1 }
  }
}

// ── The expensive-signal cache ─────────────────────────────────────────────────
//
// Both the stuck check and the goal check need verify-plan, which executes ONE COMMAND PER STEP. Thirty
// steps means thirty executions on every Stop. Keyed on (planHash, tree hash): the answer can only
// change when the plan or the tree moves.
const treeHash = () => {
  const written = run('git', ['write-tree'])

  if (written.ok) return written.out.trim().slice(0, 12)

  // Not a git tree, or an index that cannot be written. A constant would make the cache permanently
  // valid; a unique value makes it never valid — slow, but never wrong.
  return `nogit-${Date.now()}`
}

const cachedSignals = (config, state) => {
  const planHash = hashPlan(state.planPath)
  const key = `${planHash}:${treeHash()}`
  const cachePath = join(config.statePaths.runs, state.runId, 'signals.json')

  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))

    if (cached.key === key) return cached.value
  } catch {
    /* no cache yet — recompute */
  }

  const cursor = run('node', [join(HERE, 'next-phase.mjs'), state.planPath, '--json'])

  let verdict = null

  try {
    verdict = JSON.parse(cursor.out.trim().split('\n').pop())
  } catch {
    verdict = null
  }

  const value = {
    verdict,
    goalDone: run('node', [join(HERE, 'goal-check.mjs'), state.planPath, '--quiet']).ok,
    // --strict exits 2 specifically for "this plan cannot be trusted to tell you when a step failed".
    // Distinct from exit 1, which merely means a step failed.
    unfalsifiable: run('node', [join(HERE, 'verify-plan.mjs'), state.planPath, '--strict']).code === 2
  }

  try {
    writeFileSync(cachePath, `${JSON.stringify({ key, value }, null, 2)}\n`)
  } catch {
    /* the cache is an optimisation, not a dependency */
  }

  return value
}

// ── The decision ───────────────────────────────────────────────────────────────
//
// TWO EVALUATIONS, NOT ONE ORDERED LIST.
//
// The obvious implementation is a single list with `tree red -> release` above the halt conditions.
// That SILENTLY ABANDONS RUNS. A run that is red AND stuck — or red and plan-drifted — releases every
// turn, forever: the repair loop eventually steps aside, the tree stays red, the driver keeps
// releasing, the pointer stays active, and NO HALT REPORT IS EVER WRITTEN. You come back to a run that
// looks like it just stopped, with nothing saying why.
//
// It also makes the termination property vacuous. Releases do not increment `iteration`, so a
// perpetually-red run burns zero budget and exhaustion is unreachable. "Budget exhaustion always
// reaches HALT" is trivially true when exhaustion cannot happen.
//
// So: HALT CHECKS RUN UNCONDITIONALLY, with tree state irrelevant. Only if none fire does the drive
// check look at whether the tree is red.
export const decide = (state, { payload = {}, signals = null, treeGreen = true, now = Date.now(), config = null, preflight = null } = {}) => {
  // FAST PATH. Every ordinary turn has no active run, and this runs on every Stop forever.
  if (!state) return { action: 'release', why: 'no active run' }
  if (payload.stop_hook_active === true) return { action: 'release', why: 'stop hook already active' }

  const loop = config?.taskLoop ?? {}
  const budget = { ...(loop.budget ?? {}), ...(state.budget ?? {}) }
  const phaseStuckAt = loop.phaseStuckAt ?? 3
  const redCeiling = loop.redCeiling ?? 4
  const planlessCeiling = loop.planlessCeiling ?? 3
  const preflightCeiling = config?.preflight?.maxConsecutiveFailures ?? 2

  const haltIf = (condition, why) => (condition ? { action: 'halt', why } : null)

  const startedAt = Date.parse(state.startedAt ?? 0)
  const beatAt = Date.parse(state.lastBeatAt ?? 0)

  const halted = [
    haltIf(state.iteration >= budget.iterations, `iteration budget spent (${budget.iterations}) — resume in a fresh session`),
    haltIf(Number.isFinite(startedAt) && now - startedAt > budget.runMs, 'run wall-clock budget spent'),
    haltIf(Number.isFinite(beatAt) && now - beatAt > budget.iterationMs, 'iteration wall-clock budget spent'),
    haltIf(state.spawns >= budget.spawns, `subagent spawn budget spent (${budget.spawns})`),
    haltIf(signals?.verdict?.blockedBecause === 'plan-changed', 'plan changed mid-run'),
    haltIf(signals?.verdict?.blockedBecause === 'unterminated-fence', 'the plan has an unterminated code fence'),
    haltIf(signals?.unfalsifiable === true, 'plan is unfalsifiable — its checks cannot fail'),
    haltIf(state.phaseIteration >= phaseStuckAt, `phase stuck: ${phaseStuckAt} iterations with no new step passing`),
    haltIf(state.redIterations >= redCeiling, `tree red for ${redCeiling} iterations — the repair loop did not converge`),
    haltIf(
      signals?.verdict?.blockedBecause === 'needs-human' || signals?.verdict?.blockedBecause === 'low-confidence',
      `${signals?.verdict?.blockedBecause}: ${signals?.verdict?.needsHuman ?? 'a phase cannot be proved'}`
    ),
    haltIf(
      !state.planPath && (state.planlessIterations ?? 0) >= planlessCeiling,
      `no plan bound after ${planlessCeiling} turns — the loop cannot drive work it cannot measure. ` +
        'Bind one with `run-state.mjs plan <path>`, or this is not work the loop can drive.'
    ),
    // An entry condition that stopped holding mid-run. Counted rather than immediate: one flaky
    // response is not evidence a dependency is down, and killing a four-hour run over a dropped
    // connection is its own failure. The count is in the run record because this file is the only
    // place that can see history — preflight itself answers only "is it healthy right now".
    haltIf(
      preflight && !preflight.ok && (preflight.failures ?? 1) >= preflightCeiling,
      `precondition failed ${preflightCeiling} times in a row — ${preflight?.reason ?? 'reason not recorded'}`
    ),
    haltIf(signals?.goalDone === true, 'done')
  ].find(Boolean)

  if (halted) return { ...halted, success: halted.why === 'done' }

  // DRIVE CHECK — only reached when no halt fired.
  if (state.paused) return { action: 'release', why: 'run paused by the user' }

  // The repair loop owns a red tree. Standing down here is correct whether or not an earlier hook's
  // block short-circuits later ones — designing on an unverified ordering assumption is how these bugs
  // get made.
  if (!treeGreen) return { action: 'release', why: 'tree red — the repair loop owns it', red: true }

  // Stand aside while the plan is written, but COUNT the turns. The halt check above turns that
  // patience into a bounded number rather than an indefinite one — a driver with no plan releases
  // forever, which is indistinguishable from working correctly.
  if (!state.planPath) return { action: 'release', why: 'no plan bound yet — planning in progress', planless: true }

  return { action: 'drive', why: 'next phase', next: signals?.verdict?.next ?? null }
}

// ── The halt report ────────────────────────────────────────────────────────────
//
// A halt must not brick the next run. The loop STAGES and does not commit, so a run halting mid-phase
// leaves a dirty tree — and if anything refuses to start on a dirty tree, ONE BAD HALT BLOCKS EVERY
// FUTURE RUN until someone cleans up by hand.
//
// So the report carries a diff summary against `baseSha` and two explicit paths, resume or abandon,
// with the exact commands for each.
export const haltReport = (state, why, { diff = '', working = '', attempts = '' } = {}) =>
  [
    `# Run halted — ${why}`,
    '',
    `**Run:** \`${state.runId}\``,
    `**Objective:** ${state.objective ?? '(none recorded)'}`,
    `**Started:** ${state.startedAt ?? '?'}`,
    `**Iterations:** ${state.iteration ?? 0} · **spawns:** ${state.spawns ?? 0}`,
    `**Base commit:** \`${state.baseSha ?? '(not recorded)'}\``,
    '',
    '## What changed',
    '',
    '```',
    (diff || '(no committed changes)').trim(),
    '```',
    '',
    '### Uncommitted, in the working tree',
    '',
    '```',
    (working || '(clean)').trim(),
    '```',
    '',
    '## Two ways out',
    '',
    'This run left the working tree as it is. It is NOT committed and NOT reverted — the loop stages,',
    'you decide.',
    '',
    '**Resume this work** — keep the changes and continue:',
    '',
    '```bash',
    '# see what state it is actually in, then:',
    `/build --resume          # picks up from phase ${state.phaseCursor?.phase ?? '?'}`,
    '```',
    '',
    '**Abandon this work** — discard everything the run touched:',
    '',
    '```bash',
    'git diff                 # READ THIS FIRST — the run may have made changes worth keeping',
    `git stash push -m "abandoned run ${state.runId ?? ''}"`,
    '```',
    '',
    '`git stash`, not `git checkout -- .` — a stash is recoverable, and `guard-destructive` blocks the',
    'destructive forms anyway.',
    '',
    '## Attempts',
    '',
    attempts || '  (none recorded)',
    ''
  ].join('\n')

// ── The block reason — this is the context the next iteration gets ─────────────
//
// Not a complaint. The reason IS the next action, plus what has already been tried, so the model can
// read its own failed hypotheses instead of reproducing them.
const driveReason = (state, signals, config) => {
  const next = signals?.verdict?.next
  const attempts = describeAttempts(state.runId, config)
  const budget = { ...(config.taskLoop?.budget ?? {}), ...(state.budget ?? {}) }

  return [
    `TASK LOOP — iteration ${(state.iteration ?? 0) + 1} of ${budget.iterations}.`,
    '',
    `Objective: ${state.objective ?? '(none recorded)'}`,
    state.planPath ? `Plan: ${state.planPath}` : '',
    '',
    next
      ? `NEXT — phase ${next.phase}: ${next.title} (${next.passed}/${next.total} steps passing).`
      : 'NEXT — no incomplete phase reported; re-read the plan and the cursor.',
    '',
    'Continue that phase now. Follow the `implement-plan` skill: implement, gate with the project\'s fast',
    'verify command, then append to `implementation-log.md`. Do not start a later phase.',
    attempts ? `\nAlready tried in this run — do not repeat these:\n${attempts}` : '',
    '',
    'Stop and report instead of continuing if: the plan is wrong, a contract differs from what it',
    'assumed, or you have failed the same gate three times.'
  ]
    .filter(line => line !== '')
    .join('\n')
}

const main = async () => {
  const config = load()

  if (process.argv.includes('--decide')) {
    const read = flag => {
      const at = process.argv.indexOf(flag)

      return at === -1 ? null : JSON.parse(readFileSync(process.argv[at + 1], 'utf8'))
    }

    const state = read('--decide')
    const nowAt = process.argv.indexOf('--now')

    console.log(
      JSON.stringify(
        decide(state?.runId ? state : null, {
          payload: read('--payload') ?? {},
          signals: read('--signals'),
          treeGreen: !process.argv.includes('--red'),
          now: nowAt === -1 ? Date.now() : Number(process.argv[nowAt + 1]),
          config
        })
      )
    )
    process.exit(0)
  }

  if (process.argv.includes('--status')) {
    const state = activeRun(process.env.CLAUDE_SESSION_ID, config)

    // SOMETHING MUST READ THE ABSENCE. A driver that never fires never beats, and nothing notices — the
    // loop simply does not start and looks like nothing happened.
    let last = null

    try {
      last = foldBeats(readFileSync(config.statePaths.heartbeatLog, 'utf8')).hooks['task-driver'] ?? null
    } catch {
      last = null
    }

    console.log(`  driver last beat: ${last?.last ?? 'never'}${last ? ` (fired ${last.fired}x)` : ''}`)
    console.log(state ? `  active run: ${state.runId} — iteration ${state.iteration}` : '  no active run')
    process.exit(0)
  }

  const payload = await readPayload()

  // An unparseable payload must RELEASE. Blocking on it would trap every turn in the repo behind a bug
  // in the driver's own input handling.
  if (!payload) process.exit(0)

  beat('task-driver', payload, config)

  if (config.taskLoop?.enabled === false) process.exit(0)

  const state = activeRun(payload.session_id ?? process.env.CLAUDE_SESSION_ID, config)

  // Fast path, before any expensive signal is computed.
  if (decide(state, { payload, config }).action === 'release') process.exit(0)

  const treeGreen = config.commands.verifyFast
    ? run(process.env.SHELL || '/bin/sh', ['-c', config.commands.verifyFast], { timeout: config.verifyTimeoutMs }).ok
    : true

  // Entry conditions that can stop holding mid-run — a dependency that went away, a toolchain check
  // that started failing. Costs nothing unless the project configured something to watch, because the
  // default lists are empty and `hasIterationChecks` is then false.
  //
  // `cleanTree` is deliberately NOT re-checked here: by iteration two the loop has been editing on
  // purpose, so a dirty tree is the expected state rather than a fault.
  const checked = hasIterationChecks(config) ? await preflight({ config, scope: 'iteration' }) : null
  const failures = checked ? (checked.ok ? 0 : (state.preflightFailures ?? 0) + 1) : (state.preflightFailures ?? 0)

  if (checked) update(state.runId, { preflightFailures: failures }, config)

  const signals = state.planPath ? cachedSignals(config, state) : null
  const verdict = decide(state, { payload, signals, treeGreen, config, preflight: checked && { ...checked, failures } })

  if (verdict.action === 'halt') {
    const report = haltReport(state, verdict.why, {
      diff: state.baseSha ? run('git', ['diff', '--stat', `${state.baseSha}..HEAD`]).out : '',
      working: run('git', ['status', '--porcelain', '--untracked-files=no']).out,
      attempts: describeAttempts(state.runId, config)
    })

    halt(state.runId, verdict.why, report, config)

    // LOUD, not just written. A report nobody reads is a loop that stopped an hour ago without telling
    // anyone — so the halt also blocks once, and the model's next act is to tell the user.
    block(
      `TASK LOOP HALTED — ${verdict.why}\n\n` +
        `Report: ${haltReportPath(config, state.runId)}\n\n` +
        `The run is over and will not restart. Read the report and tell the user what happened, what ` +
        `changed, and which of the two paths it lists you recommend. Do not start another run.`
    )
  }

  if (verdict.action === 'release') {
    // A red release still costs budget, or a perpetually-red run never terminates. Same for a planless
    // one: patience has to be counted or it is indistinguishable from a stall.
    if (verdict.red) update(state.runId, { redIterations: (state.redIterations ?? 0) + 1 }, config)
    if (verdict.planless) update(state.runId, { planlessIterations: (state.planlessIterations ?? 0) + 1 }, config)

    process.exit(0)
  }

  const advanced = signals?.verdict?.next?.passed ?? -1
  const samePhase = state.phaseCursor?.phase === signals?.verdict?.next?.phase
  const noProgress = samePhase && state.phaseCursor?.passed === advanced

  update(
    state.runId,
    {
      iteration: (state.iteration ?? 0) + 1,
      // PROGRESS, NOT ATTEMPTS — the same principle the repair loop runs on. A phase that produced a
      // new step PASS is converging, and resetting the counter stops the driver punishing a run that is
      // working.
      phaseIteration: noProgress ? (state.phaseIteration ?? 0) + 1 : 0,
      redIterations: 0,
      phaseCursor: signals?.verdict?.next ?? null
    },
    config
  )

  block(driveReason(state, signals, config))
}

if (process.argv[1]?.endsWith('task-driver.mjs')) main()
