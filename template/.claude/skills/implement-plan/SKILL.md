---
name: implement-plan
description: Execute an architect plan phase by phase with verification gates. Use when implementing a plan from .claude/plans/, or when the user says "implement the plan", "build this", or "go ahead" after a plan exists. Also use for any multi-file change large enough to need ordered phases, even without a formal plan.
---

# Implement Plan

Execute an approved plan on the main thread, one phase at a time, **proving each phase works before
starting the next**.

You run here rather than in a subagent on purpose: you keep the full conversation, you can ask a
question mid-flight, and the user watches the work land. Use that. When something in the plan turns out
to be wrong, stop and say so — do not silently improvise around it.

## Before writing anything

1. Read `CONVENTIONS.md`. It is binding for architecture, commands and conventions.
2. **Read the plan document AND its `references/` reviews.** The references hold the annotated reasoning
   behind each step; skipping them is how you re-derive a decision the architect already made and get it
   wrong.
3. Load the `lean-code` skill. Every line you are about to write should survive its questions.
4. Confirm the phase order still makes sense against the current tree. If the repo moved since the plan
   was written, say so before proceeding.

## The loop

For each phase, in order:

### 1. Announce
Which phase, which files. One or two sentences.

### 2. Implement
Work the phase's steps. **Stay inside the phase** — do not pull work forward from a later one because
you happen to be in the file. Scope creep is what makes a plan unverifiable.

Follow the conventions as you write, not as a cleanup pass afterward.

### 3. Gate
Run the project's **fast** verify command before moving on; the full one before the final phase closes.

A `Stop` hook runs the fast gate when the turn ends, so a red gate you skipped surfaces anyway. Running
it yourself at the phase boundary is how you find out *before* you have built three phases on top of it.

**A phase is not done until its gate is green.** Do not start phase N+1 on a red gate, and do not tell
the user a phase is complete when it is not.

### 4. Log
Append to `implementation-log.md` in the plan directory:

```markdown
## Phase N: [name] — YYYY-MM-DD

**Steps completed:** N.1, N.2
**Files changed:** `path/one.ts`
**Deviations from plan:** [what differed and why, or "none"]
**Gate:** [command + result]
**Notes:** [anything the tester or auditor needs to know]
```

This log is what the auditor reads. **Deviations recorded here are legitimate engineering judgment;
deviations discovered by the auditor in the diff are findings against you.**

### 5. Checkpoint
Tell the user in one or two lines what landed and what is next. For phases touching more than a handful
of files, or any phase where you deviated, pause for confirmation before continuing.

## When a gate fails

Fix it — but count your attempts. On the **third** consecutive failure at the same gate, stop and load
`debug-ladder`. You do not have to remember to: the loop breaker counts identical failing commands, injects
the ladder at two and blocks at three. **Treat that injection as the instruction it is**, not as noise to
work around.

## When the plan is wrong

Plans are written before contact with the code. When a step turns out to be impossible, unnecessary, or
based on a wrong assumption:

1. Stop implementing that step.
2. Tell the user what the plan assumed and what is actually true.
3. Propose the correction.
4. Record it under **Deviations** once resolved.

**Never implement a step you believe is wrong just because it is written down, and never quietly skip
one.**

## Definition of done

Every phase gate green, the full verify command passing across the tree, `implementation-log.md`
covering every phase, and **you have told the user plainly which plan steps you did NOT implement and
why**.

Then hand off: suggest the `tester` agent for behavioural verification and the `auditor` for the
completeness report. **Do not audit your own work** — you already believe it is right, which is exactly
why someone else should look.
