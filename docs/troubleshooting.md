# Troubleshooting

## Nothing happens — no gate ever fires
Almost always the restart. Hooks are read at session startup, so a session that was open during
install is running without them. Restart, take one turn, then run
`node .claude/harness/selftest.mjs`. If it reports hooks *registered* but says none have fired, the
restart did not take. If it reports `registers no hooks`, the merge into `.claude/settings.json` did
not happen — re-run the installer.

## Every turn is blocked by a command failure that has nothing to do with my code
Your `verifyFast` cannot run. Check it:

```bash
node .claude/harness/selftest.mjs --probe
```

A `CANNOT RUN` line names the command and what the shell said. Fix it in `harness.config.json` — set
it to whatever you genuinely run by hand — or install the tool it calls.

## It blocks too often
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
[`configuration.md`](configuration.md) for thresholds you can loosen instead of disabling.

## A write is refused with "AGENT LOCK"

Another Claude Code session in this same checkout has been writing in that module within the last 30
minutes. That is the mechanism working — see [design.md](design.md#agent-locks).

`node .claude/harness/agent-locks.mjs` lists what is held, by whom, and for how long. If the lock is
wrong — the other session is finished, or it was a session id that changed under a resume — clear it:

```bash
node .claude/harness/agent-locks.mjs --release-all
AGENT_LOCKS_DISABLE=1 claude          # or switch the whole mechanism off for one session
```

It cannot trap you either way: after `locks.maxBlocks` consecutive refusals in one scope the guard
stands aside. If it is refusing work that was fine, the cause is almost always `locks.roots` being
wider than your real module boundary. Narrowing it to `[]` falls back to exact-file scope, which only
fires when two sessions edit the same file.

## I want it gone
Delete `.claude/harness/`, `harness.config.json`, and the harness entries under `hooks` in
`.claude/settings.json` — they are the ones whose commands mention `.claude/harness/`. Anything else in
that file was yours; the installer never touched it. The agents and skills in `.claude/agents/` and
`.claude/skills/` are ordinary Claude Code files and work with or without the harness, so keep them if
you like them.

