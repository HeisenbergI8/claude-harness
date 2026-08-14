#!/usr/bin/env node
// Where is this plan up to, and what is next?
//
//   node .claude/harness/next-phase.mjs <plan.md> [--json]
//
// ── EXIT CODES DECIDE; PROSE DESCRIBES ─────────────────────────────────────────
//
// The obvious way to work out phase completion is to read the implementation log. That log is prose
// written by the model — trusting it to decide whether the loop keeps going is exactly what
// `claim-check.mjs` exists to prevent, reintroduced at the most load-bearing joint in the system.
//
// So `verify-plan` is primary. The log is narrative.
//
// ── UNIT RECONCILIATION ────────────────────────────────────────────────────────
//
// The cursor thinks in PHASES; the evidence is per STEP. Steps are numbered `N.M`, so the phase is the
// prefix. A phase is `done` when every step passes, `partial` when some do, `pending` when none do —
// and that distinction is exactly what a phase-level signal cannot give you.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from './config.mjs'
import { activeRun, hashPlan } from './run-state.mjs'

// Resolve the sibling against THIS file, not the cwd. Invoked from a worktree or a test sandbox, a
// cwd-relative path silently finds nothing and the cursor reports zero phases — which reads as "no
// plan" rather than "I could not run".
const VERIFY_PLAN = join(dirname(fileURLToPath(import.meta.url)), 'verify-plan.mjs')

