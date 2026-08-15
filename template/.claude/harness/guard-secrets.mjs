#!/usr/bin/env node
// PreToolUse guard: keeps credentials out of the transcript and out of the repository.
//
// Two distinct leaks, and the first is the one people forget:
//
//   1. INTO THE TRANSCRIPT. `cat .env` puts every secret into the conversation, where it is stored,
//      summarised, and possibly sent onward. A `permissions.deny` on the Read TOOL does not stop
//      `cat` — that is a Bash call, and it reads the same file.
//   2. INTO THE REPO. A literal key pasted into a source file or an `echo >` is committed within the
//      hour and lives in history forever.
//
// ── A DENIED READ IS NOT A DEAD END ────────────────────────────────────────────
//
// This is the note that stops the guard being fought. Blocking `cat .env` does NOT mean secret-requiring
// work is impossible — it means the secret must reach the PROCESS rather than the TRANSCRIPT. A test
// runner or a script can read the file itself; the value never passes through context. The deny message
// says so, because a guard that appears to make a legitimate task impossible gets switched off.
//
// Detection is pattern-based and therefore incomplete. It catches the shapes that actually leak.

import { basename } from 'node:path'

import { deny, readPayload } from './config.mjs'

// Files whose whole purpose is holding credentials.
// Both separators throughout: unlike `guard-commit.mjs`, which reads paths from `git diff` and so
// always sees forward slashes, these match command arguments and `tool_input.file_path` — which are
// whatever the user's platform uses. Anchoring on `/` alone let `C:\Users\me\.env` through.
export const SECRET_FILES = /(^|[\\/])(\.env(\.[\w-]+)?|\.netrc|\.pgpass|id_[rd]sa|id_ecdsa|id_ed25519|credentials|\.htpasswd)$/i
const SECRET_DIRS = /(^|[\\/])\.(ssh|aws|gnupg|docker|kube)([\\/]|$)/i

// `.env.example` and friends are the DOCUMENTED SHAPE of the config, with the values removed. They are
// meant to be read and meant to be committed, and blocking them teaches people the guard is wrong about
// everything else too.
//
// Exported and shared with `guard-commit.mjs` rather than duplicated. The first version of this pair
// had the exception in the commit guard only, so `cat .env.example` was refused while committing it was
// fine — one rule, two files, fixed once. When you fix a rule like this, check its siblings the same
// day.
export const SECRET_FILE_EXCEPTIONS = /(^|[\\/])\.env\.(example|template|sample|dist|defaults?)$/i

export const isSecretFile = path =>
  (SECRET_FILES.test(path) || SECRET_DIRS.test(path)) && !SECRET_FILE_EXCEPTIONS.test(path)

// Commands that would print a file's contents into the transcript. `type` is cmd.exe's `cat` and
// `get-content` is PowerShell's, so a Windows user reaches for them by default — omitting them left
// the guard blind on the one platform nobody here develops on.
const READERS = /^(cat|bat|less|more|head|tail|strings|xxd|od|nl|base64|type|get-content)$/

// Literal credential shapes. Deliberately narrow — each is a real format, not an entropy heuristic,
// because entropy heuristics fire on minified code and hashes and then get turned off.
export const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Stripe secret key', re: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Anthropic-style key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'PEM certificate block', re: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  {
    name: 'assigned credential literal',
    // `PASSWORD = "hunter2"` — an assignment to a credential-named variable with a literal value.
    // Requires a quoted value of some length, so `PASSWORD = process.env.X` and empty defaults pass.
    re: /\b(password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\s*[:=]\s*["'][^"'\s$]{8,}["']/i
  }
]

export const findSecret = text => SECRET_PATTERNS.find(pattern => pattern.re.test(text ?? ''))?.name ?? null

const tokenize = command => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = token => token.replace(/^['"]|['"]$/g, '')
const segments = command => command.split(/(?:&&|\|\||[;\n|])/g).map(part => part.trim()).filter(Boolean)

// ── The decision, as a pure function ───────────────────────────────────────────
export const inspectBash = command => {
  if (typeof command !== 'string' || !command.trim()) return null

  for (const segment of segments(command)) {
    const tokens = tokenize(segment)
    // Split on both separators and drop any Windows executable extension: otherwise `cat.exe` reduces
    // to `cat.exe`, matches no known reader, and the guard stands aside on the command it watches for.
    const binary = unquote(tokens[0] ?? '')
      .split(/[\\/]/)
      .pop()
      .replace(/\.(exe|cmd|bat|com|ps1)$/i, '')
      .toLowerCase()

    if (READERS.test(binary)) {
      for (const token of tokens.slice(1)) {
        const value = unquote(token)

        if (value.startsWith('-')) continue

        if (isSecretFile(value)) {
          return (
            `Blocked: \`${binary} ${value}\` would print credentials into this conversation, where they ` +
            `are stored and may be summarised or sent onward.\n\n` +
            `THIS IS NOT A DEAD END. The secret can still reach the PROCESS that needs it — a test ` +
            `runner, a script, or a command that reads the file itself — without passing through the ` +
            `transcript. If you need to know which KEYS exist rather than their values, ` +
            `\`grep -o '^[A-Z_]*=' ${value}\` shows the names only.`
          )
        }
      }
    }
  }

  // A literal credential typed into a command — usually an export or an inline env assignment.
  const secret = findSecret(command)

  if (secret) {
    return (
      `Blocked: this command contains what looks like a ${secret}. A credential in a command lands in ` +
      `the transcript and often in shell history too.\n\n` +
      `Read it from the environment or a file at run time instead of writing the value out. If this is ` +
      `a placeholder or a test fixture, make it obviously fake (\`sk-test-EXAMPLE\`).`
    )
  }

  return null
}

export const inspectWrite = (filePath, content) => {
  const secret = findSecret(content)

  if (!secret) return null

  return (
    `Blocked: this write puts what looks like a ${secret} into ${basename(filePath ?? 'the file')}. ` +
    `Committed credentials live in git history forever, and rotating them is the only real remedy.\n\n` +
    `Read it from the environment at run time. If this is a fixture, make it obviously fake ` +
    `(\`sk-test-EXAMPLE\`) so it cannot be mistaken for a live key.`
  )
}

const main = async () => {
  const payload = await readPayload()

  if (!payload) process.exit(0)

  const reason =
    payload.tool_name === 'Bash'
      ? inspectBash(payload.tool_input?.command)
      : inspectWrite(payload.tool_input?.file_path, payload.tool_input?.content ?? payload.tool_input?.new_string)

  if (reason) deny(reason)

  process.exit(0)
}

if (process.argv[1]?.endsWith('guard-secrets.mjs')) main()
