// Guards, in both directions — and the ALLOW half is much larger on purpose.
//
// Every one of these guards has exactly one dangerous failure mode: refusing ordinary work. A guard
// that cries wolf gets switched off, and a switched-off guard protects nothing. So the blocking cases
// prove it works; the allow cases prove it will still be installed next month.

import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'

import { inspect as inspectDestructive, splitCommands, tokenize } from '../template/.claude/harness/guard-destructive.mjs'
import { findSecret, inspectBash, inspectWrite, isSecretFile } from '../template/.claude/harness/guard-secrets.mjs'
import { inspect as inspectCommit } from '../template/.claude/harness/guard-commit.mjs'
import { isPermitted } from '../template/.claude/harness/guard-write.mjs'
import { editPayload, makeRepo, runHook } from './helpers.mjs'

const repos = []

after(() => repos.forEach(repo => repo.cleanup()))

// ── guard-destructive: BLOCK ───────────────────────────────────────────────────

for (const command of [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf ~/Documents',
  'rm -rf $HOME/projects',
  'rm -rf .git',
  'sudo rm -rf /var',
  'sudo apt-get install curl',
  'mkfs.ext4 /dev/sda1',
  'dd if=/dev/zero of=/dev/sda',
  'git clean -fdx',
  'git clean -f',
  'git reset --hard HEAD~3',
  'git checkout -- .',
  'git restore .',
  'find . -name "*.ts" -delete',
  'find . -name "*.tmp" -exec rm {} \\;',
  'cd ~ && rm -rf Documents',
  'cd ../other-project && rm -rf src',
  'rm ../../../etc/hosts',
  'mv src ~/backup',
  'echo hi > ~/.zshrc',
  'cat config > /etc/thing',
  'node -e "require(\'fs\').rmSync(\'/tmp/../etc\', {recursive:true})"',
  ':(){ :|:& };:'
]) {
  test(`destructive BLOCK: ${command.slice(0, 52)}`, () => {
    assert.ok(inspectDestructive(command), `should have been blocked: ${command}`)
  })
}

// ── guard-destructive: ALLOW ───────────────────────────────────────────────────
//
// These are the cases that decide whether anyone keeps the guard. Each one is ordinary work, and
// several of them are the exact false blocks that patching a whole-string matcher produced.

for (const command of [
  'rm -rf node_modules',
  'rm -rf dist build',
  'rm src/old-file.ts',
  'rm -rf /tmp/scratch-dir',
  'git status',
  'git log --oneline -20',
  'git diff --cached',
  'git clean -n',
  'git restore --staged src/a.ts',
  'git checkout -b feature/thing',
  'npm run verify',
  'pytest -q',

  // USE vs MENTION — a guard matching the raw string blocks all of these, and they are how people
  // actually read and write about dangerous commands.
  'grep -rn "git clean" docs/',
  'grep -rn "rm -rf" scripts/',
  'echo "never run rm -rf /"',
  'cat docs/dangerous-commands.md',

  // Four real false blocks from patching redirect and path syntax against unparsed text.
  'node -e "const f = () => 1; console.log(f())"',
  'node -e "if (a >= b) console.log(1)"',
  'echo "a -> b"',
  "sed -i 's/foo/bar/' src/a.ts",

  // Read-only work outside the repo is fine; only destruction is not.
  'cd ../sibling && git log --oneline',
  'cd ../sibling && find . -name "*.go"',
  'cd /tmp && ls',

  'mv src/a.ts src/b.ts',
  'cp -r src/a src/b',
  'find . -name "*.test.ts"',
  'tee build.log',
  'echo done > build.log'
]) {
  test(`destructive ALLOW: ${command.slice(0, 52)}`, () => {
    assert.equal(inspectDestructive(command), null, `should NOT have been blocked: ${command}`)
  })
}

