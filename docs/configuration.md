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
