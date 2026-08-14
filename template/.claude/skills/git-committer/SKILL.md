---
name: git-committer
description: Write and create commits matching this project's established convention. Use when the user asks to commit, or when a unit of work is finished and ready to record.
---

# Git Committer

## Read the log before writing anything

```bash
git log -20 --format='%s%n%n%b%n---'
```

**The existing log is the convention.** `CONVENTIONS.md` records what is easy to get wrong; the log
records what is actually done. When they disagree, follow the log and say so.

Look for: subject format, whether a scope is used, whether bodies are expected, whether a ticket
reference appears and in what form.

## Read the diff before describing it

```bash
git status --porcelain
git diff --staged
```

**Never describe a diff you have not read.** A commit message written from memory of what you intended
describes the intention, not the change — and the two diverge exactly when it matters.

## The shape

```
<type>(<scope>): <what changed, imperative, under ~70 chars>

<why — the paragraph that earns its place>

<verification line: what you ran and what it said>

<trailer, if this project uses one>
```

**The body explains WHY, not what.** The diff already says what. A body that narrates the change is
noise; a body that says what was broken, what was tried, or what constraint forced this shape is worth
reading in a year.

**The verification line is concrete or absent.** "Tested" is worthless. `verify green, 42/42 unit` is
evidence. If you did not run anything, say nothing rather than implying you did — the claim checker will
block a green claim the ledger cannot support, and it is right to.

## Before committing

Run the project's verify command. `guard-commit.mjs` checks the index anyway and will refuse a commit
that carries a credential file, build output, a second lockfile, or a red tree — but finding out at the
guard is finding out late.

## What not to do

- **Do not stage things you did not look at.** `git add -A` after a long session sweeps up scratch files
  and half-finished edits. Stage deliberately, then read `git diff --staged`.
- **Do not bundle unrelated work.** If the diff has two stories in it, make two commits. A reviewer who
  has to separate them will not, and neither will `git revert`.
- **Do not amend or force-push** unless asked. Both rewrite history somebody may have pulled.
- **Do not commit on the default branch** without checking that is what the user wants.
- **Never fabricate a ticket reference.** If the project requires one and you do not have it, ask.

## Commit or not

Commit when a unit of work is complete and verified. Do not commit to "save progress" mid-phase — that
is what the working tree is for, and a half-implemented commit is a bad bisect point.

**If the user has not asked you to commit, ask before you do.** A commit is a durable, outward-facing
act; the fact that the work is finished is not by itself permission to record it.
