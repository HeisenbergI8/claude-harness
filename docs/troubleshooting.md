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

## I want it gone
Delete `.claude/harness/`, `harness.config.json`, and the harness entries under `hooks` in
`.claude/settings.json` — they are the ones whose commands mention `.claude/harness/`. Anything else in
that file was yours; the installer never touched it. The agents and skills in `.claude/agents/` and
`.claude/skills/` are ordinary Claude Code files and work with or without the harness, so keep them if
you like them.

