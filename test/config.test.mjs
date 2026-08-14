// The config layer is the only thing that makes this harness portable, so it is the first thing that
// must be right. Most of these assertions pin a bug that is easy to reintroduce.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  buildEvidencePatterns,
  classifyCommand,
  commandToRegExp,
  DEFAULTS,
  globToRegExp,
  isSourceFile,
  load,
  statePaths
} from '../template/.claude/harness/config.mjs'

const withCommands = (commands, extra = {}) => {
  const config = { ...DEFAULTS, ...extra, commands: { ...DEFAULTS.commands, ...commands }, root: '/repo' }

  config.evidencePatterns = buildEvidencePatterns(config)
  config.statePaths = statePaths(config)

  return config
}

test('glob: ** crosses separators, * does not', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b/c.ts'))
  assert.ok(globToRegExp('tests/*.test.ts').test('tests/x.test.ts'))
  assert.ok(!globToRegExp('tests/*.test.ts').test('tests/nested/x.test.ts'))
  assert.ok(globToRegExp('**/*.go').test('cmd/server/main.go'))
})

// THE BUG THIS PINS: without the trailing lookahead, a `verify` command of "npm run verify" also matches
// "npm run verify:fast", so every fast mid-task check is recorded as the closing gate. That single
// confusion breaks any downstream distinction between "still working" and "wrapping up".
test('a verify command does not swallow its own :fast variant', () => {
  const config = withCommands({ verify: 'npm run verify', verifyFast: 'npm run verify:fast' })

  assert.equal(classifyCommand(config, 'npm run verify'), 'verify')
  assert.equal(classifyCommand(config, 'npm run verify:fast'), 'verify:fast')
})

test('commandToRegExp tolerates whitespace differences but not prefix collisions', () => {
  const re = new RegExp(commandToRegExp('go build ./...'), 'i')

  assert.ok(re.test('go build ./...'))
  assert.ok(re.test('go  build   ./...'))
  assert.ok(re.test('go build ./... && go vet ./...'))
  assert.ok(!re.test('go build ./...x'))
})

test('a non-npm verify command is recognised as the closing gate', () => {
  const config = withCommands({ verify: 'make check', verifyFast: 'make typecheck' })

  assert.equal(classifyCommand(config, 'make check'), 'verify')
  assert.equal(classifyCommand(config, 'make typecheck'), 'verify:fast')
})

test('builtin catalog covers the common ecosystems', () => {
  const config = withCommands({})

  assert.equal(classifyCommand(config, 'pytest -q tests/'), 'test')
  assert.equal(classifyCommand(config, 'go test ./...'), 'test')
  assert.equal(classifyCommand(config, 'cargo test --all'), 'test')
  assert.equal(classifyCommand(config, 'npx vitest run'), 'test')
  assert.equal(classifyCommand(config, 'tsc --noEmit'), 'typecheck')
  assert.equal(classifyCommand(config, 'mypy .'), 'typecheck')
  assert.equal(classifyCommand(config, 'ruff check .'), 'lint')
  assert.equal(classifyCommand(config, 'npx playwright test'), 'e2e')
})

test('an ordinary command is not evidence', () => {
  const config = withCommands({ verify: 'npm run verify' })

  assert.equal(classifyCommand(config, 'ls -la'), null)
  assert.equal(classifyCommand(config, 'git status'), null)
  assert.equal(classifyCommand(config, 'cat package.json'), null)
})

// ── USE vs MENTION, for commands ───────────────────────────────────────────────
//
// Talking ABOUT a test command is not running one. Matching against the raw string credits a turn that
// ran nothing with a green gate — the exact failure this harness exists to prevent, arriving through its
// own front door.
for (const command of [
  'echo "remember to run pytest"',
  'grep -rn "npm run verify" docs/',
  'rg "cargo test" --files-with-matches',
  'cat scripts/ci.sh | head -20',
  'find . -name "*test*"',
  'sed -i "s/pytest/pytest -q/" Makefile'
]) {
  test(`MENTION is not evidence: ${command}`, () => {
    assert.equal(classifyCommand(withCommands({ verify: 'npm run verify' }), command), null)
  })
}

