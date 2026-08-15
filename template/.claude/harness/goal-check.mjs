#!/usr/bin/env node
// One exit code for "is this plan finished".
//
//   node .claude/harness/goal-check.mjs <plan-dir-or-file>
//
// Exit 0 means every phase passed, the tree is green, and an implementation log exists.
//
// ── EVERY ONE OF THOSE IS A PROXY ──────────────────────────────────────────────
//
// This is the only signal that can end a task-loop run SUCCESSFULLY, which makes it the most dangerous
// thing in the harness. Read the list again:
//
//   · every step's check passed        — the checks may be weak (see verify-plan's shape classifier)
//   · the tree is green                — says nothing about whether the feature works
//   · an implementation log exists     — it is prose; it proves someone wrote prose
//
// There is no screenshot check. There is no human. A run that halts reporting `done` means THE MACHINE
// IS SATISFIED, and every one of those conditions can be true while the work is wrong.
//
// Saying so here, in the file that emits the success, is deliberate. A proxy you know is a proxy is a
// tool; a proxy you have forgotten is a proxy is a lie.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from './config.mjs'

const NEXT_PHASE = join(dirname(fileURLToPath(import.meta.url)), 'next-phase.mjs')

// Accepts either the plan directory or the plan document, because both are natural to type and getting
// it wrong should not read as "not done".
export const resolvePlan = target => {
  if (!existsSync(target)) return null
  if (statSync(target).isFile()) return { file: target, dir: dirname(target) }

  const candidates = readdirSync(target).filter(name => name.endsWith('.md') && !name.startsWith('implementation-log'))

  // The plan document is named after its directory. Fall back to the only markdown file if not.
  const named = candidates.find(name => name === `${basename(target)}.md`)
  const file = named ?? (candidates.length === 1 ? candidates[0] : null)

  return file ? { file: join(target, file), dir: target } : null
}

const main = () => {
  const target = process.argv[2]
  const quiet = process.argv.includes('--quiet')

  if (!target) {
    console.error('usage: goal-check.mjs <plan-dir-or-file>')
    process.exit(2)
  }

  const plan = resolvePlan(target)

  if (!plan) {
    if (!quiet) console.log(`goal: cannot find a plan document at ${target}`)
    process.exit(2)
  }

  const config = load()
  const reasons = []

  // 1. Every phase done.
  let cursor = null

  try {
    cursor = JSON.parse(execFileSync('node', [NEXT_PHASE, plan.file, '--json'], { encoding: 'utf8', stdio: 'pipe' }).trim())
  } catch (error) {
    try {
      cursor = JSON.parse(`${error.stdout ?? ''}`.trim().split('\n').pop())
    } catch {
      cursor = null
    }
  }

  if (!cursor) reasons.push('the phase cursor could not be read')
  else if (!cursor.allDone) {
    reasons.push(
      cursor.blockedBecause
        ? `${cursor.blockedBecause}: ${cursor.needsHuman}`
        : `phase ${cursor.next?.phase ?? '?'} is incomplete (${cursor.next?.passed ?? 0}/${cursor.next?.total ?? '?'} steps)`
    )
  }

  // 2. The tree is green.
  if (config.commands.verifyFast) {
    try {
      execFileSync(process.env.SHELL || '/bin/sh', ['-c', config.commands.verifyFast], {
        stdio: 'pipe',
        timeout: config.verifyTimeoutMs
      })
    } catch {
      reasons.push(`\`${config.commands.verifyFast}\` is red`)
    }
  }

  // 3. An implementation log exists.
  //
  // The weakest of the three, and included anyway: a plan implemented with no record of what was
  // actually done leaves an auditor nothing to trace. Its ABSENCE is meaningful; its presence proves
  // only that prose was written.
  if (!existsSync(join(plan.dir, 'implementation-log.md'))) {
    reasons.push('no implementation-log.md — an auditor would have nothing to trace')
  }

  if (reasons.length) {
    if (!quiet) for (const reason of reasons) console.log(`  not done: ${reason}`)
    process.exit(1)
  }

  if (!quiet) {
    console.log('  goal: every phase passed, the tree is green, and a log exists.')
    console.log('  This means THE MACHINE IS SATISFIED. It is not a statement that the work is correct —')
    console.log('  no screenshot was taken and no person looked. Verify behaviour before handing it off.')
  }

  process.exit(0)
}

if (process.argv[1]?.endsWith('goal-check.mjs')) main()
