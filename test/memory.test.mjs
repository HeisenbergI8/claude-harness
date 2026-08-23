// The memory layer: a capped semantic store that is injected, and an episodic layer that never is.
//
// The two failure modes are opposite. Lessons fail by BLOATING — every entry is paid for on every
// matching prompt, so the cap and the audit are what keep it useful. Candidates fail by MISSING — a
// missed incident is a lesson lost, so their patterns over-match on purpose.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { auditLessons, matches, parseLesson, select } from '../template/.claude/harness/lessons.mjs'
import { classify } from '../template/.claude/harness/candidates.mjs'
import { decide } from '../template/.claude/harness/lesson-prompt.mjs'
import {
  decide as decideCapacity,
  dispositionsFor,
  reviewThreshold
} from '../template/.claude/harness/lesson-capacity.mjs'

const lesson = (id, trigger, body = '**Lesson:** Do the thing.') =>
  parseLesson(`${id}.md`, `---\nid: ${id}\ntrigger: ${trigger}\nscope: build\nlearned: 2026-01-01\n---\n\n${body}\n`)

// ── Parsing ────────────────────────────────────────────────────────────────────

test('a well-formed lesson parses, and the summary is the index line', () => {
  const parsed = lesson('a-thing', 'hook, guard, fires')

  assert.equal(parsed.id, 'a-thing')
  assert.deepEqual(parsed.terms, ['hook', 'guard', 'fires'])
  assert.equal(parsed.summary, 'Do the thing.')
})

test('missing frontmatter is reported, not thrown', () => {
  assert.match(parseLesson('x.md', 'no frontmatter here').error, /missing frontmatter block/)
  assert.match(parseLesson('x.md', '---\nid: x\n---\n\nbody').error, /missing frontmatter: trigger, scope, learned/)
})

// A term that matches everything injects the whole store on every prompt, and trains the reader to
// ignore it.
test('stop terms are dropped from triggers', () => {
  assert.deepEqual(lesson('x', 'the, a, is, lockfile, code').terms, ['lockfile'])
})

// A false positive costs a few hundred tokens. A false negative costs the entire mechanism, because a
// lesson that fails to surface is a lesson that was never written.
test('matching is substring, so plurals and inflections still hit', () => {
  const parsed = lesson('x', 'hook, lockfile')

  assert.ok(matches(parsed, 'why did the hooks stop firing'))
  assert.ok(matches(parsed, 'two lockfiles in this repo'))
  assert.ok(!matches(parsed, 'something entirely unrelated'))
})

// ── Injection ──────────────────────────────────────────────────────────────────

test('the index goes out once per session; matches go out in full', () => {
  const lessons = [lesson('a', 'lockfile'), lesson('b', 'typecheck')]

  const first = select({ lessons, prompt: 'the lockfile is wrong', firstOfSession: true })

  assert.equal(first.index.length, 2)
  assert.deepEqual(first.fresh.map(entry => entry.id), ['a'])

  const second = select({ lessons, prompt: 'the lockfile again', alreadySent: ['a'], firstOfSession: false })

  assert.equal(second.index.length, 0)
  assert.equal(second.fresh.length, 0, 'a lesson already in context is not re-sent in full')
  assert.deepEqual(second.repeats.map(entry => entry.id), ['a'], 'it becomes a one-line pointer instead')
})

test('a non-matching prompt costs nothing', () => {
  const result = select({ lessons: [lesson('a', 'lockfile')], prompt: 'unrelated question', firstOfSession: false })

  assert.equal(result.fresh.length, 0)
  assert.equal(result.repeats.length, 0)
})

// ── Audit ──────────────────────────────────────────────────────────────────────

const limits = { max: 3, maxBodyLines: 25 }

test('the cap FAILS the audit — a cap that is only a comment is not a cap', () => {
  const lessons = ['a', 'b', 'c', 'd'].map(id => lesson(id, `${id}term`))
  const { problems } = auditLessons(lessons, limits)

  assert.equal(problems.length, 1)
  assert.match(problems[0], /Do NOT raise the cap/)
})

test('duplicate ids fail', () => {
  assert.match(auditLessons([lesson('same', 'x'), lesson('same', 'y')], limits).problems[0], /duplicate id/)
})

test('a malformed file fails', () => {
  assert.equal(auditLessons([parseLesson('bad.md', 'garbage')], limits).problems.length, 1)
})

