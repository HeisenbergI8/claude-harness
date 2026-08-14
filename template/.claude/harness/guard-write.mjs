#!/usr/bin/env node
// PreToolUse guard on Write/Edit: containment for everyone, role scoping for named agents.
//
// Two independent rules:
//
//   1. CONTAINMENT — no write outside the repository, for any agent or the main thread. Scratch space
//      (the OS temp dir) is exempt because it exists to be written to.
//   2. ROLE SCOPING — agents listed in `agents.write` may only write to their allowlist. An architect
//      designs and does not build; a tester reports and does not repair the thing it is testing.
//
// ── WHY THE SCOPING LIVES HERE AND NOT IN AGENT FRONTMATTER ────────────────────
//
// Per-subagent `hooks:` blocks are documented as scoped to that subagent. In the system this was
// extracted from they were schema-valid and DID NOT FIRE — a tester wrote to source unblocked while
// settings.json hooks fired normally in the same session. `agent_type` arrives on the payload, so the
// script can do the scoping itself and be certain it happened.
//
// The `tools:` frontmatter field DOES work, and is the right way to take Edit/Write away from an
// auditor entirely. This guard is for agents that need SOME write access, just not all of it.
//
// ── FAILS CLOSED, BUT ONLY FOR LISTED AGENTS ───────────────────────────────────
//
// For an agent with a rule, an unparseable payload or a missing file_path is DENIED. A guard that
// fails open produces confidence it has not earned.
//
// For everyone else it fails open, because the alternative blocks every write in the session over a
// bug in this file.

import { tmpdir } from 'node:os'
import { relative, resolve, sep } from 'node:path'

import { deny, globToRegExp, load, readPayload } from './config.mjs'

// The session scratchpad and OS temp live outside the repo and are meant to be written to.
const SAFE_OUTSIDE = [resolve(tmpdir()), '/private/tmp', '/tmp', '/private/var/folders', '/var/folders']

const isScratch = absolute => SAFE_OUTSIDE.some(area => absolute === area || absolute.startsWith(area + sep))

export const isPermitted = (target, rules) =>
  rules.some(rule => (rule.includes('*') ? globToRegExp(rule).test(target) : target === rule || target.startsWith(`${rule}/`)))

const main = async () => {
  const payload = await readPayload()
  const config = load()

  // An unparseable payload cannot be attributed to a restricted agent, so it cannot be judged.
  // Allowing is correct: the alternative blocks every write in the session.
  if (!payload) process.exit(0)

  const agent = payload.agent_type
  const rules = config.agents?.write?.[agent]
  const filePath = payload.tool_input?.file_path

  // ── 1. Containment, for everyone ─────────────────────────────────────────────
  if (typeof filePath === 'string' && filePath) {
    const absolute = resolve(process.cwd(), filePath)
    const outside = relative(process.cwd(), absolute).startsWith('..')

    if (outside && !isScratch(absolute)) {
      deny(
        `Writing outside this repository is not permitted (${filePath}). Scratch files belong in the ` +
          `session scratchpad or ${tmpdir()}. If this file genuinely belongs elsewhere, ask the user to ` +
          `place it themselves.`
      )
    }
  }

  // ── 2. Role scoping, for listed agents only ──────────────────────────────────
  if (!rules) process.exit(0)

  if (typeof filePath !== 'string' || !filePath) {
    deny(`guard-write saw no file_path on a ${payload.tool_name ?? 'unknown'} call from the ${agent} agent`)
  }

  const target = relative(process.cwd(), resolve(process.cwd(), filePath)).split(sep).join('/')

  if (!isPermitted(target, rules)) {
    deny(
      `The ${agent} agent may only write to: ${rules.join(', ')}. Blocked write to ${target}. ` +
        `If this file genuinely needs changing, REPORT it rather than editing it — an agent that can ` +
        `quietly fix what it is inspecting cannot be trusted to describe it.`
    )
  }

  // ── 3. The plan-write ceiling ────────────────────────────────────────────────
  //
  // An allowed path, but not in one shot. A Write is ATOMIC: a generation that times out saves zero
  // bytes, not a partial file. The protocol is skeleton-first, then one phase per Edit — so a timeout
  // costs one phase instead of the whole document.
  const maxLines = config.agents?.planWriteMaxLines ?? 600

  if (payload.tool_name === 'Write' && target.endsWith('.md') && target.startsWith(`${config.plan?.dir ?? '.claude/plans'}/`)) {
    const lines = String(payload.tool_input?.content ?? '').split('\n').length

    if (lines > maxLines) {
      deny(
        `That is a ${lines}-line Write to a plan document; the ceiling for a single Write is ${maxLines}.\n\n` +
          `Write the SKELETON first — the title, the overview, and every "### Phase N" / "#### Step N.M" ` +
          `heading with its **File:** and **Verify:** lines and a one-sentence intent, no diff blocks. ` +
          `Then append one phase per Edit call.\n\n` +
          `A Write is atomic: if generation times out you save zero bytes. A skeleton on disk is already ` +
          `enough for a human to read, for the linter to grade, and for you to be resumed against.`
      )
    }
  }

  process.exit(0)
}

if (process.argv[1]?.endsWith('guard-write.mjs')) main()
