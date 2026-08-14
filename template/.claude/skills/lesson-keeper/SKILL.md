---
name: lesson-keeper
description: Record, consolidate, and prune the hard-won lessons in .claude/lessons/. Use when a non-obvious failure has just been resolved, when the lessons audit reports warnings, or when asked what has been learned in this project.
---

# Lesson Keeper

The store in `.claude/lessons/` exists so a mistake costs its debugging time **once**. It is capped and
injected into context automatically, which means **every entry is paid for in tokens on every matching
prompt**. That budget is the discipline: this skill is mostly about **refusing** to write things down.

**The expected rate is about one lesson per session, frequently zero.** If you are recording more than
that, the bar has slipped.

## The bar — all four, or it does not get written

**1. Recurrence.** Will this plausibly happen again, in *this* project, on *this* stack? A one-off typo,
a transient network failure, or a mistake made through carelessness rather than missing knowledge fails
here.

**2. Non-obviousness.** Would a competent developer reading the code already know? If it is stated in
`CONVENTIONS.md`, in the project docs, in a type signature, or in the error message itself — it fails.
**Check `CONVENTIONS.md` before writing.** Duplicating it is the most common way this store bloats.

**3. Behaviour change.** Does it change what you would *do*, not merely what you would know?
"Registration happens in two places" is a fact, and it belongs in `CONVENTIONS.md`. "When a query never
resolves and throws no error, check the second registration first" is a lesson — it changes the first
thing you reach for.

**4. Cost.** Did getting this wrong actually cost something — a wrong deliverable, an hour, a broken
environment? Cheap mistakes that self-correct in seconds are not worth a permanent slot.

## Never record

- Anything already in `CONVENTIONS.md` or the project docs — link to it instead
- Anything git history answers ("we changed X to Y in commit Z")
- Generic engineering advice — "write tests", "read the error"
- Facts about a specific ticket, entity, or dataset — that is project state, not a lesson
- A restatement of a contract — that belongs with the types
- "Remember to run the tests" — that is a hook's job, and it already has one

## Writing one

```markdown
---
id: kebab-case-slug          # unique; matches the filename
trigger: five, to, eight, terms    # retrieval keys — this is what makes it findable
scope: harness | build | process | module | api
learned: YYYY-MM-DD
evidence: the concrete incident, one line
---

**Lesson:** One sentence, imperative. This is the index line — it must stand alone.

**Why:** The mechanism. What actually happened, and what made it non-obvious.

**Do:**
- Specific, checkable actions
- Name the file, command, or flag involved
```

Keep the body **under 25 lines** — the audit warns past that. A lesson needing more room is usually two
lessons, or belongs in `CONVENTIONS.md`.

**Triggers are the highest-leverage field.** A lesson that never matches a prompt was never written. Use
the words that appear in a *request* or an *error message*, not the words you would use to categorise it
afterwards. The audit reports lessons that have never matched — that is a trigger bug, not on its own a
reason to delete.

## Keeping it sharp

Growth is not the goal. Run `node .claude/harness/lessons.mjs audit` — wire it into your verify command —
and act on what it says.

**Consolidate** when two lessons share three or more triggers. They will always inject together, so they
are one lesson filed twice.

**Promote** when a lesson has hardened into a rule. This is the most important move and the most often
skipped:

| The lesson has become | Move it to | Then |
| --- | --- | --- |
| A standing convention | `CONVENTIONS.md` | delete the lesson |
| A mechanically checkable rule | a guard in `.claude/harness/` | delete the lesson |
| A product or domain decision | your decision records | delete the lesson |

**A promoted lesson is deleted, not archived.** In a system built on mechanical enforcement, the best
outcome is that a lesson stops being a lesson and becomes code. `.claude/lessons/` stages what is not yet
enforceable — **the store getting SMALLER because three entries became one guard is the system working.**

**Prune** when a lesson is obsolete: it names a file that no longer exists, a version upgraded past, or a
bug fixed upstream. Verify before deleting — `git log` and the actual file, not memory.

## At the cap

The audit fails the build at the cap. **Do not raise it.** Consolidate, promote, or prune. The cap is
what forces the store to stay high-signal, and raising it is how a curated set becomes a log.

## Consulting

Automatic. `lessons.mjs inject` runs on every prompt: the index once per session, and the full text of
any lesson whose triggers match. You do not need to remember to read them.

What you **do** need to do is **act on one when it appears**. An injected lesson is a prior decision made
by someone with more context than you have right now — the incident is in the `evidence:` line. Override
it if you have a reason, but say that you are.
