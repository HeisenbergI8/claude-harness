<!-- harness:scaffold — DELETE THIS LINE once you have filled the file in. The selftest looks for it and
     warns while it is present, because an unfilled scaffold is worse than no file: the agents read it
     as the authority on this project and will follow whatever it says. -->

# Conventions

> **This file is the input the agents read.** `harness-init` scaffolded it; nothing in it is true yet.
>
> The agents in `.claude/agents/` are deliberately generic — they know how to plan, verify and audit,
> but nothing about *your* project. This file is where that knowledge lives, and it is the difference
> between a plan grounded in code that exists and one made of plausible-sounding advice.
>
> Fill in what is true. **Delete what is not** — an empty section is honest; a section full of
> placeholder text is worse than no file at all, because agents will follow it.
>
> Keep it **tracked in git** and keep it **short**. Everything here is read on most planning tasks, so
> it competes for the same attention as the code. If a section grows past a screen, it probably wants
> to be a doc that this file points at.

---

## What this project is

<!-- Two or three sentences. What it does, who uses it, what it talks to. An agent that knows this
     stops proposing architectures that make no sense here. -->

_e.g. An internal admin console. Pure frontend — all data comes from an external REST API, there is no
local database. Used by ~20 operations staff._

**Stack:** <!-- languages, framework versions, the two or three libraries that shape how code is written -->

---

## Commands

<!-- These MUST match harness.config.json. If they drift, the gates check something different from what
     you run by hand, and the disagreement will not be obvious. -->

| Purpose | Command |
| --- | --- |
| Full gate (the closing check) | `` |
| Fast gate (runs every turn) | `` |
| Tests, one file | `` |
| Tests, one module | `` |
| Run the app locally | `` |

<!-- Any command with a trap attached. "This suite exits 1 on a healthy tree because N tests are
     known-red" is exactly the kind of thing an agent cannot infer and will misread as a failure. -->

---

## Layout

<!-- Where things live. A table beats prose here: an agent scanning for "where do I put a new X" finds
     a row faster than a paragraph. -->

| Layer | Path | Owns |
| --- | --- | --- |
|  |  |  |

**Canonical reference:** <!-- The ONE module or package a new one should be modelled on. Name a real
path. This is the highest-value line in the file — "read X before building Y" replaces a page of prose,
and unlike prose it cannot drift from the code. -->

<!-- Pick a module that is genuinely representative, not just the newest. The newest module becomes the
     template for the next one, so a screen you are unhappy with propagates. -->

---

## Data flow

<!-- The path a request takes, as one line. Then the rules that path implies. -->

_e.g. `component → query hook → store slice → service → transport → API`_

- <!-- The ONE sanctioned way to reach the network / database / queue. Name the function and file. -->
- <!-- What must never be done directly, and what to use instead. -->

---

## Registering something new — every place, all mandatory

<!-- The checklist that is impossible to infer and fails SILENTLY when missed. This is the section that
     earns its keep: cross-cutting registration is what plans forget, and the failure is usually not an
     error but a screen that never loads. -->

1. <!-- e.g. Add the slice to BOTH the reducer map AND the middleware chain. Adding only the reducer
        produces queries that never resolve, with no error. -->
2.
3.

---

## Conventions

<!-- Only what an agent would get WRONG. Formatting your linter enforces does not need a line here —
     the linter is the enforcement, and repeating it just gives it somewhere to drift from. -->

- **Naming:**
- **Imports:**
- **Types:**
- **Error handling:**

---

## Traps

<!-- Things that are true, non-obvious, and have cost someone time. Each one should change what somebody
     DOES, not merely what they know. This is the section people actually read. -->

- <!-- e.g. Env vars prefixed NEXT_PUBLIC_ are inlined at build time. Changing one requires a dev-server
        restart; hot reload will not pick it up. -->
- <!-- e.g. The auth flow is entirely custom despite `next-auth` being in package.json. Nothing in src/
        imports it. -->

---

## Dead code and scaffolding to ignore

<!-- Template leftovers, abandoned experiments, generated directories. An agent that does not know these
     are dead will read them as precedent and copy them. -->

-

---

## Decisions that override the specification

<!-- If a spec, ticket or design doc says one thing and a later decision says another, record it HERE and
     say which wins. An agent reading only the spec will implement work that was explicitly cancelled,
     and will report the absence of cancelled work as a gap. -->

| Decision | Date | Effect |
| --- | --- | --- |
|  |  |  |

**Precedence:** decisions here → <!-- your spec --> → the code.

---

## Git

- **Branches:** <!-- naming, and what they merge into -->
- **Commits:** <!-- format, and whether a ticket reference is required -->
- **Ticket prefix:** <!-- e.g. PROJ-1234, or "none" -->

Read `git log -20` before writing a commit message here — the existing log is the real convention, and
this section only records what it is easy to get wrong.
