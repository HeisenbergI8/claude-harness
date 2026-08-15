#!/usr/bin/env node
// PreToolUse guard on Bash: blocks destructive commands that reach outside this repository, and the
// handful of in-repo commands that destroy work irrecoverably.
//
// Written after an agent running unattended deleted files outside its project. The rule is simple and
// unconditional:
//
//   A command may delete, overwrite or move things INSIDE this repo (and the OS temp dir). Anything
//   reaching outside is denied — no exceptions, no heuristics about intent.
//
// It also denies commands that destroy work without ever calling `rm`, which a naive "block rm" guard
// misses entirely:
//
//   git clean -fdx      removes untracked AND ignored files
//   git reset --hard    discards uncommitted changes
//   git checkout -- .   same
//   git restore .       same
//
// ── SCOPED TO THE BINARY, PER SEGMENT — NEVER THE RAW STRING ───────────────────
//
// This is the design, not a detail. Match `git clean` against the whole command and
// `grep -rn "git clean" docs/` is blocked, as is any script that merely MENTIONS a dangerous command.
// A guard that cries wolf is a guard somebody switches off, and a switched-off guard protects nothing.
//
// So the command is split into segments and each pattern is checked only against a segment whose
// invoked binary matches.
//
// Deliberately NOT exhaustive against a determined adversary — a shell is too flexible for that. It is
// built to stop a confused agent, which is the actual threat.
//
// Try it without running anything:
//   echo '{"tool_input":{"command":"rm -rf ~/Documents"}}' | node .claude/harness/guard-destructive.mjs

import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'

import { deny, readPayload } from './config.mjs'

const REPO = process.cwd()

// Destructive binaries whose path arguments must stay inside the repo.
const DESTRUCTIVE = /^(rm|rmdir|unlink|shred|truncate|mv|dd|chown|chmod|cp|ln|tee|rsync)$/

// Interpreters that take code as a string argument. Their contents cannot be parsed reliably, so a
// destructive-looking payload is refused rather than guessed at.
const INTERPRETERS = /^(eval|bash|sh|zsh|ksh|node|nodejs|python|python3|perl|ruby|osascript)$/

const DESTRUCTIVE_PAYLOAD = /\b(rm\b|rmdir|unlink|rmtree|rmSync|shutil|removeSync|remove_tree|shred|mkfs)/

