# The pipeline

The agents, the plan artifact directory, and the supervised task loop. This layer is opinionated in a
way the gates are not — it describes *how to work*, not just what is true.

Nothing here is mandatory. The gates work without it.

---

## Routing — size the task first, then pick the agents

**Planning scales with uncertainty. Verification is close to constant.**

| Tier | What it looks like | architect | implement-plan | tester | audit |
| --- | --- | --- | --- | --- | --- |
| **Trivial** | rename, label, comment, one line | — | — | — | — |
| **Small** | one file, precisely specified | — | — | ✅ | `change-auditor` |
| **Medium** | ~3+ files, contract already known | — | ✅ | ✅ | `change-auditor` |
| **Large** | new module, a spec as input, unverified contract | ✅ | ✅ | ✅ | `auditor` |

**Promote a tier** — regardless of file count — when any of these is true: a specification document is
the input; a contract is unverified; a schema question is open; or more than one defensible approach
exists.

**Which auditor:** `auditor` traces a written plan and requires a plan directory. `change-auditor`
audits the working diff against the request. **Presence of a plan decides it.**

**Trivial still gets the verify command** and a plain statement of what changed. It skips the agents,
not the checking.

### Naming the tier out loud is the enforcement

Routing is a judgement no hook can make, so the safeguard is not a gate but **visibility**. A tier
stated in one line is a claim the user can correct in three words ("that's Small"). A tier never stated
cannot be challenged.

**Skipping the announcement is the actual failure mode here, not choosing wrong.**

### Run the tester and the auditor concurrently

This is the default, not an optimisation. They share no data — the tester drives the thing, the auditor
reads the diff — so neither can consume the other's output, and sequencing them adds the slower one's
wall clock to the faster one's for the same result. Launch both in one message with
`run_in_background: true`.

The ordering that *is* real: both run **after** implementation. An auditor with no implementation log to
read has nothing to trace.

---

## The artifact directory

| Stage | Invoke | Writes |
| --- | --- | --- |
| Plan | `architect` agent | `<plan>/<type>-<name>-plan.md` + `references/` |
| Build | `implement-plan` skill | `<plan>/implementation-log.md` |
| Verify | `tester` agent | `<plan>/verification.md` |
| Audit | `auditor` · `change-auditor` | **nothing** — reports in chat, scored /100 |

The first three read and write `.claude/plans/<type>-<name>-plan/`. That shared directory is what makes
an audit citable: the auditor traces each plan step to a log entry and a `file:line`.

### Write artifacts incrementally, never as a final step

**Any agent that produces a file creates it early** — a heading and a placeholder line is enough — then
appends as the work happens.

This is a standing rule because the same failure has hit multiple agents independently, and each time it
was fixed only in the one that broke:

- An architect spent 67 minutes composing a plan inside a single enormous `Write`, hit the request
  timeout, and saved **nothing**. A `Write` is atomic: a timed-out one saves zero bytes, not a partial
  file. Retrying identically failed the same way, because the bottleneck is output volume.
- A tester then did the identical thing twice in one day. Both runs exhausted their turn budget with the
  report still unwritten, and the second had already captured twelve usable screenshots that only
  surfaced because someone went looking for them.

Two corollaries, both learned the same way. **An agent running low on turns should stop working and
finish its artifact** — an unwritten finding does not exist. And **when you fix a failure mode in one
agent, check its siblings the same day.**

### Both auditors write nothing

They report in chat as their final message, scored out of 100 against a rubric. The score measures **how
much the auditor's own evidence is worth**, not how good the code is — an implementation it could only
read, never run, caps around the mid-60s.

**Treat a high score with no runtime evidence as a red flag rather than a pass.**

`change-auditor` weights **containment** at 25 points, because on an unplanned change, unrequested work
riding along is the defect a plan would normally have caught.

---

## The task loop

A supervised loop: **code decides whether to continue and what is next; the model does the work.**

`build-trigger.mjs` on `UserPromptSubmit` creates the run record **itself**, because a skill that merely
*tells* the model to create one produces no run when it forgets — and a driver with no run releases
forever, which is indistinguishable from working correctly.

`task-driver.mjs` on `Stop` decides. It blocks the turn with the next phase as its reason, and that
block is the iteration primitive.

### What it can drive

**Only planned work.** The cursor advances through `#### Step N.M` headings, so work with no plan has no
phases and nothing to advance through. A run with nothing bound halts after a few turns rather than
releasing forever.

This is a property of the tiers rather than a gap: the routing table gives an architect — and therefore
a plan — to Large only.

### Halt conditions

Evaluated **unconditionally, before** the tree is consulted. See the README for why the obvious ordering
silently abandons runs.

| Halt | Means |
| --- | --- |
| `done` | The machine is satisfied — see below |
| `phase stuck` | Three iterations, no new step passing |
| `tree red for N iterations` | The repair loop did not converge |
| `plan is unfalsifiable` | Under half its checks can fail |
| `needs-human` / `low-confidence` | A phase cannot be proved, or its checks prove nothing |
| `plan changed mid-run` | The document was edited after binding |
| budget halts | Iterations, wall clock, or spawns |

Every halt writes a report with a diff summary and **two explicit ways out**, resume or abandon. It
prefers `git stash` to any destructive revert, because a stash is recoverable — and because
`guard-destructive` blocks the destructive forms anyway.

### `done` is a proxy

A halt reporting `done` means every step's check passed, the tree is green, and an implementation log
exists. **Every one of those can be true while the work is wrong.** There is no screenshot check and no
person in the loop.

Say so when you report it, then run the tester and an auditor — which is what actually establishes it
works.

---

## Where the enforcement actually is

Some of this is enforced by code and holds regardless of what a model decides. The rest is instruction,
and instruction is not behaviour.

| Mechanism | Enforces | Where |
| --- | --- | --- |
| `tools:` frontmatter | The auditors have no Edit/Write at all | agent frontmatter |
| `PreToolUse` write guard | Architect writes only plans; tester only tests and its report | `guard-write.mjs`, scoped by `agent_type` |
| `maxTurns` | A runaway backstop per agent — **not** a scope limit | agent frontmatter |
| `Stop` / `SubagentStop` gate | A red tree drives a repair loop | `verify-gate.mjs` |
| `PreToolUse` commit guard | No credential, build output, second lockfile, or red tree committed | `guard-commit.mjs` |
| `PostToolUse` loop breaker | The same command failing repeatedly is blocked | `loop-breaker.mjs` |
| `verify-plan --strict` | A plan whose checks cannot fail halts the run before phase one | `verify-plan.mjs` |
| `UserPromptSubmit` inject | Past lessons reach context without being remembered | `lessons.mjs inject` |
| `lessons.mjs audit` | The cap is enforced, not just documented | wire into your verify command |
| `Stop` capacity gate | A full store gets reviewed WITH the user, not silently deferred | `lesson-capacity.mjs` |

**Do not move per-agent hooks into agent frontmatter.** Per-subagent `hooks:` blocks have been observed
schema-valid and silently inert while `settings.json` hooks fired normally in the same session. Scoping
is done inside the scripts, by reading `agent_type` off the payload. (`tools:` in frontmatter *does*
work — that is how the auditors' restriction is applied.)

**Note which agents inherit `CLAUDE.md`.** Project-defined agents generally do; built-in agent types
generally do not. Anything delegated to a built-in type needs its conventions stated in the prompt
rather than assumed — and an agent that already has a file in context should not spend a `Read` on it.
