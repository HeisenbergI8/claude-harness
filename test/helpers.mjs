// Shared fixtures. Every test that touches disk gets its own temp repo, so nothing here can be made to
// pass by a leftover state file from a previous run — which is the failure mode that makes a harness's
// own tests worthless.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const HARNESS_SRC = join(REPO, 'template/.claude/harness')

export const makeRepo = ({ config, packageJson } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'claude-harness-test-'))

  mkdirSync(join(root, '.claude'), { recursive: true })

  if (packageJson) writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)

  // Install the real harness the real way, so the tests exercise the installer as well as the gates.
  execFileSync('node', [join(REPO, 'bin/harness-init.mjs'), root], { stdio: 'pipe' })

  if (config !== undefined) {
    if (config === null) rmSync(join(root, 'harness.config.json'), { force: true })
    else writeFileSync(join(root, 'harness.config.json'), `${JSON.stringify(config, null, 2)}\n`)
  }

  return {
    root,
    path: relative => join(root, relative),
    read: relative => {
      try {
        return readFileSync(join(root, relative), 'utf8')
      } catch {
        return ''
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

// Runs a hook script exactly as Claude Code would: payload on stdin, cwd at the repo root, output on
// stdout. Returns the parsed hook response, or null when the hook stayed silent.
export const runHook = (repo, script, payload, { env = {}, args = [] } = {}) => {
  const result = execFileSync('node', [join(repo.root, '.claude/harness', script), ...args], {
    input: JSON.stringify(payload),
    cwd: repo.root,
    encoding: 'utf8',
    stdio: 'pipe',
    // CLAUDE_HOOK_TEST keeps test invocations out of the liveness signal. A hook driven by its own test
    // suite must not register as ALIVE — that inverts the one thing the heartbeat is for.
    env: { ...process.env, CLAUDE_HOOK_TEST: '1', ...env }
  })

  const line = result.trim().split('\n').filter(Boolean).pop()

  if (!line) return null

  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

export const bashPayload = ({ command, turn = 't1', session = 's1', ok = true, event = 'PostToolUse', id }) => ({
  hook_event_name: event,
  session_id: session,
  prompt_id: turn,
  tool_use_id: id,
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { exit_code: ok ? 0 : 1 }
})

export const editPayload = ({ file, turn = 't1', session = 's1', tool = 'Edit' }) => ({
  hook_event_name: 'PostToolUse',
  session_id: session,
  prompt_id: turn,
  tool_name: tool,
  tool_input: { file_path: file },
  tool_response: { exit_code: 0 }
})

export const stopPayload = ({ turn = 't1', session = 's1', message, agent, active = false } = {}) => ({
  hook_event_name: agent ? 'SubagentStop' : 'Stop',
  session_id: session,
  prompt_id: turn,
  stop_hook_active: active,
  ...(agent ? { agent_type: agent, agent_id: `${agent}-1` } : {}),
  ...(message === undefined ? {} : { last_assistant_message: message })
})
