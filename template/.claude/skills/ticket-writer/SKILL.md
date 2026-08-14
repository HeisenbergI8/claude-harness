---
name: ticket-writer
description: Draft a well-formed issue or ticket — title and description — ready to paste into your tracker. Use when the user asks to write a ticket, file a bug, create a story, or turn a finding into something trackable.
---

# Ticket Writer

You are drafting text for a human to paste. **You are not filing anything** — creating an issue is an
outward-facing act, so produce the draft and let the user place it.

Check `CONVENTIONS.md` for this project's ticket prefix and any required fields.

## Establish the type first, because it changes the shape

**Bug** — something behaves differently from what is expected. The description is *evidence*.
**Story / task** — something should exist that does not. The description is *outcome plus acceptance*.
**Spike** — the work is finding out. The description is *the question and what answering it unblocks*.

Getting this wrong produces a ticket nobody can act on: a bug written as a story has no reproduction, a
story written as a bug has no definition of done.

## Bug

```markdown
**Title:** <what is wrong, observable, no cause in it>

**Environment:** <version / branch / device — whatever actually varies here>

**Steps to reproduce**
1.
2.

**Expected:** <what should happen, and why you believe that>

**Actual:** <what happens, verbatim — real output, not a paraphrase>

**Evidence:** <screenshot path, log excerpt, failing test name>

**Scope:** <who or what is affected, and how often>
```

**The title states the symptom, not your theory.** "Filter returns no rows after clearing the date" is
actionable. "Filter state not reset in the reducer" is a guess that sends whoever picks it up to the
wrong file — and it will be wrong often enough to matter.

**Expected needs a reason.** "Expected: it should work" is not a specification. Cite the requirement, the
neighbouring behaviour it is inconsistent with, or the user expectation it breaks.

## Story / task

```markdown
**Title:** <the outcome, from the user's side>

**Context:** <why this is worth doing now — one short paragraph>

**Scope**
- In:
- Out:

**Acceptance criteria**
- [ ] <observable, checkable, no implementation detail>
- [ ] 

**Notes:** <constraints, decisions already taken, links>
```

**The "Out" list is the most valuable line in the ticket.** Scope is defined by what it excludes; a
ticket with no stated exclusions gets an implementation twice its size, and nobody can tell whether that
was wrong.

**Acceptance criteria are observable, not internal.** "The list refreshes after a delete" can be
checked. "Uses the correct cache invalidation" cannot — it is a design choice, and it belongs in the
notes.

## Rules

- **One ticket, one outcome.** If the title needs "and", it is two tickets.
- **Never invent a reproduction.** If you have not reproduced it, say what you observed and what you did
  not.
- **Never assign severity you cannot justify.** State the impact and let the reader decide, unless the
  project has a defined scale.
- **Quote real output.** A paraphrased stack trace is not evidence.
- **Say what you do not know**, in the ticket. An honest "unclear whether this affects the export path
  too" saves the next person the same investigation.
- **Do not include a proposed fix in a bug** unless asked. It anchors the reader, and it is frequently
  wrong for reasons the investigation would have found.
