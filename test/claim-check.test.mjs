// Both directions, and THE ALLOW HALF IS THE IMPORTANT HALF.
//
// A gate that blocks honest work gets switched off, and a switched-off gate protects nothing. Every
// ALLOW case below is a sentence a careful engineer would actually write; if one of them starts
// blocking, the gate is worse than useless regardless of how many real claims it catches.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { CLAIM_PATTERNS, decide, stripQuoted } from '../template/.claude/harness/claim-check.mjs'

const run = (kind, ok) => ({ kind, ok })
const check = input => decide({ patterns: CLAIM_PATTERNS, ...input })

// ── A. Source touched, nothing verified ────────────────────────────────────────

test('BLOCK: edited source and ran nothing', () => {
  const verdict = check({ edits: ['src/a.ts'], runs: [] })

  assert.equal(verdict.action, 'block')
  assert.equal(verdict.code, 'unverified-edit')
})

test('ALLOW: edited source and ran something, even if it failed', () => {
  assert.equal(check({ edits: ['src/a.ts'], runs: [run('typecheck', false)] }).action, 'pass')
})

test('ALLOW: no source edited, no runs — a question, not a change', () => {
  assert.equal(check({ edits: [], runs: [] }).action, 'pass')
})

// ── B. Claims ──────────────────────────────────────────────────────────────────

test('BLOCK: claims a green gate with no run at all', () => {
  const verdict = check({ edits: [], runs: [], message: 'Done. All tests pass.' })

  assert.equal(verdict.action, 'block')
  assert.equal(verdict.code, 'claim-without-run')
})

test('BLOCK: claims green while every run this turn failed', () => {
  const verdict = check({ edits: ['src/a.ts'], runs: [run('test', false)], message: 'The suite passes now.' })

  assert.equal(verdict.action, 'block')
  assert.equal(verdict.code, 'claim-against-red')
})

test('ALLOW: claims green with a green run behind it', () => {
  const verdict = check({ edits: ['src/a.ts'], runs: [run('verify', true)], message: 'verify is green — 40/40 passing.' })

  assert.equal(verdict.action, 'pass')
  assert.equal(verdict.code, 'claim-supported')
})

test('ALLOW: a red run and a green run means something was fixed', () => {
  const runs = [run('test', false), run('test', true)]

  assert.equal(check({ edits: ['src/a.ts'], runs, message: 'tests pass now' }).action, 'pass')
})

// ── Hedged and honest language must never trip ─────────────────────────────────
//
// These are pinned verbatim. Each one is a sentence the gate exists to ENCOURAGE.

for (const message of [
  'I have not run the tests yet.',
  'Next I should run the tests and see.',
  'The suite failed — 3 of 40 are red, and here is the first error.',
  'I could not run the tests because the database was unreachable.',
  'This change is unverified; I did not have a way to exercise the UI.',
  'Typecheck would probably pass but I have not confirmed it.',
  'Should I run the tests before you review this?'
]) {
  test(`ALLOW (honest): ${message.slice(0, 48)}`, () => {
    assert.equal(check({ edits: [], runs: [], message }).action, 'pass')
  })
}

// ── USE vs MENTION ─────────────────────────────────────────────────────────────
//
// The gate's own subject is the sentence "tests pass", so any message ABOUT the gate contains the
// phrase it hunts. Without stripQuoted this fires forever — and worse, it penalises pasting real
// command output as evidence, which is the practice you most want to encourage.

test('stripQuoted removes fenced blocks, inline code and bounded quotes', () => {
  assert.ok(!stripQuoted('```\nall tests pass\n```').includes('tests pass'))
  assert.ok(!stripQuoted('the string `all tests pass` is what it matches').includes('tests pass'))
  assert.ok(!stripQuoted('it fires on "all tests pass" specifically').includes('tests pass'))
})

test('stripQuoted does NOT strip bold — a real claim is often emphasised', () => {
  assert.ok(stripQuoted('**all tests pass**').includes('tests pass'))
})

test('stripQuoted bounds a quoted span so it cannot swallow a real claim', () => {
  // An unbounded "[^"]*" would eat everything between these two distant quotes, hiding the assertion
  // sitting between them.
  const message = `He said "one thing" and then, after a long unrelated digression that runs on for a while, all tests pass, and later "another thing"`

  assert.ok(stripQuoted(message).includes('tests pass'))
})

for (const message of [
  'The check fires on the phrase `verify is green`.',
  'Acceptance criterion: "all tests pass" before merge.',
  'Here is the output:\n```\n40/40 passing\n```\nbut the e2e run is still outstanding.',
  'The termination condition is that typecheck is clean.'.replace('typecheck is clean', '`typecheck is clean`')
]) {
  test(`ALLOW (mention, not use): ${message.slice(0, 48).replace(/\n/g, ' ')}`, () => {
    assert.equal(check({ edits: [], runs: [], message }).action, 'pass')
  })
}

// ── Narrowed patterns: prose about exit codes is not a claim ───────────────────

test('ALLOW: explaining what an exit code means', () => {
  const message = 'A zero exit means the step landed; a non-zero one means it did not.'

  assert.equal(check({ edits: [], runs: [], message }).action, 'pass')
})

test('ALLOW: "the baseline unchanged line" is describing a line, not asserting a state', () => {
  const message = 'The baseline unchanged line in the report is what proves the suite did not regress.'

  assert.equal(check({ edits: [], runs: [], message }).action, 'pass')
})

test('BLOCK: "the baseline is unchanged at 316/318" IS asserting a state', () => {
  const message = 'Everything landed with the baseline unchanged at 316/318.'

  assert.equal(check({ edits: [], runs: [], message }).action, 'block')
})

test('BLOCK: "typecheck exit 0" with a verification noun nearby', () => {
  assert.equal(check({ edits: [], runs: [], message: 'typecheck came back exit 0.' }).action, 'block')
})

// ── Claim shapes that must be caught ───────────────────────────────────────────

for (const message of [
  'Done! 31/31 tests passing.',
  'All tests are green.',
  'verify is clean.',
  'lint passed.',
  'I ran the tests and everything is fine.',
  'The build passes.'
]) {
  test(`BLOCK (real claim): ${message}`, () => {
    assert.equal(check({ edits: [], runs: [], message }).action, 'block')
  })
}

test('no message at all falls back to check A only', () => {
  assert.equal(check({ edits: [], runs: [], message: '' }).code, 'no-message')
  assert.equal(check({ edits: ['src/a.ts'], runs: [], message: '' }).code, 'unverified-edit')
})
