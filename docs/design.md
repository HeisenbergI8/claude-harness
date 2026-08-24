# Design notes

Why each mechanism is shaped the way it is, and what the obvious alternative gets wrong. Most of these
were learned by shipping the wrong version first.

---

## The premise: instructions are not behaviour

You can write "always run the tests before saying they pass" into `CLAUDE.md`. It will work most of the
time — which is the worst possible reliability. High enough that you stop checking, low enough that it
eventually costs you.

The general shape of the problem: **a rule that only exists as text is enforced by the same process it
constrains.** A model in a retry loop does not invoke its own anti-loop rule, because *not noticing* is
the failure. A model that believes the change is correct does not feel the difference between "checked"
and "obviously fine".

So the counter lives outside the model, and the record is written by something that has no opinion.

This has a corollary worth stating: everything here is a **guardrail, not a sandbox**. `disableAllHooks`
turns it all off, and a hook can never *do* anything — it can only refuse a turn and explain why. Where
this document says "enforced", read "refused and explained".

---

## The ledger

### Append-only, not read-modify-write

The natural implementation is one JSON object: read it, add your event, write it back. With a single
writer that is correct.

There is never a single writer. Any real pipeline runs concurrent subagents — a tester and an auditor
share no data, so sequencing them only adds the slower one's wall clock to the faster one's. Both fire
`PostToolUse`. Two processes read the same file and the slower write silently discards the faster one's
records.

The damage is not a lost log line. `claim-check` reads this file to decide whether a claim is supported,
so a dropped record turns an honest statement into a blocked turn — or worse, hides an edit that should
have demanded verification.

One appended line per event fixes it structurally with no lock: POSIX append is atomic below `PIPE_BUF`,
and every line here is far under it.

Compaction is the one racy operation left, so **only the main thread performs it** (`CLAUDE_AGENT_TYPE`
unset). Agents append and never rewrite; the main thread is never concurrent with itself, so the rewrite
has a single writer by construction.

The same reasoning applies to `hook-heartbeat.jsonl`. Its `.json` view is a *derived fold*, and its write
is deliberately left racy: two processes can fold and write out of order, leaving the view stale by one
event until the next beat regenerates it from the complete log. **A derived file that self-heals is a
different class of problem from a source of truth that loses data.**

### The writer owns the format

`record-activity.mjs` exports `readLedgerEvents`, `eventsForTurn`, `readTurn` and `recentEdits`. Every
consumer imports them rather than carrying its own "split on newlines, JSON.parse, swallow torn lines".

This is not tidiness. The worst bug class in a system like this is **a reader looking for a field the
writer never emits**. It fails silently and stays green, because the reader's own test fabricates the
shape the *reader* wants rather than the shape the *writer* produces. A gate can be dead for weeks that
way, and everything looks fine.

Exporting the reader from the writer makes agreement *structural* rather than merely tested: there is one
place a field name can change, and it is the same file that writes it.

`test/reader-writer.test.mjs` exists solely to detect that class, and every assertion in it drives the
real writer as a real subprocess. Rename a field in the writer alone and it goes red.

### "Recorded with no edits" vs "nothing recorded"

`readTurn` returns an `events` count alongside `edits`. These are different facts:

- **Recorded, zero edits** — this turn asked a question. Safe to exempt.
- **Nothing recorded** — unknown. The ledger might be missing, unwritable, or the hook might not have
  fired at all.

Conflating them is how a gate silently stops running: treat "unknown" as "no edits" and a broken recorder
exempts every turn forever, looking exactly like a clean tree. `verify-gate` takes the strict reading —
it skips only when the turn *is* in the ledger and carries zero edits.

---

## The repair loop

### It is an iteration primitive, not a brake

A blocking `Stop` hook re-invokes the model with `reason` as feedback. That is a loop. The obvious
implementation wastes it: block twice saying "fix it", then delete the counter and stand aside.

That version has three problems. Roughly one red tree in three walks through. The second block carries no
more information than the first. And there is no terminal state — no point at which a person is told the
thing is stuck.

