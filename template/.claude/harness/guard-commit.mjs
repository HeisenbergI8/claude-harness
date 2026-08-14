#!/usr/bin/env node
// PreToolUse guard on `git commit`: checks what is actually staged before it becomes history.
//
// A commit is the point where a mistake stops being local. Secrets in a commit have to be rotated, not
// deleted; build output in a commit bloats every future clone; a second lockfile causes silent
// transitive version skew that surfaces days later as an unrelated bug.
//
// Four checks, in order of how hard they are to undo:
//
//   1. A credential file staged            — rotation, not revert
//   2. A literal credential in the diff    — same
//   3. Build output or dependency dirs     — history bloat, permanent
//   4. A red tree                          — recoverable, but a broken commit is a bad bisect point
//
// ── IT READS THE INDEX, NOT THE MESSAGE ────────────────────────────────────────
//
// The command string is not the subject. `git commit -m "no secrets here"` proves nothing, and a guard
// that parses the message rather than the index is theatre. Everything below runs `git diff --cached`.
//
// Fails OPEN when git cannot be read. A guard that blocks every commit because it could not run a
// subprocess is a guard that gets removed the same afternoon.

import { execFileSync } from 'node:child_process'

import { deny, load, readPayload } from './config.mjs'

// Shared with the secrets guard rather than redeclared. Two copies of "what counts as a credential
// file" drift, and the drift is silent — see the note beside SECRET_FILE_EXCEPTIONS there.
import { findSecret, isSecretFile } from './guard-secrets.mjs'

const git = args => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' })
  } catch {
    return null
  }
}

const BUILD_OUTPUT = [
  { re: /(^|\/)node_modules\//, why: 'node_modules is a dependency directory' },
  { re: /(^|\/)(dist|build|out|target|\.next|\.nuxt|\.output)\//, why: 'build output' },
  { re: /(^|\/)__pycache__\/|\.pyc$/, why: 'compiled Python' },
  { re: /(^|\/)\.venv\/|(^|\/)venv\//, why: 'a virtualenv' },
  { re: /(^|\/)coverage\//, why: 'coverage output' },
  { re: /\.(tsbuildinfo|eslintcache)$/, why: 'a build cache' },
  { re: /(^|\/)\.DS_Store$/, why: 'a macOS directory file' }
]

// Two lockfiles for one ecosystem means two different dependency graphs, and whichever tool runs
// second wins silently. The failure is not a merge conflict — it is a transitive version skew nobody
// sees until something breaks days later.
const LOCKFILES = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun']
]

// ── The decision, as a pure function ───────────────────────────────────────────
//
// Exported so the suite can drive every branch without staging real files.
export const inspect = ({ staged = [], diff = '', tracked = [], treeGreen = true, verifyCommand = null }) => {
  for (const file of staged) {
    if (isSecretFile(file)) {
      return (
        `Blocked: \`${file}\` is staged. Committing a credential file means ROTATING every secret in ` +
        `it — deleting the file later does not remove it from history.\n\n` +
        `\`git restore --staged ${file}\`, then add it to .gitignore. If you meant to commit the ` +
        `documented shape of the config, commit \`.env.example\` with the values removed.`
      )
    }
  }

  const secret = findSecret(diff)

  if (secret) {
    return (
      `Blocked: the staged diff contains what looks like a ${secret}.\n\n` +
      `Review it with \`git diff --cached\`. If it is real, unstage it and rotate the key — a committed ` +
      `credential is compromised the moment it is pushed, and removing it from history does not ` +
      `un-compromise it. If it is a fixture, make it obviously fake (\`sk-test-EXAMPLE\`).`
    )
  }

  for (const file of staged) {
    const match = BUILD_OUTPUT.find(entry => entry.re.test(file))

    if (match) {
      return (
        `Blocked: \`${file}\` is ${match.why} and should not be committed. It bloats every future ` +
        `clone permanently — history is not something you can trim later without rewriting it.\n\n` +
        `\`git restore --staged ${file}\` and add the pattern to .gitignore.`
      )
    }
  }

  // A NEW lockfile alongside one already tracked.
  const stagedLocks = LOCKFILES.filter(([name]) => staged.some(file => file === name || file.endsWith(`/${name}`)))
  const trackedLocks = LOCKFILES.filter(([name]) => tracked.some(file => file === name || file.endsWith(`/${name}`)))

  for (const [name, manager] of stagedLocks) {
    const conflicting = trackedLocks.find(([other]) => other !== name)

    if (conflicting) {
      return (
        `Blocked: this commit adds \`${name}\` (${manager}) while \`${conflicting[0]}\` (${conflicting[1]}) ` +
        `is already tracked.\n\n` +
        `Two lockfiles for one ecosystem means two dependency graphs, and whichever tool runs second ` +
        `wins silently. The failure mode is not a merge conflict — it is a transitive version skew that ` +
        `surfaces days later as an unrelated bug. Pick one package manager and delete the other lockfile.`
      )
    }
  }

  if (!treeGreen) {
    return (
      `Blocked: \`${verifyCommand}\` is failing, so this commit would be a broken point in history.\n\n` +
      `A red commit is a bad bisect point and a bad thing to hand anyone. Fix the tree first — or, if ` +
      `you are deliberately committing work-in-progress, say so to the user and commit on a branch ` +
      `nobody bisects.`
    )
  }

  return null
}

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const command = payload.tool_input?.command ?? ''

  // Only real commits. `git commit --dry-run`, `git log`, and anything merely MENTIONING commit are not
  // the subject — the same use-versus-mention discipline the rest of the harness follows.
  if (!/(^|[;&|]\s*)git\s+(-c\s+\S+\s+)*commit\b/.test(command)) process.exit(0)
  if (/--dry-run\b/.test(command)) process.exit(0)

  const config = load()

  const staged = (git(['diff', '--cached', '--name-only']) ?? '').split('\n').filter(Boolean)

  // Nothing staged: either `commit -a` (which stages at commit time and cannot be inspected here) or a
  // mistake git will report itself. Either way this guard has nothing to judge.
  if (!staged.length) process.exit(0)

  const diff = git(['diff', '--cached', '--unified=0']) ?? ''
  const tracked = (git(['ls-files']) ?? '').split('\n').filter(Boolean)

  // The tree check is the cheapest signal available, and it is deliberately the LAST check: the others
  // are irreversible, this one is merely inconvenient.
  let treeGreen = true

  const verifyCommand = config.commands.verifyFast

  if (verifyCommand) {
    try {
      execFileSync(process.env.SHELL || '/bin/sh', ['-c', verifyCommand], {
        stdio: 'pipe',
        timeout: config.verifyTimeoutMs
      })
    } catch (error) {
      // A command that could not START is a config problem, not a red tree. Blaming the commit for it
      // is blaming the wrong party.
      treeGreen = error.code === 'ENOENT' || error.signal === 'SIGTERM'
    }
  }

  const reason = inspect({ staged, diff, tracked, treeGreen, verifyCommand })

  if (reason) deny(reason)

  process.exit(0)
}

if (process.argv[1]?.endsWith('guard-commit.mjs')) main()