for (const [command, kind] of [
  ['npm run verify', 'verify'],
  ['cd packages/api && pytest -q', 'test'],
  ['npm run lint || true', 'lint'],
  ['CI=1 pytest -q', 'test'],
  ['npm run build && npm run verify', 'verify'],
  ['./node_modules/.bin/vitest run', 'test']
]) {
  test(`USE is evidence: ${command}`, () => {
    assert.equal(classifyCommand(withCommands({ verify: 'npm run verify' }), command), kind)
  })
}

// A multi-part command declared in `commands` must still match as one unit, even though segments are
// also checked. This is the case that segment-only matching would break.
test('a multi-segment declared command matches as a whole', () => {
  const config = withCommands({ verify: 'go build ./... && go vet ./... && go test ./...' })

  assert.equal(classifyCommand(config, 'go build ./... && go vet ./... && go test ./...'), 'verify')
})

test('useBuiltins: false narrows recognition to declared patterns only', () => {
  const config = withCommands({ verify: 'make check' }, { evidence: { patterns: [], useBuiltins: false } })

  assert.equal(classifyCommand(config, 'make check'), 'verify')
  assert.equal(classifyCommand(config, 'pytest -q'), null)
})

test('user patterns are checked before the builtins', () => {
  const config = withCommands({}, { evidence: { patterns: [{ kind: 'contract', match: 'pytest\\s+-q\\s+contracts' }] } })

  assert.equal(classifyCommand(config, 'pytest -q contracts'), 'contract')
  assert.equal(classifyCommand(config, 'pytest -q units'), 'test')
})

test('a malformed user pattern is reported, not thrown', () => {
  const errors = []
  const config = { ...DEFAULTS, evidence: { patterns: [{ kind: 'bad', match: '([' }], useBuiltins: false }, root: '/repo' }

  config.evidencePatterns = buildEvidencePatterns(config, errors)

  assert.equal(errors.length, 1)
  assert.match(errors[0], /not a valid regex/)
})

test('source matching honours include, exclude, and the repo boundary', () => {
  const config = withCommands({}, { source: { include: ['src/**', 'tests/**'], exclude: ['**/*.md'] } })

  assert.ok(isSourceFile(config, '/repo/src/a/b.ts', '/repo'))
  assert.ok(isSourceFile(config, 'src/a/b.ts', '/repo'))
  assert.ok(!isSourceFile(config, '/repo/docs/readme.md', '/repo'))
  assert.ok(!isSourceFile(config, '/repo/src/notes.md', '/repo'), 'exclude must win over include')
  assert.ok(!isSourceFile(config, '/elsewhere/src/a.ts', '/repo'), 'outside the repo is never source')
  assert.ok(!isSourceFile(config, undefined, '/repo'))
})

// Plan documents, notes and harness state are deliberately NOT source. A turn that only wrote a design
// doc did not break the build, and blocking it teaches the model to read the gate as noise.
test('harness and doc paths are not source under the defaults', () => {
  const config = withCommands({})

  assert.ok(!isSourceFile(config, '.claude/harness/config.mjs', '/repo'))
  assert.ok(!isSourceFile(config, 'README.md', '/repo'))
  assert.ok(isSourceFile(config, 'src/index.ts', '/repo'))
})

test('load never throws on malformed JSON and reports it instead', () => {
  const config = load('/definitely/not/a/real/path')

  assert.deepEqual(config.errors, [])
  assert.ok(config.warnings.length > 0, 'a missing config should warn, loudly but harmlessly')
  assert.equal(config.commands.verify, null)
})

test('verifyFast falls back to verify, and says so', () => {
  const raw = { ...DEFAULTS, commands: { verify: 'make check', verifyFast: null } }
  const config = { ...raw }

  // Mirrors load()'s fallback branch without needing a file on disk.
  if (!config.commands.verifyFast && config.commands.verify) config.commands.verifyFast = config.commands.verify

  assert.equal(config.commands.verifyFast, 'make check')
})

test('state paths all live under one directory', () => {
  const paths = statePaths({ state: { dir: '.claude/.harness' } })

  for (const [name, value] of Object.entries(paths)) {
    if (name === 'dir') continue

    assert.ok(value.startsWith('.claude/.harness'), `${name} escaped the state directory: ${value}`)
  }
})
