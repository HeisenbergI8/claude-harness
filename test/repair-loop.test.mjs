// The repair loop, in both directions.
//
// THE ALLOW HALF IS THE POINT. A green tree, a first failure, and three DIFFERENT failures in a row must
// never halt. If they do, the gate punishes a model that is converging — which is the exact opposite of
// what it is for, and the reason "count the retries" is the wrong design.
//
// Try it yourself: change `decide` to count attempts instead of fingerprints and watch the
// "three different failures" cases go red. That is the proof the fingerprint is load-bearing.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { decide, fingerprint, haltReport } from '../template/.claude/harness/verify-gate.mjs'

const TS_ERROR = `src/a.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`
const TS_ERROR_MOVED = `src/a.ts(48,9): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`
const TS_OTHER = `src/b.ts(3,1): error TS2304: Cannot find name 'Foo'.`

// ── Fingerprinting ─────────────────────────────────────────────────────────────

test('the same error at a different line is the SAME failure', () => {
  // This is the whole reason line and column numbers are stripped. An error sliding down a file because
  // something above it changed is not progress, and treating it as progress lets a stuck loop run forever.
  assert.equal(fingerprint(TS_ERROR).hash, fingerprint(TS_ERROR_MOVED).hash)
})

test('a different error is a DIFFERENT failure', () => {
  assert.notEqual(fingerprint(TS_ERROR).hash, fingerprint(TS_OTHER).hash)
})

test('failure order does not change the fingerprint', () => {
  assert.equal(fingerprint(`${TS_ERROR}\n${TS_OTHER}`).hash, fingerprint(`${TS_OTHER}\n${TS_ERROR}`).hash)
})

test('adding a failure changes the fingerprint', () => {
  assert.notEqual(fingerprint(TS_ERROR).hash, fingerprint(`${TS_ERROR}\n${TS_OTHER}`).hash)
})

test('output with no recognisable failure line is unparsed, not empty', () => {
  assert.equal(fingerprint('some prose\nand more prose').hash, 'unparsed')
  assert.equal(fingerprint('').hash, 'unparsed')
})

test('failure lines are recognised across ecosystems', () => {
  const samples = [
    'src/a.ts(1,1): error TS2345: nope',
    'FAILED tests/test_a.py::test_thing - AssertionError: 1 != 2',
    'error[E0308]: mismatched types',
    '--- FAIL: TestThing (0.00s)',
    '✖ 3 problems (3 errors, 0 warnings)',
    'panic: runtime error: index out of range'
  ]

  for (const sample of samples) {
    assert.notEqual(fingerprint(sample).hash, 'unparsed', `not recognised as a failure: ${sample}`)
  }
})

// ── The ladder ─────────────────────────────────────────────────────────────────

test('ALLOW: a green tree never blocks', () => {
  assert.equal(decide({ green: true, hash: 'x', previous: { hash: 'x', count: 2 } }).action, 'pass')
})

test('a first failure blocks with the count at 1', () => {
  const verdict = decide({ green: false, hash: 'aaa', previous: {} })

  assert.equal(verdict.action, 'block')
  assert.equal(verdict.count, 1)
})

test('the same failure twice escalates rather than repeating itself', () => {
  const verdict = decide({ green: false, hash: 'aaa', previous: { hash: 'aaa', count: 1 } })

  assert.equal(verdict.action, 'escalate')
  assert.equal(verdict.count, 2)
})

test('the same failure a third time HALTS', () => {
  const verdict = decide({ green: false, hash: 'aaa', previous: { hash: 'aaa', count: 2 } })

  assert.equal(verdict.action, 'halt')
  assert.equal(verdict.count, 3)
})

// THE CENTRAL CASE. Three fixes, three different failures — the model is working, and the loop must
// stay out of its way.
test('ALLOW: three DIFFERENT failures in a row never halt', () => {
  let previous = {}

  for (const hash of ['aaa', 'bbb', 'ccc']) {
    const verdict = decide({ green: false, hash, previous })

    assert.equal(verdict.action, 'block', `hash ${hash} should block, not escalate or halt`)
    assert.equal(verdict.count, 1, 'a changed fingerprint must reset the counter')

    previous = { hash, count: verdict.count, halted: false }
  }
})

test('a changed failure resets a counter that was one step from halting', () => {
  const verdict = decide({ green: false, hash: 'zzz', previous: { hash: 'aaa', count: 2 } })

  assert.equal(verdict.action, 'block')
  assert.equal(verdict.count, 1)
})

test('once halted, the gate never blocks that run again', () => {
  const verdict = decide({ green: false, hash: 'aaa', previous: { hash: 'aaa', count: 9, halted: true } })

  assert.equal(verdict.action, 'pass')
  assert.equal(verdict.code, 'already-halted')
})

test('an unparsed failure blocks but never escalates', () => {
  // Escalating on a signature you could not read is escalating on noise.
  for (const previous of [{}, { hash: 'unparsed', count: 2 }]) {
    const verdict = decide({ green: false, hash: 'unparsed', previous })

    assert.equal(verdict.action, 'block')
    assert.equal(verdict.count, 1)
  }
})

test('maxSameFailure is configurable and respected', () => {
  assert.equal(decide({ green: false, hash: 'a', previous: { hash: 'a', count: 1 }, maxSameFailure: 2 }).action, 'halt')
  assert.equal(decide({ green: false, hash: 'a', previous: { hash: 'a', count: 3 }, maxSameFailure: 5 }).action, 'escalate')
})

// ── The halt report ────────────────────────────────────────────────────────────

test('the halt report names the signature, the failures and what was tried', () => {
  const report = haltReport({
    hash: 'abc123',
    count: 3,
    lines: [TS_ERROR],
    attempts: [{ at: '2026-01-01T00:00:00.000Z', files: ['src/a.ts'] }]
  })

  assert.match(report, /abc123/)
  assert.match(report, /survived 3 attempts/)
  assert.match(report, /src\/a\.ts/)
  assert.match(report, /What was tried/)
})

test('the halt report is still useful when nothing was recorded', () => {
  const report = haltReport({ hash: 'abc', count: 3, lines: [], attempts: [] })

  assert.match(report, /no attempts recorded/)
})