// Each entry is scoped to the binary actually being invoked and matched against ONE segment.
export const NEVER = [
  { binary: 'rm', pattern: /\s\/(\s|$)/, why: 'rm targeting the filesystem root' },
  { binary: 'rm', pattern: /\s(~|\$HOME)(\/\s*)?(\s|$)/, why: 'rm targeting your home directory' },
  { binary: 'rm', pattern: /\s\.git(\/\s*)?(\s|$)/, why: 'deleting .git destroys all history' },
  { binary: 'sudo', pattern: /./, why: 'sudo — this agent must never escalate privileges' },

  // `binary` may be a RegExp. `mkfs` is never invoked as bare `mkfs` in practice — it is `mkfs.ext4`,
  // `mkfs.xfs`, `mkfs.vfat`. An exact-match binary check misses every real invocation of the most
  // destructive command on the list.
  { binary: /^mkfs(\.\w+)?$/, why: 'formatting a filesystem', pattern: /./ },
  { binary: 'dd', pattern: /of=\/dev\//, why: 'writing to a raw device' },
  {
    binary: 'git',
    pattern: /^git\s+clean\b.*-[a-zA-Z]*f/,
    why:
      'git clean -f deletes untracked files with no way back. Run `git clean -n` first to see what it ' +
      'would remove, then delete what you actually mean, by name. (-x additionally removes ignored ' +
      'files, which usually includes your harness state and local config.)'
  },
  { binary: 'git', pattern: /^git\s+reset\b.*--hard/, why: 'git reset --hard discards uncommitted work' },
  { binary: 'git', pattern: /^git\s+checkout\b.*\s--\s+\.(\s|$)/, why: 'git checkout -- . discards uncommitted work' },
  { binary: 'git', pattern: /^git\s+restore\b(?!.*--staged).*\s\.(\s|$)/, why: 'git restore . discards uncommitted work' },
  { binary: 'find', pattern: /-delete\b/, why: 'find -delete — use an explicit path list instead' },
  { binary: 'find', pattern: /-exec\s+rm\b/, why: 'find -exec rm — use an explicit path list instead' }
]

export const isInsideSafeArea = absolute => {
  const areas = [REPO, resolve(tmpdir()), '/private/tmp', '/tmp', '/private/var/folders', '/var/folders']

  return areas.some(area => absolute === area || absolute.startsWith(area + sep))
}

export const splitCommands = command =>
  command.split(/(?:&&|\|\||[;\n|])/g).map(part => part.trim()).filter(Boolean)

export const tokenize = segment => segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []

export const unquote = token => token.replace(/^['"]|['"]$/g, '')

const binaryOf = segment => {
  const first = tokenize(segment)[0]

  // Strip a leading `VAR=value` assignment and any directory prefix, so `./node_modules/.bin/rm` and
  // `CI=1 rm` both resolve to `rm`.
  if (!first) return ''
  if (/^[A-Za-z_]\w*=/.test(first)) return binaryOf(segment.replace(/^\s*[A-Za-z_]\w*=\S*\s+/, ''))

  // BOTH separators, always — not `sep` for the current platform. A guard that splits on `/` alone
  // reads `C:\Program Files\Git\usr\bin\rm.exe` as one long token, matches no known binary, and stands
  // aside on exactly the command it exists to refuse.
  //
  // The extension has to go for the same reason: every binary on Windows is `rm.exe` or `npm.cmd`, and
  // a name list written as `rm` matches neither.
  //
  // Lowercased because Windows resolves command names case-insensitively, so `RM.EXE` and `rm` are the
  // same program there. On POSIX they could in principle be different files, and this guard prefers the
  // false refusal — which costs one explained block — to the miss, which costs the filesystem.
  return unquote(first)
    .split(/[\\/]/)
    .pop()
    .replace(/\.(exe|cmd|bat|com|ps1)$/i, '')
    .toLowerCase()
}

// ── The decision, as a pure function ───────────────────────────────────────────
//
// Exported so the suite can assert all of it without a subprocess. The ALLOW cases outnumber the BLOCK
// cases deliberately: this guard's failure mode is refusing ordinary work.
export const inspect = command => {
  if (typeof command !== 'string' || !command.trim()) return null

  // Fork bomb is a SHAPE, not a binary — the only whole-string check here.
  if (/:\(\)\s*\{.*\}\s*;\s*:/.test(command)) return 'Blocked: fork bomb.'

  const segments = splitCommands(command)

  // `cd` moves the ground under every later segment: `cd ~ && rm -rf Documents` reads as an in-repo
  // relative path while deleting your home directory. That is natural phrasing rather than evasion, so
  // once the command leaves the repo, nothing destructive may follow.
  const leavesRepo = segments.some(segment => {
    const match = segment.match(/^cd\s+(?!-)(\S+)/)

    if (!match) return false

    const target = unquote(match[1])

    if (/^(~|\$HOME)/.test(target)) return true

    return !isInsideSafeArea(resolve(REPO, target))
  })

  if (leavesRepo && segments.some(segment => DESTRUCTIVE.test(binaryOf(segment)))) {
    return (
      'Blocked: this command changes directory to somewhere outside the repository and then runs a ' +
      'destructive command. Relative paths after a `cd` are not what they appear to be. Run destructive ' +
      'commands from the repository root with explicit paths.'
    )
  }

  for (const segment of segments) {
    const binary = binaryOf(segment)

    // `git` and `find` are deliberately NOT in the cd-leaves-repo list above: `cd ../other && git log`
    // and `cd ../other && find .` are ordinary read-only work. Their dangerous forms are caught here,
    // by patterns that do not depend on the working directory at all.
    for (const rule of NEVER) {
      const matchesBinary = rule.binary instanceof RegExp ? rule.binary.test(binary) : binary === rule.binary

      if (matchesBinary && rule.pattern.test(segment)) return `Blocked: ${rule.why}`
    }

    // An interpreter given a destructive payload as a string argument.
    if (INTERPRETERS.test(binary) && DESTRUCTIVE_PAYLOAD.test(segment)) {
      return (
        `Blocked: ${binary} invoked with what looks like a destructive payload. Interpreted code cannot ` +
        `be checked reliably, so it is refused rather than guessed at. Write the file and run it, or ` +
        `use explicit paths.`
      )
    }

    // A destructive binary with a path argument that resolves outside the repo.
    if (DESTRUCTIVE.test(binary)) {
      for (const token of tokenize(segment).slice(1)) {
        const value = unquote(token)

        if (value.startsWith('-')) continue

        if (/^(~|\$HOME)/.test(value)) return `Blocked: ${binary} targeting your home directory (${value}).`

        // Only path-shaped tokens. A flag value or a pattern is not a path.
        if (!value.includes('/') && !value.startsWith('.')) continue

        if (!isInsideSafeArea(resolve(REPO, value))) {
          return (
            `Blocked: ${binary} targeting ${value}, which is outside this repository. Writes and deletions ` +
            `are permitted inside the repo and in the OS temp directory, nowhere else. If this genuinely ` +
            `needs doing, ask the user to do it themselves.`
          )
        }
      }
    }
  }

  // REDIRECTS overwrite files with no destructive binary involved.
  //
  // The lookbehind is load-bearing, and it was added because of real false blocks: without it the `=>`
  // in an arrow function inside `node -e "…"` reads as a redirect, as do `->`, `>=` and `<>`. Four
  // separate false blocks were fixed by patching this one expression, which is why the guard now
  // matches per segment and per binary rather than against raw text.
  for (const segment of segments) {
    const redirect = segment.match(/(?<![=<>!\-|])>>?\s*("[^"]*"|'[^']*'|[^\s|&;]+)/)

    if (!redirect) continue

    const target = unquote(redirect[1])

    if (target.startsWith('/dev/')) continue

    if (/^(~|\$HOME)/.test(target) || !isInsideSafeArea(resolve(REPO, target))) {
      return (
        `Blocked: this command redirects output to ${target}, outside the repository. A redirect ` +
        `overwrites without warning and without any destructive command being involved.`
      )
    }
  }

  return null
}

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const reason = inspect(payload.tool_input?.command)

  if (reason) deny(reason)

  process.exit(0)
}

if (process.argv[1]?.endsWith('guard-destructive.mjs')) main()