export const phaseTitles = markdown => {
  const titles = new Map()

  for (const line of markdown.split('\n')) {
    const match = line.match(/^###\s+Phase\s+(\d+)\s*:\s*(.+)$/)

    if (match) titles.set(match[1], match[2].trim())
  }

  return titles
}

// ── The verdict, as a pure function ────────────────────────────────────────────
//
// Exported and tested directly. The subtle rules are all here, and none of them can be exercised
// through the CLI without a real plan and a real tree.
export const summarise = (steps, titles = new Map(), weakThreshold = 0.66) => {
  const byPhase = new Map()

  for (const step of steps) {
    const phase = String(step.phase ?? step.id?.split(' ')[1]?.split('.')[0] ?? '?')
    const bucket = byPhase.get(phase) ?? []

    bucket.push(step)
    byPhase.set(phase, bucket)
  }

  const phases = [...byPhase.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([phase, list]) => {
      const passed = list.filter(step => step.verdict === 'PASS').length

      // A SKIP cannot prove completion — the step is honestly unverifiable. A BLOCK is a check that
      // never ran. Neither is a pass, and a phase containing one is `needs-human` rather than done.
      const unprovable = list.some(step => step.verdict === 'SKIP' || step.verdict === 'BLOCK')

      // Only checks that RAN count toward confidence. A SKIP already forces needs-human, and letting it
      // also count as weak would penalise the same step twice.
      const ran = list.filter(step => step.verdict === 'PASS' || step.verdict === 'FAIL')
      const weak = ran.filter(step => step.shape !== 'real').length
      const strong = ran.length - weak

      // ── THE QUIET FAILURE ────────────────────────────────────────────────────
      //
      // `needs-human` is the LOUD failure: a phase that cannot be proved, halting visibly. Closing it
      // surfaces the quiet one — a plan can be 100% verifiable and still prove almost nothing. A real
      // plan measured at 2 discriminating checks against 24 weak had ZERO unverifiable steps, so every
      // step PASSed and the cursor would advance over work nobody checked.
      //
      // A false PASS is strictly worse than a halt. A halt is loud and wrong; a false PASS is silent
      // and wrong AND moves the loop forward on it.
      //
      // PER PHASE, NOT PER PLAN. A plan-wide ratio is wrong in both directions, and the dangerous one
      // ships: a strong plan carrying one all-grep phase averages out above any threshold, and the
      // cursor walks straight through the phase nobody checked.
      const lowConfidence = ran.length > 0 && weak > ran.length * weakThreshold

      let status = 'pending'

      if (passed === list.length && list.length > 0) status = lowConfidence ? 'low-confidence' : 'done'
      else if (unprovable) status = 'needs-human'
      else if (passed > 0) status = 'partial'

      return { phase, title: titles.get(phase) ?? '', total: list.length, passed, status, strong, weak }
    })

  // `low-confidence` is treated exactly like `needs-human` by the driver. It is a separate status only
  // so the report can say which of the two it is — and they want different remedies.
  const blocked = phases.find(phase => phase.status === 'needs-human' || phase.status === 'low-confidence')
  const next = phases.find(phase => phase.status !== 'done')

  return {
    phases,
    allDone: phases.length > 0 && phases.every(phase => phase.status === 'done'),
    blockedBecause: blocked?.status ?? null,
    needsHuman: blocked ? `phase ${blocked.phase}: ${blocked.title}` : null,
    next: next ? { phase: next.phase, title: next.title, passed: next.passed, total: next.total } : null
  }
}

const stepResults = planPath => {
  let out = ''

  try {
    out = execFileSync('node', [VERIFY_PLAN, planPath, '--json'], { encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  try {
    const parsed = JSON.parse(out.trim().split('\n').pop())

    return {
      steps: parsed.steps.map(step => ({ ...step, phase: step.id.split(' ')[1]?.split('.')[0] })),
      tally: parsed.tally,
      unterminatedFence: parsed.unterminatedFence
    }
  } catch {
    return { steps: [], tally: { discriminating: 0, weak: 0 }, unterminatedFence: false }
  }
}

const main = () => {
  const planPath = process.argv[2]
  const asJson = process.argv.includes('--json')

  if (!planPath) {
    console.error('usage: next-phase.mjs <plan.md> [--json]')
    process.exit(2)
  }

  const config = load()

  let markdown = ''

  try {
    markdown = readFileSync(planPath, 'utf8')
  } catch {
    console.error(`cannot read ${planPath}`)
    process.exit(2)
  }

  // ── PLAN DRIFT ───────────────────────────────────────────────────────────────
  //
  // The run records the plan's hash at start. If the document changed since, every phase number, step
  // id and check below describes a plan that is no longer the one on disk — the cursor is a map of
  // somewhere else. Renumbering one phase is enough to make "continue from phase 4" mean something
  // different than it did when the run began.
  //
  // This HALTS rather than warns, and deliberately does not try to work out whether the edit was
  // harmless. Distinguishing a typo fix from a resequenced phase is exactly the judgement a loop should
  // not make unsupervised, and a human re-reading the plan costs a minute.
  const run = activeRun(process.env.CLAUDE_SESSION_ID, config)
  const drift = (() => {
    if (!run?.planHash || !run.planPath) return null

    const current = hashPlan(run.planPath)

    return current && current !== run.planHash ? { was: run.planHash, now: current } : null
  })()

  const { steps, tally, unterminatedFence } = stepResults(planPath)
  const verdict = summarise(steps, phaseTitles(markdown), config.plan?.weakPhaseThreshold ?? 0.66)

  const out = {
    planPath,
    ...verdict,
    allDone: drift || unterminatedFence ? false : verdict.allDone,
    blockedBecause: drift ? 'plan-changed' : unterminatedFence ? 'unterminated-fence' : verdict.blockedBecause,
    needsHuman: drift ? 'plan changed mid-run' : unterminatedFence ? 'unterminated code fence' : verdict.needsHuman,
    planDrift: drift,
    quality: tally
  }

  if (asJson) {
    console.log(JSON.stringify(out))
    process.exit(out.allDone ? 0 : 1)
  }

  // Printed BEFORE the phase table, because the table below it is the thing that cannot be trusted.
  if (drift) {
    console.log(
      `PLAN CHANGED MID-RUN — the document was edited after this run started.\n` +
        `  recorded ${drift.was} · on disk ${drift.now}\n` +
        `  Every phase and step id below refers to the plan as it was. Re-read it, then start a new run.\n`
    )
  }

  for (const phase of out.phases) {
    console.log(`  ${phase.status.padEnd(14)} phase ${phase.phase}  ${phase.passed}/${phase.total}  ${phase.title}`)
  }

  if (out.blockedBecause === 'low-confidence') {
    // The two statuses want different remedies, and offering the wrong one first is how a run gets
    // waved through. `needs-human` is a statement about the WORK — a person must look. `low-confidence`
    // is a statement about the PLAN — the checks are too weak to prove anything, so the first move is
    // to strengthen them. Approving here would record agreement that a phase is unproven.
    console.log(
      `\nLOW CONFIDENCE — ${out.needsHuman} passes, but too few of its checks can fail. Passing proves little.\n` +
        `  FIRST: strengthen the checks — a command that RUNS something, not a grep for a token the step types.\n` +
        `  ONLY THEN: approve, which records that you accept this phase as unproven.`
    )
  } else if (out.blockedBecause === 'needs-human') {
    console.log(`\nNEEDS HUMAN — ${out.needsHuman} has a step no command can prove.\n  Look at the step, then approve it by id with a reason.`)
  } else if (out.allDone) {
    console.log('\nALL PHASES DONE')
  } else if (out.next) {
    console.log(`\nNEXT — phase ${out.next.phase}: ${out.next.title} (${out.next.passed}/${out.next.total} steps passing)`)
  } else {
    console.log('\nNo phases found — is this a plan document?')
  }

  process.exit(out.allDone ? 0 : 1)
}

if (process.argv[1]?.endsWith('next-phase.mjs')) main()
