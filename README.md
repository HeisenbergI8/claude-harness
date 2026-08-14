# claude-harness

**Mechanical evidence for Claude Code.** A per-turn ledger of what actually ran, a gate that blocks
unsupported claims that the tests passed, and a repair loop that escalates on *stuck* failures rather
than on retries.

No dependencies. Any language. Drop it into a repo, declare two commands, restart the session.

```bash
npx github:johnrossrivera/claude-harness init
```

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

| Mechanism | Event | What it enforces |
| --- | --- | --- |
| `record-activity` | every tool call | Writes an append-only ledger: which source files were edited, which verification commands ran, and each one's exit code |
| `claim-check` | `Stop` | Blocks a turn that edited source and verified nothing — or that asserts a green gate the ledger cannot support |
| `verify-gate` | `Stop`, `SubagentStop` | Runs your fast check. Red tree → **block** → **escalate** → **HALT** with a written report |
| `loop-breaker` | `PostToolUse` | Counts consecutive failures of the same command. Warns at 2, blocks at 3, halts on a second block |
| `hook-heartbeat` | called by the others | Records that hooks fired and what their payloads carried, so "configured" and "firing" can be told apart |
| `selftest` | you run it | Answers whether the harness is working or merely installed |

Everything is plain Node with zero dependencies, reading one config file.

## Install

```bash
npx github:johnrossrivera/claude-harness init
```

Or clone and run it against a target repo:

```bash
git clone https://github.com/johnrossrivera/claude-harness
node claude-harness/bin/harness-init.mjs /path/to/your/repo
```

It detects your project type (Node, Python, Go, Rust, Make), writes a starter `harness.config.json`,
copies the scripts to `.claude/harness/`, and **merges** hooks into `.claude/settings.json` without
touching anything already there. Running it twice changes nothing.

Then — and this is the step people skip:

```bash
# 1. restart your Claude Code session; hooks are read at startup
# 2. run one turn
# 3. confirm the hooks actually fired
node .claude/harness/selftest.mjs
```

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

## What is deliberately not here

This is the evidence layer. It ships **no agents, no skills, no planning pipeline, and no task loop** —
those are valuable, but they are opinions about how you should work, and they are much harder to make
project-agnostic. The ledger and the gates are the part that is true regardless of your workflow.

Two honest limits, stated plainly:

- **`disableAllHooks` turns all of this off.** It is a guardrail, not a sandbox.
- **A hook cannot spawn an agent.** It can only refuse a turn and say what to do. Anything described
  here as "enforced" means "refused and explained", never "performed automatically".

## Development

```bash
npm test                    # 142 assertions, both directions
node bin/harness-init.mjs --dry-run /path/to/repo
```

Tests use only `node:test`. There are no dependencies to install.

## Provenance

Extracted and generalised from a private harness built for a production frontend repository, where each
mechanism here earned its place by failing first. The specific incident counts quoted in the code
comments are from that system; the reasoning is what carried over. Nothing project-specific remains.

## License

MIT — see [LICENSE](LICENSE).
