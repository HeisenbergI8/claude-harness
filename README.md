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

In a script or CI there is no terminal to prompt on, so it takes the detected values silently. Pass
`--yes` to force that anywhere.

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
| `hook-heartbeat` | called by the others | Records that hooks fired and what their payloads carried |
| `selftest` | you run it | Answers whether the harness is working or merely *installed* |

**Guards** — `PreToolUse`, and every one is scoped to avoid refusing ordinary work.

| Guard | Refuses |
| --- | --- |
| `guard-destructive` | Deletion, overwrite or move reaching outside the repo; `git clean -f`, `reset --hard`, `checkout -- .` |
| `guard-secrets` | Credentials into the transcript (`cat .env`) or into the repo |
| `guard-commit` | A commit carrying a credential file, build output, a second lockfile, or a red tree |
| `guard-write` | Writes outside the repo, for anyone; writes outside their role, for named agents |

**Agents and skills** — role separation that a guard makes real rather than promised.

`architect` (plans, cannot build) · `tester` (verifies, cannot edit source) · `auditor` /
`change-auditor` (read-only, no write tools at all) · `merge-conflict-resolver`, plus skills for
implementing a plan, escaping a failure loop, writing lean code, and curating what the project has
learned.

**Plan pipeline and task loop** — `verify-plan` runs each plan step's check and grades the checks
themselves; `next-phase` tracks the cursor; `task-driver` blocks `Stop` with the next phase, so code
decides *whether* to continue and the model does the work.

**Memory** — a capped lesson store injected on matching prompts, over an episodic candidate log that is
captured automatically and never injected.

Everything is plain Node with **zero dependencies**, reading one config file.

## Install

```bash
npx github:HeisenbergI8/claude-harness init
```

Or clone and run it against a target repo:

```bash
git clone https://github.com/HeisenbergI8/claude-harness
node claude-harness/bin/harness-init.mjs /path/to/your/repo
```

It detects your project type (Node, Python, Go, Rust, Make), writes a starter `harness.config.json`,
copies the scripts to `.claude/harness/`, installs the agents and skills, scaffolds `CONVENTIONS.md`,
and **merges** hooks into `.claude/settings.json` without touching anything already there.

On a terminal it **asks you to confirm the two commands** and executes each one as you choose it,
because detection is a guess and a guess that was never run is checked only by a reader who already
knows the answer. A command that cannot run is reported with what the shell said and you get a second
chance at it. A command that runs and *fails* is reported as fine — that is a red tree, not a broken
setup.

With no terminal — CI, a pipe, `--yes` — it takes the detected values and prints the same check
without prompting. `--no-probe` skips running the commands entirely. An existing `harness.config.json`
is never re-prompted for; those values are yours.

Running it twice changes nothing. **Agents, skills and `CONVENTIONS.md` are never overwritten** — not
even with `--force`. Prompts get tuned in place, and silently replacing a tuned agent with the stock one
is invisible damage.

Then two steps people skip, in order of how much they matter:

**1. Fill in `CONVENTIONS.md`, and delete every section you do not fill.**

The agents are deliberately generic — they know how to plan, verify and audit, and nothing about your
project. This file is where that knowledge lives, and it is the difference between a plan grounded in
code that exists and one made of plausible-sounding advice. A scaffold left as-is is *worse* than no
file, because they will follow it. The selftest warns until you delete the marker at the top.

**2. Restart, run a turn, then check the harness is actually alive.**

```bash
node .claude/harness/selftest.mjs
```

Hooks are read at session startup, so nothing fires until you restart — and that window is exactly when
"configured" and "firing" differ.

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

- **`verify`** — your closing gate. Whatever you run when you want to know the tree is healthy.
- **`verifyFast`** — runs at the end of **every turn**, so it must be fast. A subset: typecheck only,
  or unit tests without the slow integration layer.

Everything else has a default. See [`docs/configuration.md`](docs/configuration.md) for source globs,
evidence patterns, thresholds, and per-gate switches, and
[`harness.config.example.json`](harness.config.example.json) for an annotated example.

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
- **The ALLOW half is the important half.** A green tree, a first failure, three *different* failures in
  a row, and every honest sentence — "I have not run the tests yet", "the suite failed, here is the
  output" — must pass untouched. Those are pinned verbatim in `test/claim-check.test.mjs`.

## Two more ideas, from the layers above the gates

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

## Troubleshooting

**Nothing happens — no gate ever fires.**
Almost always the restart. Hooks are read at session startup, so a session that was open during
install is running without them. Restart, take one turn, then run
`node .claude/harness/selftest.mjs`. If it reports hooks *registered* but says none have fired, the
restart did not take. If it reports `registers no hooks`, the merge into `.claude/settings.json` did
not happen — re-run the installer.

**Every turn is blocked by a command failure that has nothing to do with my code.**
Your `verifyFast` cannot run. Check it:

```bash
node .claude/harness/selftest.mjs --probe
```

A `CANNOT RUN` line names the command and what the shell said. Fix it in `harness.config.json` — set
it to whatever you genuinely run by hand — or install the tool it calls.

**It blocks too often.**
First check the block is wrong rather than inconvenient; that judgement is the whole point of the
tool. If a specific gate is genuinely not for you, switch it off in `harness.config.json` rather than
disabling everything:

```json
{
  "gates": {
    "reviewGate": { "enabled": false }
  }
}
```

`verifyGate`, `claimCheck`, `loopBreaker` and `heartbeat` take the same switch. See
[`docs/configuration.md`](docs/configuration.md) for thresholds you can loosen instead of disabling.

**I want it gone.**
Delete `.claude/harness/`, `harness.config.json`, and the harness entries under `hooks` in
`.claude/settings.json` — they are the ones whose commands mention `.claude/harness/`. Anything else in
that file was yours; the installer never touched it. The agents and skills in `.claude/agents/` and
`.claude/skills/` are ordinary Claude Code files and work with or without the harness, so keep them if
you like them.

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
