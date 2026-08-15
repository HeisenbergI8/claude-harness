# Configuration

One file, `harness.config.json`, at your repository root. Every gate reads it.

**Commit it.** It defines what "verified" means for this project, which makes it the one input that
decides whether a gate can be satisfied at all. A definition of passing that can be widened without
appearing in a diff is not a gate, it is a suggestion. The loader also accepts
`.claude/harness.config.json` for projects that track that directory, and the selftest warns if it finds
the config there — because `.claude/` is gitignored in many repos.

The minimum useful config:

```json
{
  "commands": {
    "verify": "make check",
    "verifyFast": "make typecheck"
  }
}
```

Everything below has a default. Set only what you are changing — the defaults live in
`.claude/harness/config.mjs` and restating them in your config just gives them somewhere to drift from.

---

## `commands`

| Key | Runs when | Notes |
| --- | --- | --- |
| `verify` | when the model believes it is done | Recorded in the ledger as `verify`. Your full gate. |
| `verifyFast` | at the end of **every turn**, by `verify-gate` | Must be fast. Falls back to `verify` when unset, which is usually too slow. |

If your full gate takes ten seconds, `verifyFast` should take three. It runs on every turn including the
ones where you asked a question, so its cost is paid constantly.

Leave both `null` and the harness is inert but harmless: `verify-gate` stands aside, and `claim-check`
still catches "edited source, ran nothing".

### Examples

```jsonc
// Node
{ "verify": "npm run verify", "verifyFast": "npm run typecheck" }

// Python
{ "verify": "ruff check . && mypy . && pytest -q", "verifyFast": "ruff check . && mypy ." }

// Go
{ "verify": "go build ./... && go vet ./... && go test ./...", "verifyFast": "go build ./... && go vet ./..." }

// Rust
{ "verify": "cargo check && cargo clippy && cargo test", "verifyFast": "cargo check" }

// Anything with a Makefile
{ "verify": "make check", "verifyFast": "make typecheck" }
```

---

## `source`

What counts as source for the purposes of *"you edited source and verified nothing"*.

```json
{ "source": { "include": ["src/**", "tests/**"], "exclude": ["**/*.md"] } }
```

Repo-relative globs. `**` crosses directory separators, `*` does not. `exclude` wins over `include`, and
anything outside the repository is never source.

**`include` REPLACES the default list; it does not extend it.** A user narrowing the definition of source
should get the narrow definition they asked for.

Keep docs, plans and config out of it. A turn that only touched `README.md` did not break the build, and
blocking it teaches the model to read the gate as noise — which is how a gate ends up switched off.

Default: `src/** lib/** app/** pkg/** internal/** cmd/** test/** tests/**`, excluding `**/*.md`,
`**/*.txt`, `**/*.lock`, `**/__snapshots__/**`.

---

## `evidence`

Which shell commands count as evidence about the health of the tree. Each match becomes a ledger event
with that `kind`.

You rarely need this. Patterns are assembled in three layers, first match winning:

1. **Derived from `commands`** — your `verify` and `verifyFast` are recognised automatically, whatever
   they are.
2. **Your `evidence.patterns`** — for anything else you run that should count.
3. **The builtin catalog** — npm/pnpm/yarn/bun scripts, pytest, jest, vitest, go test, cargo test,
   node --test, mvn, gradle, rspec, phpunit, dotnet, ctest, tsc, mypy, pyright, go vet, cargo check,
   eslint, ruff, flake8, pylint, clippy, golangci-lint, rubocop, playwright, cypress.

```json
{
  "evidence": {
    "patterns": [{ "kind": "test", "match": "bazel\\s+test\\s+//" }],
    "useBuiltins": true
  }
}
```

`match` is a JavaScript regex **source string** (so backslashes are doubled in JSON), matched
case-insensitively. Set `useBuiltins: false` to recognise only your own patterns plus the derived ones.

### What is deliberately NOT counted

Classification is scoped to the **binary being invoked, per command segment** — never the raw string.
Quoted arguments are stripped first, the command is split on `;`, `&&`, `||` and `|`, and any candidate
whose leading binary is a text tool (`echo`, `grep`, `rg`, `cat`, `sed`, `find`, …) is dropped.

So `grep -rn "npm run verify" docs/` is not evidence. Counting it would credit a turn that ran nothing
with a green gate — this harness's own failure mode, arriving through its own front door.

The consequence to know about: a `verify` command that *starts* with a text tool (`"verify": "echo done"`)
can never be recorded. The selftest fails on that rather than letting you discover it in a month.

---

## `gates`

Each gate can be tuned or switched off.

