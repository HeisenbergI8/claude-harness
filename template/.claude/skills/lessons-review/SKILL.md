---
name: lessons-review
description: Work through the captured candidate backlog and decide which incidents become lessons, which get encoded as guards, and which are discarded. Use when the harness reports a candidate review is due, or when asked to review what has been learned.
---

# Lessons Review

`.claude/.harness/candidates.jsonl` is the **episodic** layer: raw incidents captured automatically and
never injected into context. This skill is the distillation pass that turns a few of them into semantic
memory and throws the rest away.

**Throwing most of them away is the expected outcome.** Capture is generous on purpose; strictness lives
here.

## Read the backlog

```bash
node .claude/harness/candidates.mjs list
```

Read all of it before deciding anything. Patterns across entries are the point — three separate
corrections about the same thing are one lesson, and you can only see that having read all three.

## For each candidate, choose one of four

**1. Encode it as a guard.** The best outcome, and the most often skipped. If the incident is
mechanically checkable — a command that should never run, a file that should never be written, a shape
that is always wrong — write the check instead of the lesson. A guard fires every time; a lesson only
fires when its triggers happen to match.

Add it to `.claude/harness/`, wire it in `settings.json`, and **add both-direction test cases**. The
allow cases matter more than the block cases: a guard that refuses ordinary work gets switched off.

**2. Promote it to `CONVENTIONS.md`.** If it is a standing fact about the project rather than a
behaviour change — where something lives, what the registration checklist is — it belongs there, where
it is read on every planning task rather than only on a keyword match.

**3. Write it as a lesson.** Only if it passes all four tests in `lesson-keeper`: recurrence,
non-obviousness, behaviour change, real cost. Most candidates fail at least one.

**4. Discard it.** The default. A correction that was a one-off, a misunderstanding already resolved in
conversation, a capture that was a false positive of the pattern matcher.

## Then clear what you reviewed

```bash
node .claude/harness/candidates.mjs clear --before <ISO timestamp>
```

**`--before` is required and the tool refuses to clear everything.** Entries added while you were
reading are precisely the ones you have not reviewed, and clearing them silently loses exactly the
incidents that were freshest.

Use the timestamp of the last entry you actually read.

## Then audit the store

```bash
node .claude/harness/lessons.mjs audit
node .claude/harness/lessons.mjs stats
```

Act on what they say — consolidate lessons sharing triggers, graduate anything now encoded elsewhere,
prune anything obsolete.

**Check `stats` for lessons that have never matched a prompt.** That is usually a trigger bug rather than
a reason to delete: the lesson may be excellent and simply filed under words nobody types. Rewrite the
triggers using the words that appear in a real request or a real error message.

## The honest measure of this pass

Not how many lessons you added. **How many mechanisms you added, and how many lessons you were able to
delete because something else now enforces them.**

A review that adds nothing and deletes two entries because they became guards is a better review than one
that adds five.
