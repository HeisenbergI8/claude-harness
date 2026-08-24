#!/usr/bin/env node
// Stop hook: gives back the locks this session holds.
//
// `Stop` is the natural "I am done for now" boundary. Releasing more often — after each write, on a
// timer — would drop the lock in the middle of the work it was taken for, which is the one moment it
// has to hold.
//
// ── THIS HOOK IS AN OPTIMISATION, NOT THE RECOVERY PATH ────────────────────────
//
// Read that literally. If Claude Code crashes, `Stop` never fires; if a session is switched away from
// and forgotten, it never fires either. Neither case leaks a lock, because staleness is a property of
// READING the log — a lock nothing has refreshed inside `locks.staleMs` simply stops being held, in
// every reader, with nobody having to sweep it.
//
// So what this buys is promptness: finish a turn and the module is free immediately instead of in half
// an hour. A release mechanism that the correctness of the system depended on would be a release
// mechanism that had to be reliable, and hooks are not.
//
// There is deliberately no `SessionStart` wiring. It would have nothing to do — a starting session
// holds no locks, and the sweep it would run is not a thing that exists here. Registering a hook that
// does nothing also puts a permanent WARN in the selftest on any build that does not send that event.

import { basename } from 'node:path'

import { load, readPayload } from './config.mjs'
import { releaseFor } from './agent-locks.mjs'

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const config = load()

  if (process.env.AGENT_LOCKS_DISABLE === '1') process.exit(0)
  if (config.locks?.enabled !== true) process.exit(0)

  const session = payload.session_id ?? process.env.CLAUDE_SESSION_ID

  if (!session) process.exit(0)

  const released = releaseFor(config, session)

  // Silent when nothing changed. A hook that speaks on every turn is a hook whose output stops being
  // read, and this one has nothing to say on the turns that took no locks.
  if (released.length) {
    process.stdout.write(
      `${JSON.stringify({ systemMessage: `agent locks released: ${released.map(lock => lock.path).join(', ')}` })}\n`
    )
  }

  process.exit(0)
}

if (basename(process.argv[1] ?? '') === 'release-agent-locks.mjs') {
  main().catch(error => {
    console.error(`release-agent-locks: ${error?.message ?? error}`)
    process.exit(0)
  })
}
