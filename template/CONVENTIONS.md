<!-- harness:scaffold — delete this line when you have filled the file in. The selftest warns while it
     is here, because a half-filled scaffold is worse than no file: the agents follow whatever it says. -->

# Conventions

**What this file is for:** the agents in `.claude/agents/` know how to plan, verify and audit, but
nothing about *your* project. This is where you tell them. Four short sections is a good day one —
**delete any you cannot fill honestly.** An empty section is fine; a section of placeholder text is not.

---

## What this project is

<!-- Two or three sentences: what it does, who uses it, what it talks to. -->

_e.g. An internal admin console. Pure frontend — all data comes from an external REST API, there is no
local database. Used by ~20 operations staff._

**Stack:** <!-- languages, framework versions, the two or three libraries that shape how code is written -->

---

## Commands

<!-- The first two MUST match harness.config.json. If they drift, the gates check something different
     from what you run by hand, and the disagreement will not be obvious. -->

| Purpose | Command |
| --- | --- |
| Full check (the closing gate) | `` |
| Fast check (runs every turn) | `` |
| Tests, one file | `` |
| Run the app locally | `` |

<!-- Add any command with a trap attached. "This suite exits 1 on a healthy tree because N tests are
     known-red" is exactly the kind of thing an agent cannot infer and will misread as a failure. -->

---

## Where things live

| Layer | Path | Owns |
| --- | --- | --- |
|  |  |  |

**Read this first:** <!-- The ONE module a new one should be modelled on. Name a real path. -->

<!-- This is the highest-value line in the file. "Read X before building Y" replaces a page of prose,
     and unlike prose it cannot drift from the code. Pick a module that is genuinely representative,
     not merely the newest — whatever you name becomes the template for everything built next. -->

---

## Traps

<!-- Things that are true, non-obvious, and have already cost someone time. Each one should change what
     somebody DOES, not just what they know. This is the section people actually read. -->

- <!-- e.g. Env vars prefixed NEXT_PUBLIC_ are inlined at build time. Changing one needs a dev-server
        restart; hot reload will not pick it up. -->
- <!-- e.g. The auth flow is entirely custom despite next-auth being in package.json. Nothing imports it. -->

---

## Reporting rules

<!-- These four hold in every project. They are here rather than in the agent prompts because they are
     about YOUR backlog, and an agent cannot infer any of them from the code. Delete one only if you
     genuinely disagree with it. -->

- **A deferral is not a gap.** Work that was consciously postponed must not be reported as a defect, a
  finding, or a hand-off item — by a person or by an agent. From inside any single module a deliberate
  absence looks exactly like an oversight, so it will be re-raised on every audit until it is written
  down. List the deferrals here: <!-- e.g. role checks are deferred platform-wide; their absence is
  intentional -->
- **A claim that ages carries the date it was measured.** Any count, or any "every / all / none"
  statement, written into something durable — a doc, a status field, a user-visible string — says when it
  was measured: `measured NULL on 25 of 25 rows on 2026-08-06`. Not to prove the measurement happened,
  but because writing a date for a measurement you did not take is a deliberate act rather than an
  accident of momentum. It also makes the claim checkable later; `NULL on all rows` reads as eternally
  true.
- **Red is not automatically yours.** A failing typecheck, lint or test in code this turn did not touch
  is evidence about the tree, not a defect to fix. Where more than one session or person has uncommitted
  work in the same checkout, it is usually theirs — and "fixing" it overwrites work in progress that
  looks, from inside a single session, exactly like a mistake. Establish provenance first, and never by
  stashing: `git show HEAD:<path> | diff - <path>` compares against the committed version and changes
  nothing. `git stash && <check> && git stash pop` is refused by `guard-destructive` for that reason —
  a `pop` that conflicts buries whatever was uncommitted.
- **A priority label is not permission to start.** "Critical" or "P1" in a spec or a ticket says what
  matters, not what is next, and not what has already been decided against. Check whatever records
  decisions in this project before planning from a label.

---

<!-- ────────────────────────────────────────────────────────────────────────────────────────────────
     OPTIONAL — add a heading below only when you have something real to put under it. Each one earns
     its place on a bigger or older codebase and is noise on a small one.

       Data flow                  The path a request takes, as one line, then the rules it implies —
                                  the ONE sanctioned way to reach the network, and what to never do.

       Registering something new  The cross-cutting checklist that fails SILENTLY when missed. Usually
                                  not an error, just a screen that never loads. Plans forget this.

       Code conventions           ONLY what an agent would get wrong. Anything your linter enforces
                                  does not belong here — the linter is the enforcement.

       Dead code to ignore        Template leftovers and abandoned experiments. An agent that does not
                                  know these are dead will read them as precedent and copy them.

       Decisions that override    Where a later decision beats the spec, and which wins. An agent
       the spec                   reading only the spec implements work that was cancelled.

       Git                        Branch naming, commit format, ticket prefix. Note that `git log -20`
                                  is the real convention; record only what is easy to get wrong.
     ──────────────────────────────────────────────────────────────────────────────────────────────── -->

<!-- Keep this file tracked in git and keep it SHORT. Everything here is read on most planning tasks,
     so it competes with the code for the same attention. If a section outgrows a screen, it wants to
     be a doc that this file points at. -->
