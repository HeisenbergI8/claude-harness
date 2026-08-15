// The probe answers one question: can this command RUN? Not "does it pass" — a red tree is the healthy
// case this harness exists to surface. These tests pin the distinction, because collapsing the two is
// what would make the check either useless (never fires) or intolerable (fires on every red tree).

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { classifyProbe, probeCommand } from '../template/.claude/harness/config.mjs'
import { REPO, makeRepo } from './helpers.mjs'

// ── classification ─────────────────────────────────────────────────────────────

// THE BUG THIS PINS: the whole check is worthless if a failing test suite reads as a broken command.
// Someone whose tests are red at install time would be told their setup is wrong, learn to ignore the
// warning, and then miss the real one.
test('a command that ran and failed is runnable', () => {
  const result = classifyProbe({ status: 1, stderr: '2 tests failed' })

  assert.equal(result.runnable, true)
  assert.equal(result.verdict, 'fail')
})

test('exit 0 is a pass', () => {
  assert.deepEqual(classifyProbe({ status: 0, stdout: 'ok' }).verdict, 'pass')
})

test('a missing binary is not runnable, whatever the shell calls it', () => {
  for (const stderr of [
    'sh: tsc: command not found',
    'bash: line 1: pytest: command not found',
    'sh: 1: tsc: not found',
    "'tsc' is not recognized as an internal or external command",
    'npm error Missing script: "typecheck"',
    "python: can't open file '/repo/manage.py': [Errno 2] No such file or directory",
    'make: *** No rule to make target `check`.  Stop.'
  ]) {
    const result = classifyProbe({ status: 1, stderr })

    assert.equal(result.runnable, false, `should be unrunnable: ${stderr}`)
    assert.equal(result.verdict, 'missing')
    assert.ok(result.detail, 'a verdict of missing must say what was missing')
  }
})

// npm has reported a missing script on stdout in some versions, so reading stderr alone would miss the
// single most likely misconfiguration this whole check exists for.
test('a missing script is caught on stdout too', () => {
  assert.equal(classifyProbe({ status: 1, stdout: 'npm error Missing script: "typecheck"' }).runnable, false)
})

test('exit 127 is not runnable even when nothing was written to stderr', () => {
  assert.equal(classifyProbe({ status: 127, stderr: '' }).verdict, 'missing')
})

// THE LOAD-BEARING CASE. A slow suite must not be reported as broken, and it is safe to call it
// runnable precisely because every not-runnable verdict is decided in milliseconds: a command still
// executing at the deadline has already resolved its binary.
test('a timeout counts as runnable', () => {
  const result = classifyProbe({ status: null, timedOut: true })

  assert.equal(result.runnable, true)
  assert.equal(result.verdict, 'slow')
})

// ── spawning ───────────────────────────────────────────────────────────────────

test('probeCommand runs a real command and reports it runnable', () => {
  assert.equal(probeCommand('node --version').verdict, 'pass')
  assert.equal(probeCommand('node -e "process.exit(3)"').verdict, 'fail')
})

test('probeCommand catches a binary that is not installed', () => {
  const result = probeCommand('definitely-not-a-real-binary-93417 --check')

  assert.equal(result.runnable, false)
  assert.equal(result.verdict, 'missing')
})

test('an unset command is not a finding', () => {
  for (const command of [null, undefined, '', '   ']) assert.equal(probeCommand(command).verdict, 'unset')
})

// THE RECURSION GUARD. The docs recommend wiring the selftest into `verify`, so `selftest --probe`
// would run `verify`, which runs the selftest, which probes `verify`. Refused by name, because there
// is no output-based way to detect it before it has already happened.
test('a command that runs the selftest is skipped rather than executed', () => {
  const result = probeCommand('npm test && node .claude/harness/selftest.mjs')

  assert.equal(result.verdict, 'skipped')
  assert.equal(result.runnable, true)
})

// ── wired into the installer ───────────────────────────────────────────────────

const runInit = (root, ...flags) =>
  execFileSync('node', [join(REPO, 'bin/harness-init.mjs'), root, ...flags], { encoding: 'utf8', stdio: 'pipe' })

// THE ORIGINAL BUG, end to end: a package.json whose typecheck script calls a binary that is not
// installed. Before this check, the installer printed the command approvingly and the user found out
// at the end of their first turn, on a failure with no visible connection to setup.
test('init reports a detected command that cannot run', () => {
  const repo = makeRepo({ packageJson: { name: 'x', scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } } })

  try {
    const output = runInit(repo.root)

    assert.match(output, /CANNOT RUN/, 'a command whose binary is absent must be called out')
    assert.match(output, /verify:fast/, 'the broken command must be named')
    assert.match(output, /END OF EVERY TURN/, 'the consequence is what makes it worth fixing')
  } finally {
    repo.cleanup()
  }
})

test('init stays quiet when the commands work', () => {
  const repo = makeRepo({ packageJson: { name: 'x', scripts: { test: 'node --version', typecheck: 'node --version' } } })

  try {
    const output = runInit(repo.root)

    assert.doesNotMatch(output, /CANNOT RUN/)
    assert.match(output, /runs, exit 0/)
  } finally {
    repo.cleanup()
  }
})

test('--no-probe skips execution entirely', () => {
  const repo = makeRepo({ packageJson: { name: 'x', scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } } })

  try {
    const output = runInit(repo.root, '--no-probe')

    assert.doesNotMatch(output, /CANNOT RUN/)
    assert.doesNotMatch(output, /Checking those commands/)
  } finally {
    repo.cleanup()
  }
})

// ── wired into the selftest ────────────────────────────────────────────────────

const runSelftest = (root, ...flags) => {
  try {
    return { code: 0, output: execFileSync('node', [join(root, '.claude/harness/selftest.mjs'), ...flags], { cwd: root, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

// A broken command must FAIL the selftest rather than warn, because "ok (3 warnings)" is read as ok.
test('selftest --probe fails on a command that cannot run', () => {
  const repo = makeRepo({ config: { commands: { verify: 'definitely-not-a-real-binary-93417', verifyFast: 'node --version' } } })

  try {
    const probed = runSelftest(repo.root, '--probe')

    assert.equal(probed.code, 1, 'a command that cannot run is a failure, not a warning')
    assert.match(probed.output, /CANNOT RUN/)

    // ...and without the flag the same repo still passes, so the cost stays opt-in.
    assert.equal(runSelftest(repo.root).code, 0)
  } finally {
    repo.cleanup()
  }
})

test('selftest says so when it has not executed the commands', () => {
  const repo = makeRepo({ config: { commands: { verify: 'node --version', verifyFast: 'node --version' } } })

  try {
    assert.match(runSelftest(repo.root).output, /re-run with --probe/)
  } finally {
    repo.cleanup()
  }
})
