---
name: build
description: Start or steer a supervised task-loop run. Use when the user types /build, or asks to work through a plan autonomously and have the loop keep going until it is done or a cap is hit.
---

# Build — the supervised task loop

A loop where **code decides whether to continue and what is next; the model does the work.**

`task-driver.mjs` runs on `Stop` and blocks the turn with the next phase as its reason. That block is
the iteration primitive: the turn does not end, and the model is re-invoked with instructions it did not
write.

## What the hook already did

`build-trigger.mjs` fires on your `/build` message and **creates the run record itself**. You do not
create it, and you do not need to remember to.

That is deliberate. A skill that merely *tells* the model to create a run produces no run when it
forgets — and a driver with no run releases forever, which is **indistinguishable from working
correctly**. The mechanism sits in the hook so it cannot be skipped.

## Commands

```bash
/build <label>                  start a run
/build <label> --plan <path>    start it already bound to a plan
/build --status                 where is it
/build --resume                 continue after a pause
/build --halt                   stop it
```

**Any other user message pauses a live run.** The loop advances only while you are silent. This is a
feature: a loop that reinterprets its objective from conversation is how a run quietly becomes something
nobody asked for.

## Your job when a run starts

### 0. Check the entry conditions before spending anything

```bash
node .claude/harness/preflight.mjs
```

If it fails, **stop and tell the user what failed. Do not fix it.** A run that begins by repairing
something it did not cause can no longer say which part of its own diff is its work — and *what did this
run change* is the first question asked when it halts. It also means the loop's first act is unplanned,
unrequested work.

A precondition that lives as a line in a report is not a precondition. A human reading "backend: no"
stops; a loop reads it, carries on, and spends its entire budget verifying loading skeletons — every
screen renders, every check passes, and none of it means anything.

### 1. Size the task honestly, out loud

**The loop can only drive planned work.** The cursor advances through `#### Step N.M` headings, so work
with no plan has no phases and nothing to advance through. The driver halts such a run after a few turns
rather than releasing forever.

If this task does not warrant a plan, **say so and do it directly.** Starting a run that drives nothing
looks exactly like the loop working, which is the failure this whole system exists to avoid.

### 2. Get a plan, and bind it

Produce one with the `architect` agent, or point at an existing one. Then:

```bash
node .claude/harness/run-state.mjs plan <path>
```

Binding stamps the plan's hash. **Editing the plan after this halts the run** — every phase number and
step id in the cursor would refer to a document that no longer exists, and the loop should not be
guessing whether an edit was harmless.

### 3. Work phase by phase

Follow `implement-plan`. Implement, gate, log. **Do not start a later phase**, and do not treat the
driver's block as noise — it is the next instruction.

The block reason carries what has already been tried in this run. **Read it.** Reproducing a hypothesis
that already failed is the specific waste the attempt log exists to prevent.

## When it halts

Every halt writes a report to `.claude/.harness/runs/<id>/halt-report.md`, and the driver blocks once so
you cannot miss it.

**Read the report and tell the user what happened** — what changed, and which of the two paths it lists
you recommend. Do not start another run.

The halts, and what each means:

| Halt | Means |
| --- | --- |
| `done` | The machine is satisfied. See below. |
| `phase stuck` | Three iterations with no new step passing — the phase is not converging |
| `tree red for N iterations` | The repair loop did not converge |
| `plan is unfalsifiable` | Under half its checks can fail; nothing it reports can be trusted |
| `needs-human` / `low-confidence` | A phase cannot be proved, or its checks prove nothing |
| `plan changed mid-run` | The document was edited after binding |
| `no plan bound` | Nothing to drive |
| budget halts | Iterations, wall clock, or spawns exhausted |

## `done` does not mean correct

A halt reporting `done` means **the machine is satisfied**: every step's check passed, the tree is
green, an implementation log exists.

Every one of those is a proxy that can be true while the work is wrong. **There is no screenshot check
and no person in the loop.** Say this to the user rather than reporting a successful run as a finished
feature — then run the `tester` and an auditor, which is what actually establishes it works.

## The run owns the working tree

It stages and does not commit. If you halt mid-phase the tree is left as it is — the report gives both
ways out, and it prefers `git stash` to any destructive revert because a stash is recoverable.