| | brake | loop |
| --- | --- | --- |
| Predicate | "is the tree red?" | red, keyed on **which** failure |
| Reason | "fix it" — a complaint | the next action, plus what was already tried |
| Exhaustion | reset and allow | escalate, then **HALT** with a report |

### Progress, not attempts

This is the load-bearing idea.

Counting retries **punishes a loop that is converging** — three different fixes producing three different
failures is progress, and halting there wastes real work — and **rewards one that thrashes**, since a
reworded command reads as a fresh attempt.

So each iteration fingerprints the *failure set*: the failing lines, normalised, de-duplicated, sorted,
hashed. A changed fingerprint resets the counter. An unchanged one escalates.

**Line and column numbers are stripped before hashing.** The same error sliding down a file because
something above it changed is not progress; it is the same problem wearing a different address.

Sorting matters too: two tools that emit the same failures in a different order must hash identically, or
every run looks like progress.

An output with no recognisable failure line hashes to `unparsed`, which **blocks but never escalates**.
Escalating on a signature you could not read is escalating on noise.

### The escalation carries history

The last three attempts are appended to `attempts/<key>.jsonl` and injected into every escalation, so the
model reads its own failed hypotheses instead of reproducing them:

```
SAME FAILURE, attempt 2 of 3. The signature has not changed, so the last fix did not address the cause.

Already tried:
  · src/parser.ts, src/lexer.ts
  · src/parser.ts

Change the KIND of fix, not its details.
```

That is the difference between a loop and a nag. "Fix it" repeated three times produces three variations
of the fix that already failed.

### The halt is terminal

Three passes at one unchanged failure, and the loop stops: it writes `halt-report.md`, tells the model to
report to the user rather than attempt a fourth variation, and **never blocks that run again**.

The last clause is not a weakness. A gate that traps a session gets switched off, and a switched-off gate
protects nothing.

### The counter survives the block

`loop-breaker` had the same bug in its first version: it deleted the counter at the moment it blocked, so
the counter restarted the instant the block was issued. The same command could fail forever — blocked
every third time, with the identical message, never escalating.

**Blocking is a rung on the ladder, not the end of it.** The success path still deletes, and that is
correct: a command that passed has nothing left to count.

### Who is exempt

Read-only agents cannot repair a red tree. An auditor typically ships with no Edit/Write tool at all; a
tester is usually confined to test directories. A red tree is often the very thing they were *launched to
report on*.

Blocking them demands a repair they are structurally incapable of making — and every block replays the
agent's entire accumulated context, which on a long-running review agent is the single most expensive
thing this harness can do.

---

## Claim checking

### Two checks with different requirements

**A. Source touched, nothing verified.** Needs only the ledger. Always available.

**B. A claim with no supporting run.** Needs `last_assistant_message` on the `Stop` payload, which is not
guaranteed across builds. If it is absent this check silently does nothing and A still applies. Run
`node .claude/harness/claim-check.mjs --probe` to see what your build actually sends.

Designing B as a bonus rather than a dependency is why the gate still works when the field is missing.

### USE vs MENTION

A regex hunting for "all tests pass" cannot distinguish an *assertion* from a *quotation*. And this gate's
own subject is that sentence, so any message documenting it trips forever.

In the system this was extracted from, the naive matcher fired **29 times in one session**. The recurring
shapes were: pasted command output inside a fenced block, a pattern list in a table, a proposed
termination condition, and an acceptance criterion in a ticket. The 29th fired on the table enumerating
the first 28.

Worse than noisy — **pasting real output as evidence is the practice you most want to encourage**, and the
naive matcher penalised precisely that while a bare prose assertion, the thing the gate is *for*, looked
identical to it.

`stripQuoted` removes fenced blocks, inline code and bounded quoted spans before matching. Two choices in
it are deliberate:

- **Bold is not stripped.** A genuine claim is often written **in bold for emphasis**, and stripping it
  would let the exact sentence this gate exists for walk straight through.
- **Quoted spans are bounded and single-line.** An unbounded `"[^"]*"` swallows everything between two
  distant quotes, which could hide a real claim sitting between them.

