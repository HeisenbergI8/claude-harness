# Hooks reference

What is registered, when it fires, and what it can do.

## Wiring

`harness-init` merges this into your `.claude/settings.json`, keyed on the script each hook invokes — so
running it twice adds nothing, and hooks you already had are never displaced.

| Event | Matcher | Script | Blocking |
| --- | --- | --- | --- |
| `PostToolUse` | `Write\|Edit\|NotebookEdit\|MultiEdit\|Bash` | `record-activity.mjs` | no |
| `PostToolUse` | `Bash` | `loop-breaker.mjs` | yes |
| `PostToolUseFailure` | `Bash` | `record-activity.mjs`, `loop-breaker.mjs` | yes |
| `SubagentStop` | — | `record-activity.mjs`, `verify-gate.mjs` | yes |
| `Stop` | — | `claim-check.mjs`, `verify-gate.mjs` | yes |
| `Stop` | — | `lesson-capacity.mjs`, `lesson-prompt.mjs` | yes |

`hook-heartbeat.mjs` is never registered directly — the others call it.

**Hooks are read at session startup.** Editing `settings.json` does nothing until you restart, and that
window is exactly when "configured" and "firing" differ. Run `selftest.mjs` after a restart and one turn.

## What a hook can and cannot do

A hook is a shell command. It receives a JSON payload on stdin and may print one JSON object on stdout.

It **can**: refuse the turn (`{"decision":"block","reason":"…"}`), inject context
(`{"hookSpecificOutput":{"additionalContext":"…"}}`), deny a tool call from `PreToolUse`, or stay silent.

It **cannot** spawn an agent, call a tool, or modify the conversation. Anything this project calls
"enforced" means *refused and explained*, never *performed automatically*.

A blocking `Stop` hook re-invokes the model with `reason` as feedback. That is what makes the repair loop
possible — and what makes an unbounded blocking gate able to trap a session, which is why every gate here
counts its blocks and eventually stands aside.

## Payload fields used

Field shapes are not guaranteed stable. Every gate probes rather than asserts, and the heartbeat records
which keys actually arrived so you can check your own build.

| Field | Used by | Notes |
| --- | --- | --- |
| `hook_event_name` | all | Distinguishes `PostToolUse` from `PostToolUseFailure` |
| `prompt_id` | ledger | The turn boundary. Falls back to `session_id` |
| `session_id` | all | Counter scope |
| `agent_id` | verify-gate, loop-breaker | Per-agent counter scope, so a subagent never inherits the main thread's count |
| `agent_type` | verify-gate, ledger | Matches `readOnlyAgents`; records which subagent finished |
| `tool_name`, `tool_input` | ledger, loop-breaker | `file_path` and `command` |
| `tool_response` | ledger, loop-breaker | Probed across `exit_code`, `exitCode`, `code`, `status`, `returnCode`, `is_error`, `isError`, `error`, `failed` |
| `tool_use_id` | loop-breaker | De-duplicates a command that fires on both post-tool events |
| `stop_hook_active` | Stop gates | Already inside a blocked-and-resumed turn; blocking again traps the session |
| `last_assistant_message` | claim-check | **Not guaranteed.** Check B degrades silently when absent |

### Probing your build

```bash
echo '{"hook_event_name":"Stop","session_id":"s"}' | node .claude/harness/claim-check.mjs --probe
echo '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"pytest -q"}}' \
  | node .claude/harness/record-activity.mjs --probe
node .claude/harness/loop-breaker.mjs --debug < payload.json
node .claude/harness/hook-heartbeat.mjs
```

`--probe` and `--debug` print to **stderr** and exit without acting, so they are safe to run against a
live repo.

## Inspecting state

```bash
node .claude/harness/selftest.mjs                 # is the harness working, or merely installed?
node .claude/harness/hook-heartbeat.mjs           # which hooks fired, and what their payloads carried
node .claude/harness/hook-heartbeat.mjs --reset   # clear the liveness record
cat .claude/.harness/ledger.jsonl                 # what actually happened, per turn
cat .claude/.harness/halt-report.md               # why the repair loop gave up
```

Wire the selftest into your own gate so the harness is checked by the thing it enforces:

```json
{ "scripts": { "verify": "npm run typecheck && npm test && node .claude/harness/selftest.mjs" } }
```

## Turning it off

Per gate, in `harness.config.json`:

```json
{ "gates": { "verifyGate": { "enabled": false } } }
```

Entirely: remove the entries from `.claude/settings.json`, or delete `.claude/harness/`. Claude Code's
own `disableAllHooks` also turns everything off — this is a guardrail, not a sandbox.

## Settings posture — what belongs in `settings.json` rather than in a guard

The harness installs hooks and nothing else. These four keys are Claude Code's own, not the harness's,
and `harness-init` never writes them — but they sit alongside the gates and each one covers something a
script cannot. Add them by hand if you want them.

```jsonc
{
  "permissions": { "disableBypassPermissionsMode": "disable" },

  "autoMode": {
    "hard_deny": [
      "$defaults",
      "Deleting, moving, or overwriting any file outside the current repository — including anything under the home directory, Desktop, or another project. There is no task for which this is correct; ask the user to do it themselves.",
      "git clean, git reset --hard, git checkout -- ., or git restore . — these destroy uncommitted work and untracked files with no way back.",
      "Recursive deletion of a directory the user did not explicitly name in this conversation."
    ]
  },

  "includeCoAuthoredBy": false,
  "attribution": { "commit": "", "pr": "", "sessionUrl": false }
}
```

**`autoMode.hard_deny` is belt-and-braces with `guard-destructive.mjs`, not a replacement for it.** The
two fail in opposite directions, which is the entire reason to run both:

- The guard is deterministic. It matches command *shape*, so it catches `git reset --hard` however it is
  phrased — and it cannot catch a destructive action expressed in a form nobody anticipated.
- `hard_deny` is read by a classifier. It generalises to shapes no regex was written for — and it can be
  talked around, so it is not something to rely on alone.

Keep `$defaults` in the list. Replacing it rather than extending it silently drops every deny Claude Code
ships with.

**`includeCoAuthoredBy: false`** stops the `Co-Authored-By: Claude` trailer being appended to commits.
Worth knowing that it is a repo-level choice with a repo-level consequence: those trailers put the
assistant in a repository's contributor list.

## Adding your own gate

The plumbing is exported from `config.mjs`:

```js
#!/usr/bin/env node
import { block, load, readPayload, turnKey } from './config.mjs'
import { beat } from './hook-heartbeat.mjs'
import { readLedgerFile, readTurn } from './record-activity.mjs'

const payload = await readPayload()

if (!payload) process.exit(0)          // unparseable: stand aside, never trap a turn

const config = load()

beat('my-gate', payload, config)        // so the selftest can see it is alive

const { edits, runs } = readTurn(readLedgerFile(config), turnKey(payload))

if (edits.length && !runs.length) block('…')

process.exit(0)
```

Four rules if you want it to survive contact with real use:

1. **Fail open.** No payload, no config, no ledger → exit 0.
2. **Bound your blocking.** Keep a counter and stand aside once you have made your point.
3. **Export `decide()` as a pure function** and test both directions — especially the allow cases.
4. **Add your gate's name to `INSTRUMENTED`** in `hook-heartbeat.mjs`, so the selftest reports it as dead
   when it is.