```json
{
  "gates": {
    "verifyGate": { "enabled": true, "maxSameFailure": 3 },
    "claimCheck": { "enabled": true, "maxBlocks": 2, "extraClaimPatterns": [] },
    "loopBreaker": { "enabled": true, "injectAt": 2, "blockAt": 3 },
    "reviewGate": { "enabled": true },
    "heartbeat": { "enabled": true }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `verifyGate.maxSameFailure` | 3 | Attempts against **one unchanged failure signature** before halting. Different failures reset the count. |
| `claimCheck.maxBlocks` | 2 | Consecutive blocks before standing aside. It must never be able to trap a session. |
| `claimCheck.extraClaimPatterns` | `[]` | Extra regexes meaning "I am asserting a gate is green". Keep them narrow — hedged language must pass. |
| `loopBreaker.injectAt` | 2 | Consecutive failures of one command before a non-blocking warning. |
| `loopBreaker.blockAt` | 3 | Before blocking. A second block halts. |

Raising `maxSameFailure` is usually the wrong instinct. If a loop is halting too early, the fingerprint is
probably not distinguishing failures your ecosystem produces — check whether `verify-gate`'s `FAILURE_LINE`
recognises your tool's output, because an unrecognised failure degrades to `unparsed`, which blocks but
never escalates.

---

## `gates.editCheck`

```json
{
  "commands": { "editCheck": "tsc --noEmit -p tsconfig.json" },
  "gates": { "editCheck": { "graceMs": 400, "windowMs": 15000, "paths": [] } }
}
```

**Off unless `commands.editCheck` is set.** Runs that command right after a source file is written, so
the class of defect hand edits and merges produce — an unbalanced tag, a dropped import — surfaces while
the model still has the file in front of it rather than three edits later.

It must be **faster than `verifyFast`**: a per-file or per-project typecheck, not the suite.

A check on every edit is a check that runs many times a turn, most of them worthless. Measured on 269
edits in one session of the project this came from: a full typecheck per edit was 2.11s each, 568s
total, and two facts made most of those runs pointless — 31% of edits landed within 0.4s of another
(parallel tool calls in one message, so the check ran on a half-applied refactor and blocked on errors
the very next edit was about to fix), and the median gap between edits was 10.7s.

| Key | Default | What it does |
| --- | --- | --- |
| `graceMs` | `400` | Wait, then stand down if a newer edit arrived — the later hook has the more complete tree |
| `windowMs` | `15000` | Skip if the last run was **green** and more recent than this |
| `paths` | `[]` | Which files it applies to. Empty means whatever `source` already says is source |

**Every skip fails safe.** A suppressed check can only *defer* a check, never approve a broken tree —
`verify-gate` still runs on `Stop` and `SubagentStop`, and `implement-plan` gates every phase boundary.
This is early warning; those are the boundary.

**A red result is never suppressed.** Failure clears the green timestamp, so the next edit checks
immediately: a broken tree gets fast feedback, a healthy one does not.

A command that cannot *start* stands aside rather than blocking, using the same classifier the installer
uses to tell "the binary is missing" from "your tree is red". Blocking every edit forever over a setup
mistake is how a gate gets ripped out.

---

## `readOnlyAgents`

```json
{ "readOnlyAgents": ["tester", "auditor", "change-auditor", "Explore"] }
```

Agents with no write access to source. They are **exempt from the repair loop**, because blocking them
demands a repair they are structurally incapable of making — and every block replays the agent's entire
accumulated context, which on a long-running review agent is the most expensive thing this harness can do.

Names match the `name:` in the agent's frontmatter, which is what arrives on the hook payload as
`agent_type`. Add yours if you define read-only agents.

---

## `preflight`

```json
{
  "preflight": {
    "cleanTree": true,
    "treeGreen": true,
    "reachable": ["${env:API_BASE_URL}", "http://localhost:3000"],
    "commands": ["npm run check:toolchain"],
    "maxConsecutiveFailures": 2
  }
}
```

Entry conditions, checked **before** a task-loop run spends an iteration — by `/build` at the start, and
by the driver between iterations for the two list-shaped checks.

**A precondition that lives as a line in a report is not a precondition.** A person reading
`backend: no` stops. A loop reads it, carries on, and spends its whole budget verifying loading
skeletons — every screen renders, every check passes, and none of it means anything.

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Set false and every check stands aside |
| `cleanTree` | `true` | Refuse to start on a dirty tree. **Entry only** — never re-checked mid-run, because by iteration two the loop has been editing on purpose. Untracked files are ignored deliberately: refusing to start because someone left a `TODO.md` around is how this becomes the first check anyone disables |
| `treeGreen` | `true` | Runs `commands.verifyFast`. **Refuse, do not repair** |
| `reachable` | `[]` | URLs the work depends on. `${env:NAME}` resolves from the environment |
| `commands` | `[]` | Anything that must exit 0 — a toolchain check, a migration status |
| `maxConsecutiveFailures` | `2` | Consecutive between-iteration failures before the run halts |

Three behaviours worth knowing:

- **Refuse, do not repair.** A run that begins by fixing something it did not cause can no longer say
  which part of its own diff is its work — and *what did this run change* is the first question asked at
  halt time.
- **Any HTTP response counts as reachable.** A service whose root 404s is still listening; only a
  transport error or a timeout means it is not there. A `${env:NAME}` that resolves to nothing is
  reported as **unset**, never as unreachable — those need different fixes, and reporting the second for
  the first sends someone to check a server that is fine.
- **Failures are counted, not immediate.** One flaky response is not evidence a dependency is down, and
  killing a four-hour run over a dropped connection is its own failure. The count lives in the run
  record; `preflight.mjs` itself has no memory, because it answers only *is this healthy right now*.

`reachable` and `commands` are empty by default, and when both are empty the driver skips the check
entirely — so a project that configures nothing pays nothing per turn.

---

## `state`

```json
{ "state": { "dir": ".claude/.harness" } }
```

Everything written at runtime — ledger, counters, attempt logs, heartbeat, halt reports — lives under one
directory. `harness-init` adds it to `.gitignore`. Delete it any time; it all regenerates.

| File | Contents |
| --- | --- |
| `ledger.jsonl` | Append-only record of edits, runs and subagent completions, keyed by turn |
| `verify-state.json` | Repair-loop counter and current failure fingerprint, per agent |
| `attempts/<key>.jsonl` | What each repair attempt touched — injected into escalations |
| `halt-report.md` | Written when the repair loop gives up |
| `claim-state.json`, `loop-state.json` | Consecutive-block counters |
| `heartbeat.jsonl` / `.json` | Which hooks fired, and their payload key names |

---

## `verifyTimeoutMs`

Default `120000`. How long `verify-gate` waits for `verifyFast` before standing aside. A gate that hangs
is worse than a gate that misses.