// Two lessons sharing three triggers always inject together: they are one lesson filed twice.
test('lessons sharing three triggers are flagged for consolidation', () => {
  const { warnings } = auditLessons([lesson('a', 'hook, guard, fires'), lesson('b', 'hook, guard, fires, extra')], limits)

  assert.ok(warnings.some(warning => /consolidate/.test(warning)))
})

// The intended end state of a lesson is DELETION. A store shrinking because entries became guards is
// the system working.
test('a lesson marked as encoded is told to graduate and be deleted', () => {
  const encoded = parseLesson(
    'x.md',
    '---\nid: x\ntrigger: y\nscope: build\nlearned: 2026-01-01\nencoded: .claude/harness/guard-x.mjs\n---\n\n**Lesson:** y\n'
  )

  assert.ok(auditLessons([encoded], limits).warnings.some(warning => /GRADUATE IT/.test(warning)))
})

test('a lesson with no usable triggers can never be retrieved, and is flagged', () => {
  assert.ok(auditLessons([lesson('x', 'the, a, is')], limits).warnings.some(warning => /never be retrieved/.test(warning)))
})

test('an over-long body is warned, not failed', () => {
  const long = lesson('x', 'y', `**Lesson:** y\n${'line\n'.repeat(30)}`)
  const { problems, warnings } = auditLessons([long], limits)

  assert.equal(problems.length, 0)
  assert.ok(warnings.some(warning => /over 25/.test(warning)))
})

// ── Candidate capture ──────────────────────────────────────────────────────────
//
// CAPTURE GENEROUSLY. A missed candidate is a lesson lost; a noisy one is a line somebody skims.

for (const message of [
  'No, that is not what I asked for.',
  "that's wrong, the filter should be on the left",
  'Actually the endpoint returns a list, not an object',
  'you were mistaken about the auth flow',
  'I already told you to leave that file alone',
  'why did you refactor the whole module?',
  'undo that',
  "don't add new dependencies",
  're-read the spec'
]) {
  test(`captures correction: ${message.slice(0, 44)}`, () => assert.ok(classify('record', message), message))
}

for (const message of [
  'Please add a column for the created date.',
  'Can you check whether the tests pass?',
  'What does this function do?',
  'Looks good, ship it.',
  'Add pagination to the list view.'
]) {
  test(`ordinary request is not a correction: ${message.slice(0, 40)}`, () =>
    assert.equal(classify('record', message), null, message))
}

for (const message of [
  'I was wrong about the mapper.',
  'My mistake — the slice was never registered.',
  'I should have run the tests first.',
  'I assumed the API returned camelCase, but it turned out to be snake_case.',
  'I did not actually run the suite.',
  'I missed the middleware registration.'
]) {
  test(`captures self-correction: ${message.slice(0, 44)}`, () => assert.ok(classify('reflect', message), message))
}

test('ordinary reporting is not a self-correction', () => {
  for (const message of ['I ran the tests and they pass.', 'I added the column and verified it renders.', 'Done.']) {
    assert.equal(classify('reflect', message), null, message)
  }
})

// USE vs MENTION, again. A message documenting the capture patterns is not an incident.
test('quoted and fenced text is not captured', () => {
  assert.equal(classify('reflect', 'The pattern matches `I was wrong` specifically.'), null)
  assert.equal(classify('record', 'It fires on "no, that is wrong" and similar.'), null)
  assert.equal(classify('reflect', '```\nI was wrong\n```'), null)
})

// ── The lesson prompt ──────────────────────────────────────────────────────────

test('asks only when something was actually captured', () => {
  assert.equal(decide({ candidates: [] }).action, 'pass')
  assert.equal(decide({ candidates: [{ kind: 'correction', at: '2026-01-02', text: 'x' }] }).action, 'ask')
})

// A review agent completing is not evidence anything went wrong.
test('a review completion alone is not worth asking about', () => {
  assert.equal(decide({ candidates: [{ kind: 'review', at: '2026-01-02', text: 'x' }] }).action, 'pass')
})

test('it asks at most once per session', () => {
  const candidates = [{ kind: 'correction', at: '2026-01-02', text: 'x' }]

  assert.equal(decide({ candidates, askedThisSession: true }).action, 'pass')
})

test('only incidents from THIS session count', () => {
  const candidates = [{ kind: 'correction', at: '2026-01-01T00:00:00Z', text: 'old' }]

  assert.equal(decide({ candidates, sessionStartedAt: '2026-06-01T00:00:00Z' }).action, 'pass')
})

