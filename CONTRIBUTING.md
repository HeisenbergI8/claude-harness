# Contributing

```bash
git clone https://github.com/HeisenbergI8/claude-harness
cd claude-harness
npm test        # no install step — there are no dependencies
```

## The shape of the project

```
template/.claude/harness/   the scripts that get copied into a target repo — the actual harness
template/.claude/settings.json   the hook wiring that gets merged in
bin/harness-init.mjs        installer: detect, copy, merge, never clobber
test/                       node:test, driving the real scripts
docs/                       design rationale, configuration, hooks reference
```

`template/` is the single source of truth. The tests import from it directly and the installer copies
from it, so there is no second copy to drift.

## Rules for anything under `template/.claude/harness/`

These are not style preferences. Each one is the difference between a gate people keep switched on and a
gate people disable.

**1. Fail open.** An unparseable payload, a broken config, an unreadable ledger, a command that would not
start — every one of these exits 0. A gate that traps a session gets disabled, and a disabled gate
protects nothing.

**2. Bound your blocking.** Every blocking gate keeps a counter and stands aside once it has made its
point. There must be no state from which the session cannot proceed.

**3. Positive evidence only.** Failure detection returns *false* when it cannot tell. Never infer a
failure from an unrecognised payload shape — a spurious block is far more expensive than a miss.

**4. Export `decide()` as a pure function.** No filesystem, no payload, no subprocess. A gate whose logic
can only be exercised end-to-end is a gate whose allow cases never get tested.

**5. Zero dependencies.** Node standard library only. A harness that a project must `npm install` to run
is one more thing the project can break.

**6. Whoever writes a format exports its reader.** Do not add a second parse loop for the ledger or the
heartbeat. If you need a new view, add it to the writer and export it.

## Rules for tests

**The ALLOW half is the important half.** A new blocking rule needs more passing cases than failing ones,
and they should be things a careful engineer would actually write or run. If you add a claim pattern,
add the honest sentences it must not catch.

**Drive the real thing where wiring matters.** `reader-writer.test.mjs` and `gates.e2e.test.mjs` spawn the
actual scripts against a temp repo installed by the actual installer. A fixture that fabricates the shape
the reader wants is how a dead gate stays green.

**Prove the mechanism is load-bearing.** The best justification for a mechanism is that removing it turns
tests red. `docs/design.md` keeps a table of these; add a row if you add a mechanism.

## Changing the evidence catalog

`BUILTIN_EVIDENCE` in `config.mjs` is ordered, first-match-wins, and script names nest — `verify:fast`
before `verify`, `test:e2e` before `test`. Adding an ecosystem means adding a pattern *and* a case in
`config.test.mjs`, in both directions: the command counts as evidence, and a `grep` for it does not.

## Commits and PRs

- One mechanism per PR. These files are small and dense; a mixed diff is hard to reason about.
- Say what failure the change prevents, not just what it does. The code comments here are load-bearing
  documentation — if a change makes one wrong, fix the comment in the same commit.
- `npm test` must be green. If you had to weaken an assertion to get there, say so explicitly in the PR;
  that is usually the finding rather than the fix.

## Scope

This is the evidence layer: the ledger and the gates that read it. Agents, skills, planning pipelines and
task loops are deliberately out of scope — they are opinions about how to work, and they do not
generalise across projects the way a record of what ran does.

Proposals that make the harness *more* portable, or that close a way for a gate to be silently inert, are
the most welcome kind.