The same problem applies to *commands*: `grep -rn "npm run verify" docs/` does not verify anything.
Classification is therefore scoped to the binary being invoked, per command segment, never to the raw
string — see [configuration.md](configuration.md#what-is-deliberately-not-counted).

### Narrow on purpose

The patterns catch claims of *fact* about a run. Hedged and honest language passes untouched, and every
one of these is pinned verbatim as a test:

> "I have not run the tests yet" · "next I should run the tests" · "the suite failed — 3 of 40 are red" ·
> "this change is unverified; I did not have a way to exercise the UI"

Two patterns were narrowed after firing on prose *about* verification rather than claims of it — "a zero
exit means PASS", "the baseline unchanged **line** is what proves it". They now require a verification
noun within ~45 characters, and the `unchanged` pattern carries a negative lookahead separating
"unchanged" as a *state* from "unchanged" as a *modifier*.

The gate exists for one sentence: an assertion that a gate is green when no run supports it. Everything
else is collateral.

---

## Liveness

A hook can be registered, schema-valid, and completely inert. Nothing detects it, because **a guard that
never runs looks exactly like a guard with nothing to do.**

`hook-heartbeat.mjs` records which hooks fired and what their payloads carried. `selftest.mjs` compares
that against what `settings.json` registers and *fails* on anything registered but never seen.

Two details make the signal trustworthy:

- **Test invocations do not count.** `CLAUDE_HOOK_TEST=1` suppresses the beat. A hook driven by its own
  test suite must not register as alive — that inverts the one signal the file exists to give.
- **Only instrumented hooks are reported.** A hook that does not call `beat()` is simply not measured, and
  saying so keeps the report from overclaiming. A false alarm is how an alarm gets ignored.

It also records payload **key names** — never values, which would put assistant message text on disk — so
"does this build send `last_assistant_message`?" is answered by evidence rather than by hope.

`verify-gate` beats twice, once under an event-scoped name, because it is registered on both `Stop` and
`SubagentStop` and the two payloads' key sets would otherwise merge into one unreadable union.

---

## The promotion ladder

Every gate here sits somewhere on the fail-open/fail-closed axis, and the docs say where. What they did
not say is **how a check moves along it**, which is the decision people actually get wrong — a check
written confidently and wired to block on day one is a check that fires on a legitimate action in week
one and is deleted in week two.

A new check earns blocking status. It does not start with it.

| Rung | Wiring | What it means |
| --- | --- | --- |
| 1. Reporting | `node .claude/harness/<check>.mjs`, run by hand | It has no opinion about your turn. You look at it when you want to. |
| 2. Advisory | `(node .claude/harness/<check>.mjs \|\| true)` inside your verify command | It speaks on every run and can never stop one. Its false positives cost attention, not work. |
| 3. Blocking | A hook, or an unguarded line in `verify` | It can refuse a turn. |

The bar for each promotion is **evidence, not confidence**: the check has been quiet across several
different areas of the repo for a couple of weeks, and every time it did fire you agreed with it. A check
that has fired once on correct work is not ready, however good the reasoning behind it was.

This is the mechanical form of the rule the whole harness runs on — *a guard that refuses the correct
action protects nothing.* Note which way the ladder is walked: **down is free, up is earned.** Demoting a
noisy blocking check to advisory takes one `|| true` and keeps its signal; deleting it loses the signal
permanently, and deletion is what happens to a check nobody trusts.

Two things that stay true at every rung:

- **Scope narrowly, and write down what the check deliberately does *not* fire on.** The exclusions are
  load-bearing, and an undocumented exclusion reads as an oversight to the next person, who removes it.
- **Unparseable is not clean.** A check that cannot read its input reports that it could not, and never
  counts the input as passing. A checker whose silence means "fine" goes green for the life of the repo
  while reading a field the writer never emitted.

---

## Agent locks

Two Claude Code sessions in one checkout are two models that cannot see each other. The failure is not a
merge conflict — git would report that. It is silent, and it was observed:

Session B has uncommitted work in progress. Session A reads those files, finds nothing marking them as
anybody's, and edits them. Or A runs the fast check, sees B's half-finished module go red, and sets
about repairing it — because *from inside A, a red check is indistinguishable from a defect*.

### Staleness is a property of reading, not an operation

The obvious implementation is a lock table: read it, add your entry, write it back, and have somebody
sweep the expired rows. Both halves are wrong here, for the same reason.

Read-modify-write cannot be right in a mechanism whose entire premise is concurrent writers — the slower
writer discards the faster one's claim, and **a dropped claim produces exactly the stomp the lock was
taken to prevent**, silently, failing open. So the record is an append-only log of claim / refresh /
release events, and the current lock table is a fold over it. Same reasoning as the ledger, higher
stakes: a lost ledger line costs a gate one fact, a lost claim costs somebody their work.

Once it is a fold, expiry stops being an operation. A lock nothing has refreshed inside `staleMs` simply
is not in the fold. Nobody sweeps it; there is no cron, no `SessionStart` cleanup, and no dependence on
`Stop` firing — which matters, because when a session crashes `Stop` is exactly what does not fire. The
release hook is a promptness optimisation, and it says so in its own header, because a release mechanism
the correctness of the system depended on would have to be reliable, and hooks are not.

### The deny does not name its own escape hatch

The first draft ended with `run --release-all to override`. **The model has Bash.** A refusal that
explains how to clear itself is a refusal that gets cleared rather than obeyed, and the mechanism becomes
decoration with a state file attached.

The escape hatches are real — `maxBlocks`, `AGENT_LOCKS_DISABLE=1`, the CLI — and they are documented
where a *person* reads them. What the model is told is the true thing: somebody else is working here,
their files on disk are work in progress rather than a mistake, stop and say so. It also carries the
non-destructive way to establish whether a failure is yours (`git show HEAD:<path> | diff - <path>`),
because the reflex it is competing with is `git stash && <check> && git stash pop` — which `guard-destructive`
refuses, since a `pop` that conflicts buries whatever was uncommitted, and that may be the other session's.

### The scope function is configuration, not cleverness

`moduleRootOf` is the highest-risk function in the mechanism: a bug in it produces false refusals, which
is the one failure this cannot survive. It is therefore driven by `locks.roots`, and **its default is
exact-file scope** — the narrowest true positive. Two sessions editing the same file is a conflict in
every project; two sessions in the same directory is not. Widening to a module grain is an explicit act
by somebody who knows their own repo.

Containment respects segment boundaries in both directions, or a lock on `sc-winner` blocks every write
to `sc-winner-extra`. And `locks.shared` exists because without it the first session to register a module
locks the shared registry every module edits, and denies everyone else's correct registration forever.

### It is off by default

Applying the promotion ladder to the mechanism's own shipping. It is also honest scoping: a repo where
one session runs at a time gets nothing from this but a chance to be wrong, and a repo that gives each
session its own `git worktree` has solved the problem completely rather than partially.

## Testing philosophy

**The ALLOW half is the important half.** A gate that blocks honest work gets switched off, and a
switched-off gate protects nothing — so the cases that must *pass* are load-bearing, and there are more of
them than blocking cases.

**Decisions are pure functions.** Every gate exports `decide()`. A gate whose logic can only be exercised
end-to-end is a gate whose allow cases never get tested, because writing thirty subprocess invocations is
tedious enough that nobody does it.

**But the wiring is tested too.** `gates.e2e.test.mjs` drives the real scripts as real subprocesses with
real payloads against a real config, because passing every unit test and being completely inert are
compatible states.

**Try breaking it.** The best evidence a mechanism is load-bearing is that removing it goes red:

| Revert this | And these fail |
| --- | --- |
| Fingerprint → attempt counting | "three DIFFERENT failures in a row never halt" |
| Keep line numbers in the fingerprint | "the same error at a different line is the SAME failure" |
| Delete the loop-breaker counter on block | "the count survives the block, so a second block halts" |
| Drop `stripQuoted` | every USE-vs-MENTION case |
| Classify against the raw command string | every "MENTION is not evidence" case |
| Rename a ledger field in the writer only | most of `reader-writer.test.mjs` |
| `basename` → `endsWith` in `agent-locks.mjs` | 7 lock cases — `guard-agent-locks.mjs` ends with `agent-locks.mjs`, so the guard runs the library's CLI on import and exits before reading its payload |
