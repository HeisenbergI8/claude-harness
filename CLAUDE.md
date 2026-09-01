# provenly

Installer plus template for a Claude Code guardrail harness: an activity ledger, gates that read it,
guards, agents and a supervised task loop. Node ≥18, **zero dependencies**, ESM only.

This repo is the *cargo*, not a consumer of it. Nothing under `template/` runs here — it is copied into
a target repo by the installer.

## Read this first

[CONTRIBUTING.md](CONTRIBUTING.md) is binding for anything under `template/.claude/harness/`. Its six
rules — fail open, bound your blocking, positive evidence only, export `decide()` as a pure function,
zero dependencies, whoever writes a format exports its reader — are not style preferences; each one is
the difference between a gate people keep switched on and a gate people disable.

The canonical gate to model a new one on: `template/.claude/harness/claim-check.mjs`.

## Commands

| Purpose | Command |
| --- | --- |
| Full check | `npm test` |
| Tests, one file | `node --test test/guards.test.mjs` |
| Install into a repo | `node bin/harness-init.mjs /path/to/repo --dry-run` |

There is no install step and no build. `npm run verify` is an alias for `npm test`.

## Where things live

| Path | Owns |
| --- | --- |
| `template/.claude/harness/` | the gate and guard scripts — the actual harness |
| `template/.claude/settings.json` | the hook wiring merged into a target repo |
| `template/.claude/agents/`, `skills/` | prompts, never overwritten once installed |
| `bin/harness-init.mjs` | installer: detect, copy, merge, never clobber |
| `test/` | `node:test`, driving the real scripts against temp repos |
| `docs/` | design rationale, configuration, hooks reference |

`template/` is the single source of truth — the tests import from it and the installer copies from it,
so there is no second copy to drift.

## Traps

- **Hooks are read once, at session startup.** Nothing changed in `settings.json` takes effect until
  Claude Code restarts. This is the single most common "the harness does not work" report.
- **Per-agent `hooks:` frontmatter is silently inert.** Observed schema-valid and never firing while
  `settings.json` hooks fired normally in the same session. Scope inside the script by reading
  `agent_type` off the payload. (`tools:` in frontmatter *does* work.)
- **Editing a copied script changes nothing here.** A repo installed for testing holds a copy; fix
  `template/` and reinstall.
- **Script names nest here too.** `guard-agent-locks.mjs` and `release-agent-locks.mjs` both end with
  `agent-locks.mjs`, so the usual `process.argv[1]?.endsWith(name)` main-guard makes them run the
  library's CLI on import. Those three compare `basename` instead; a new script whose name is a suffix
  of another's must do the same.
- **`BUILTIN_EVIDENCE` in `config.mjs` is ordered and first-match-wins**, because script names nest:
  `verify:fast` precedes `verify` (which carries a lookahead so it cannot swallow its own
  colon-suffixed variants), and `e2e` precedes `test` so `test:e2e` is not read as a plain test
  run. Adding an ecosystem means adding a pattern *and* a `config.test.mjs` case in both directions.
- **Agents, skills and `CONVENTIONS.md` are never overwritten in a target repo**, not even with
  `--force`. Those are prompts the user has tuned; silently restoring the stock version is invisible
  damage.
- **Not every gate exports `decide()`** — nine of them do. A new blocking gate should.

## Tests

The ALLOW half is the important half: a new blocking rule needs more passing cases than failing ones,
and they should be sentences a careful engineer would actually write. Where wiring matters, drive the
real thing — `reader-writer.test.mjs` and `gates.e2e.test.mjs` spawn the actual scripts against a temp
repo built by the actual installer. A fixture that fabricates the shape the reader wants is how a dead
gate stays green.
