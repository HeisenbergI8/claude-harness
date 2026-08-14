---
name: debug-ladder
description: Escape a repeated-failure loop. Load when the same test, typecheck, build, or runtime error has survived two or more fix attempts, or when you notice you are trying variations of a solution that already failed. Enforces an attempt budget, a written ledger, and escalation to the user.
---

# Debug Ladder

You are here because something failed more than once. The purpose of this skill is to stop you spending
the next hour producing variations of a fix that has already been proven wrong.

The core failure mode: an attempt fails, you adjust a detail and retry, it fails again — and because
each attempt *feels* new you never notice the shape is identical. **The ledger is what breaks that**,
because you have to read your own history before attempting again.

## Step 1: Write the ledger first

Before the next attempt, open `attempts.md` — in the plan directory if one exists, otherwise your
scratchpad — and record what has happened so far:

````markdown
# Attempt ledger: [one-line problem statement]

**Symptom (verbatim):**
```
[the exact error output, not a paraphrase]
```

**Reproduction:** [exact command or click path]

| # | Hypothesis | Change made | Result |
| --- | --- | --- | --- |
| 1 | [what you believed was wrong] | [what you changed] | [what actually happened] |
````

**Writing down the hypothesis is the point.** Two attempts with different code but the same hypothesis
are the same attempt, and you can only see that once it is written.

## Step 2: Climb the ladder

Each rung must differ from the last **in kind, not in detail**. If your next move is the same kind as
the previous one, skip up a rung.

**Rung 1 — Read the error properly.** The full output, not the last line. Open the file at the exact
line and column cited. Check whether the error is even about what you assume — an error surfacing in one
layer is often caused by the layer beneath it.

**Rung 2 — Verify your assumptions.** Do not reason about what the code does; run it and observe. Print
the actual shape. `git diff` what you changed. **Confirm the file you edited is the file being
executed** — and that any process needing a restart got one.

**Rung 3 — Shrink the surface.** Reproduce with the smallest possible input — one test case, one call,
one prop. A failure you cannot isolate is one you do not understand.

**Rung 4 — Bisect.** Did this ever work? `git stash`, or check out the merge-base and run the same
command. If it passes there, `git log -p` the file and find the change that broke it. **Establish the
baseline first** if this project carries known-failing tests.

**Rung 5 — Question the target.** Consider that the test, the plan step, or your understanding of the
requirement is what is wrong. This rung is frequently correct and almost always reached too late.

## Step 3: The hard threshold

**After three attempts on the same symptom, stop and escalate.** This is not a suggestion to weigh
against how close you feel — **feeling close is the characteristic sensation of being stuck.**

The threshold is enforced mechanically. `loop-breaker.mjs` counts consecutive failures of the same
command: at two it injects this skill, at three it blocks the call outright. **If you are reading this
because it fired, the count is already spent** — do not attempt a fourth variation.

Escalating means reporting to the user:

- The symptom, verbatim.
- The ledger — every hypothesis tried, and why each was wrong.
- What you now believe the real cause is, with your confidence.
- The two or three paths forward you can see, and which you would choose.
- **The specific thing you would need in order to be sure** — access, a decision about intended
  behaviour, a look at a contract.

Leave the code clean. Revert speculative changes that did not help; do not leave a trail of half-fixes.

## Rules

- **Never repeat an attempt already in the ledger.** If it is written down, it is spent.
- **One variable at a time.** Changing three things and getting a pass teaches you nothing about which
  mattered.
- **Never weaken a check to make it pass.** Deleting an assertion, loosening a type, or skipping a test
  converts a visible failure into an invisible one. If you genuinely believe the check is wrong,
  escalate and say so — do not act on it unilaterally.
- **Never widen scope to escape.** Refactoring the surrounding module to avoid a bug you do not
  understand buries it.
- **Timebox rather than grind.** If a rung is taking long enough that you have stopped forming new
  hypotheses, climb.

## Recognising you are looping

Rerunning an unchanged command expecting a different result. Changing formatting or ordering rather than
behaviour. Adding logging without a specific question. "Let me try X again, maybe with…". A growing pile
of small edits none of which you can explain.

**Any of these means you are already past the point of escalation.**