// The capacity gate stands down while there is room, so the same test can assert the ALLOW half.
test('a store below the threshold is never asked about', () => {
  assert.equal(decideCapacity({ candidates: [] }).action, 'pass')
  assert.equal(decideCapacity({ lessons: [], max: 4 }).action, 'pass', 'an empty store is not a full one')

  for (const size of [1, 2]) {
    const lessons = Array.from({ length: size }, (_, i) => lesson(`l${i}`, `t${i}`))

    assert.equal(decideCapacity({ lessons, max: 4 }).action, 'pass', `${size}/4 is below the threshold of 4`)
  }
})

test('the threshold is below the cap, because a full store has already lost the argument', () => {
  assert.equal(reviewThreshold({ max: 40 }), 32)
  assert.equal(reviewThreshold({ max: 40, reviewAt: 20 }), 20, 'an explicit reviewAt wins')
  assert.equal(reviewThreshold({ max: 1 }), 1, 'the threshold is never zero')
})

test('it asks once the store reaches the threshold, and again only if the store grew', () => {
  const lessons = ['a', 'b', 'c', 'd'].map(id => lesson(id, `${id}term`))
  const asked = decideCapacity({ lessons, max: 5 })

  assert.equal(asked.action, 'ask')
  assert.equal(asked.count, 4)

  // Bounded: a second block costs a NEW lesson, so there is no state it can hold a session in.
  assert.equal(decideCapacity({ lessons, max: 5, askedThisSession: true, askedAtCount: 4 }).action, 'pass')
  assert.equal(decideCapacity({ lessons, max: 5, askedThisSession: true, askedAtCount: 3 }).action, 'ask')
})

test('a broken file is not counted towards capacity', () => {
  const lessons = [lesson('a', 'aterm'), lesson('b', 'bterm'), parseLesson('bad.md', 'garbage')]

  assert.equal(decideCapacity({ lessons, max: 3 }).count, 2)
})

test('over the cap is reported as over, not merely full', () => {
  const lessons = ['a', 'b', 'c', 'd'].map(id => lesson(id, `${id}term`))

  assert.equal(decideCapacity({ lessons, max: 3 }).overCap, true)
})

// The point of the block: "you are at 33 of 40" is a number somebody has to go and investigate. A
// named pair sharing four triggers is a decision that can be made at the end of a turn.
test('the proposals name specific entries and the strongest signal claims each one', () => {
  const encoded = parseLesson(
    'x.md',
    '---\nid: graduated\ntrigger: xterm\nscope: build\nlearned: 2026-01-01\nencoded: .claude/harness/guard-x.mjs\n---\n\n**Lesson:** x\n'
  )
  const twins = [lesson('twin-a', 'hook, guard, fires'), lesson('twin-b', 'hook, guard, fires, extra')]
  const cold = lesson('cold', 'coldterm')
  const proposals = dispositionsFor([encoded, ...twins, cold], { 'twin-a': 3, 'twin-b': 2, cold: 7, graduated: 9 })

  const by = disposition => proposals.filter(entry => entry.disposition === disposition)

  assert.deepEqual(by('delete')[0].ids, ['graduated'], 'a lesson that says it was encoded elsewhere is duplicate enforcement')
  assert.deepEqual(by('consolidate')[0].ids, ['twin-a', 'twin-b'])
  assert.equal(by('consolidate').length, 1, 'the pair is claimed, so neither half is proposed twice')
  assert.deepEqual(by('prune')[0].ids, ['cold'], 'only what no stronger signal claimed is offered as a plain prune')
})

// Deleting a zero-hit lesson is how the store loses its best entries first: it is usually filed under
// words nobody types, not wrong.
test('a lesson that has never matched is offered as a trigger fix, not a deletion', () => {
  const proposals = dispositionsFor([lesson('never', 'obscureterm')], {})

  assert.equal(proposals[0].disposition, 'retrigger')
  assert.match(proposals[0].why, /never matched/)
})

test('the proposal list is bounded, so the block stays readable', () => {
  const lessons = Array.from({ length: 30 }, (_, i) => lesson(`l${i}`, `t${i}`))

  assert.ok(dispositionsFor(lessons, {}).length <= 8)
})

// Two gates arguing in one turn: one asking whether to add a lesson, the other saying there is nowhere
// to put it.
test('the lesson prompt stands down while the capacity gate owns the turn', () => {
  const candidates = [{ kind: 'correction', at: '2026-01-02', text: 'x' }]

  assert.equal(decide({ candidates }).action, 'ask')
  assert.equal(decide({ candidates, storeFull: true }).action, 'pass')
})