test('destructive: segmentation and tokenization', () => {
  assert.deepEqual(splitCommands('cd /; rm -rf x'), ['cd /', 'rm -rf x'])
  assert.deepEqual(splitCommands('a && b || c | d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(tokenize('grep -q "a b" file'), ['grep', '-q', '"a b"', 'file'])
})

test('destructive: an empty or absent command is not judged', () => {
  assert.equal(inspectDestructive(''), null)
  assert.equal(inspectDestructive(undefined), null)
})

// ── guard-secrets ──────────────────────────────────────────────────────────────

test('secrets: reading a credential file into the transcript is blocked', () => {
  for (const command of ['cat .env', 'cat .env.local', 'head -5 ~/.ssh/id_rsa', 'less .netrc', 'base64 credentials']) {
    assert.ok(inspectBash(command), `should have been blocked: ${command}`)
  }
})

// The deny must not read as "this task is impossible", or people route around the guard.
test('secrets: the deny explains the way through', () => {
  assert.match(inspectBash('cat .env'), /NOT A DEAD END/)
  assert.match(inspectBash('cat .env'), /grep -o/)
})

test('secrets: .env.example is documentation, not a credential', () => {
  assert.equal(inspectBash('cat .env.example'), null)
  assert.equal(inspectCommit({ staged: ['.env.example'] }), null)
})

for (const [name, sample] of [
  ['AWS key', 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
  ['GitHub token', 'curl -H "Authorization: ghp_abcdefghijklmnopqrstuvwxyz0123456789"'],
  ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ['JWT', 'TOKEN=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
  ['assigned literal', 'const password = "s3cret-value-here"']
]) {
  test(`secrets: detects a ${name}`, () => assert.ok(findSecret(sample), sample))
}

for (const safe of [
  'const password = process.env.PASSWORD',
  'const apiKey = config.apiKey',
  'PASSWORD=""',
  'password: ""',
  'const token = "sk-test-EXAMPLE"'.replace('sk-test-EXAMPLE', 'PLACEHOLDER'),
  'echo "set PASSWORD in your .env"',
  'git log --oneline'
]) {
  test(`secrets ALLOW: ${safe.slice(0, 46)}`, () => assert.equal(findSecret(safe), null, safe))
}

test('secrets: a write containing a key is blocked, a write reading from env is not', () => {
  assert.ok(inspectWrite('src/a.ts', 'const k = "AKIAIOSFODNN7EXAMPLE"'))
  assert.equal(inspectWrite('src/a.ts', 'const k = process.env.AWS_ACCESS_KEY_ID'), null)
})

// ── guard-commit ───────────────────────────────────────────────────────────────

test('commit: a staged credential file is blocked, and the message says rotate', () => {
  const reason = inspectCommit({ staged: ['.env'] })

  assert.ok(reason)
  assert.match(reason, /ROTATING/)
})

test('commit: build output and dependency directories are blocked', () => {
  for (const file of ['node_modules/x/index.js', 'dist/main.js', '.next/build.json', 'coverage/lcov.info', '.DS_Store']) {
    assert.ok(inspectCommit({ staged: [file] }), file)
  }
})

test('commit: a credential in the staged diff is blocked', () => {
  assert.ok(inspectCommit({ staged: ['src/a.ts'], diff: '+const k = "AKIAIOSFODNN7EXAMPLE"' }))
})

// The failure is silent transitive skew, not a merge conflict — which is why it is worth blocking.
test('commit: a second lockfile alongside a tracked one is blocked', () => {
  const reason = inspectCommit({ staged: ['pnpm-lock.yaml'], tracked: ['package-lock.json', 'package.json'] })

  assert.ok(reason)
  assert.match(reason, /two dependency graphs/)
})

test('commit: updating the lockfile you already use is fine', () => {
  assert.equal(inspectCommit({ staged: ['package-lock.json'], tracked: ['package-lock.json'] }), null)
})

test('commit: a red tree is blocked, but it is the LAST check', () => {
  // Irreversible problems must be reported before the merely inconvenient one.
  const both = inspectCommit({ staged: ['.env'], treeGreen: false, verifyCommand: 'npm test' })

  assert.match(both, /ROTATING/, 'the credential must be reported before the red tree')
  assert.match(inspectCommit({ staged: ['src/a.ts'], treeGreen: false, verifyCommand: 'npm test' }), /broken point in history/)
})

test('commit ALLOW: an ordinary clean commit', () => {
  assert.equal(inspectCommit({ staged: ['src/a.ts', 'tests/a.test.ts'], diff: '+const x = 1', tracked: ['src/a.ts'] }), null)
})

// ── guard-write ────────────────────────────────────────────────────────────────

test('write scoping: an architect may write plans and nothing else', () => {
  const rules = ['.claude/plans/**']

  assert.ok(isPermitted('.claude/plans/feature-x/plan.md', rules))
  assert.ok(!isPermitted('src/index.ts', rules))
  assert.ok(!isPermitted('.claude/harness/config.mjs', rules))
})

test('write scoping: a tester may write tests and its report, not the code under test', () => {
  const rules = ['.claude/plans/**', 'tests/**', '**/*.test.*']

  assert.ok(isPermitted('tests/e2e/a.spec.ts', rules))
  assert.ok(isPermitted('src/views/a.test.ts', rules))
  assert.ok(isPermitted('.claude/plans/x/verification.md', rules))
  assert.ok(!isPermitted('src/views/a.ts', rules), 'a tester must never edit the code it is testing')
})

test('write guard: containment applies to the main thread too', () => {
  const repo = makeRepo({ config: { commands: { verify: 'true', verifyFast: 'true' } } })

  repos.push(repo)

  const outside = runHook(repo, 'guard-write.mjs', { ...editPayload({ file: '/etc/hosts' }), tool_name: 'Write' })

  assert.equal(outside?.hookSpecificOutput?.permissionDecision, 'deny')
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /outside this repository/)

  const inside = runHook(repo, 'guard-write.mjs', { ...editPayload({ file: 'src/a.ts' }), tool_name: 'Write' })

  assert.equal(inside, null)
})

test('write guard: a restricted agent is denied outside its allowlist', () => {
  const repo = makeRepo({
    config: { commands: { verify: 'true', verifyFast: 'true' }, agents: { write: { tester: ['tests/**'] } } }
  })

  repos.push(repo)

  const denied = runHook(repo, 'guard-write.mjs', {
    ...editPayload({ file: 'src/a.ts' }),
    tool_name: 'Write',
    agent_type: 'tester'
  })

  assert.equal(denied?.hookSpecificOutput?.permissionDecision, 'deny')
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /REPORT it rather than editing it/)

  const allowed = runHook(repo, 'guard-write.mjs', {
    ...editPayload({ file: 'tests/a.test.ts' }),
    tool_name: 'Write',
    agent_type: 'tester'
  })

  assert.equal(allowed, null)
})

test('write guard: an unlisted agent and the main thread are unrestricted inside the repo', () => {
  const repo = makeRepo({ config: { commands: { verify: 'true', verifyFast: 'true' } } })

  repos.push(repo)

  for (const agent of [undefined, 'general-purpose']) {
    const response = runHook(repo, 'guard-write.mjs', {
      ...editPayload({ file: 'src/a.ts' }),
      tool_name: 'Write',
      agent_type: agent
    })

    assert.equal(response, null, `${agent ?? 'main thread'} should be unrestricted`)
  }
})

test('write guard: a huge single Write to a plan is refused with the protocol', () => {
  const repo = makeRepo({
    config: {
      commands: { verify: 'true', verifyFast: 'true' },
      agents: { write: { architect: ['.claude/plans/**'] }, planWriteMaxLines: 50 }
    }
  })

  repos.push(repo)

  const big = runHook(repo, 'guard-write.mjs', {
    tool_name: 'Write',
    agent_type: 'architect',
    tool_input: { file_path: '.claude/plans/x/plan.md', content: 'line\n'.repeat(80) }
  })

  assert.equal(big?.hookSpecificOutput?.permissionDecision, 'deny')
  assert.match(big.hookSpecificOutput.permissionDecisionReason, /SKELETON first/)

  // An Edit appending a phase is the protocol working, and must never be refused.
  const edit = runHook(repo, 'guard-write.mjs', {
    tool_name: 'Edit',
    agent_type: 'architect',
    tool_input: { file_path: '.claude/plans/x/plan.md', content: 'line\n'.repeat(80) }
  })

  assert.equal(edit, null)
})

// ── Windows path separators ────────────────────────────────────────────────────
//
// THE BUG THESE PIN: both guards reduce a command to its binary NAME before deciding anything. Doing
// that with split('/') leaves a Windows path as one unsplittable token, which matches no known binary,
// so the guard stands aside on precisely the command it exists to refuse. Nobody developing this on
// macOS would ever see it.

test('destructive guard sees through a windows path and an .exe suffix', () => {
  assert.ok(inspectDestructive(String.raw`C:\tools\rm -rf /`), 'a backslash path must resolve to rm')
  assert.ok(inspectDestructive(String.raw`C:\tools\rm.exe -rf /`), 'an .exe suffix must resolve to rm')
  assert.ok(inspectDestructive(String.raw`C:\tools\RM.EXE -rf /`), 'the suffix match is case-insensitive')
})

test('secrets guard sees through a windows path and an .exe suffix', () => {
  assert.ok(inspectBash(String.raw`C:\tools\cat.exe .env`), 'must resolve to cat')
  assert.ok(inspectBash(String.raw`C:\Windows\System32\type.com .env`), 'the cmd.exe reader too')
})

// The extension strip must not eat a legitimate POSIX name. `execute` ends in nothing meaningful and
// `notes.bat` as a FILE argument is not a binary, but a binary literally named `run.com` on Linux
// would be reduced — accepted, because it is not a name any guard list contains.
test('stripping a windows extension does not break ordinary posix commands', () => {
  assert.equal(inspectDestructive('npm run build'), null)
  assert.equal(inspectBash('cat README.md'), null)
})

// Windows paths reach these regexes from command arguments and tool_input.file_path, which are
// platform-native — unlike guard-commit.mjs, which reads `git diff` output and always sees `/`.
test('secret files are recognised through a windows path', () => {
  assert.ok(isSecretFile(String.raw`C:\Users\me\.env`))
  assert.ok(isSecretFile(String.raw`C:\Users\me\.ssh\id_rsa`))
  assert.ok(isSecretFile(String.raw`C:\Users\me\.aws\credentials`))
})

// The exception has to survive the same change, or a Windows user is blocked from reading the very
// file that is meant to be committed — which is how a guard teaches people to switch it off.
test('the .env.example exception survives a windows path', () => {
  assert.equal(isSecretFile(String.raw`C:\proj\.env.example`), false)
  assert.equal(isSecretFile('.env.example'), false)
})
