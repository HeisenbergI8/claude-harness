#!/usr/bin/env node
// Stop gate: when the lesson store fills up, it stops the turn and makes the disposition question —
// consolidate, graduate, delete, keep — get PUT TO THE USER instead of quietly deferred.
//
//   node .claude/harness/lesson-capacity.mjs          Stop hook
//   node .claude/harness/lesson-capacity.mjs --report  what it would ask right now, as text
//
// ── WHY THIS EXISTS SEPARATELY FROM THE AUDIT ──────────────────────────────────
//
// `lessons.mjs audit` already fails over the cap, and `selftest.mjs` already reports the count. Both
// require somebody to run them. In practice the store crosses the cap during a session that is about
// something else entirely, the audit is next run days later, and by then the answer to "which of these
// forty do we still need" has to be reconstructed from scratch.
//
// This fires at the moment it is answerable — while the store is still one or two entries from full and
// the person who wrote the last few is present.
//
// ── IT ASKS THE USER, NOT THE MODEL ────────────────────────────────────────────
//
// Every other blocking gate here hands the model a problem it can fix alone. This one cannot be fixed
// alone: which lessons are still load-bearing is a judgement about the project, and a model deleting
// curated memory to make room is the single worst outcome available. So the block instructs the model
// to put the question to the user with `AskUserQuestion` and forbids acting before an answer.
//
// ── IT NEVER DELETES, EDITS, OR WRITES A LESSON ────────────────────────────────
//
// Nothing automatic in this harness touches the store. This gate reads it, names the candidates, and
// gets out of the way — the same bar `lesson-prompt.mjs` holds for writing one.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { block, load, readPayload } from './config.mjs'
import { loadLessons } from './lessons.mjs'

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

// ── What to propose ────────────────────────────────────────────────────────────
//
// Pure, exported, and the reason the block is worth its cost: "you are at 33 of 40" is a number the
// reader has to go and investigate. A named pair sharing four triggers is a decision that can be made
// on the spot.
//
// Strongest signal wins and claims the entry, so no lesson appears twice and the list stays short
// enough to read at the end of a turn.
export const dispositionsFor = (lessons, hits = {}, limit = 8) => {
  const out = []
  const claimed = new Set()

  const push = (ids, disposition, why) => {
    if (ids.some(id => claimed.has(id))) return

    for (const id of ids) claimed.add(id)
    out.push({ ids, disposition, why })
  }

  // 1. GRADUATED. The entry says so itself: it is enforced somewhere mechanical now, and is being paid
  // for on every matching prompt to say a thing a guard already refuses.
  for (const lesson of lessons) {
    if (lesson.encoded) push([lesson.id], 'delete', `already encoded in ${lesson.encoded} — it graduated, and the entry is now duplicate enforcement`)
  }

  // 2. FILED TWICE. Three shared triggers means these two always inject together, so the reader has
  // never seen one without the other and consolidating loses nothing.
  for (let i = 0; i < lessons.length; i += 1) {
    for (let j = i + 1; j < lessons.length; j += 1) {
      const shared = lessons[i].terms.filter(term => lessons[j].terms.includes(term))

      if (shared.length >= 3) {
        push([lessons[i].id, lessons[j].id], 'consolidate', `share ${shared.length} triggers (${shared.slice(0, 4).join(', ')}) — they always inject together`)
      }
    }
  }

  // 3. NEVER RETRIEVED. Deliberately NOT proposed as a deletion. A lesson with zero hits is usually
  // excellent and filed under words nobody types, and deleting it is how the store loses its best
  // entries first — so the option offered is rewriting the triggers.
  for (const lesson of lessons) {
    if (!(hits[lesson.id] > 0)) push([lesson.id], 'retrigger', 'has never matched a prompt — usually a trigger bug rather than a dead lesson')
  }

  // 4. COLDEST REMAINING. Only reached when the store is full of entries that all work, which is the
  // case where there is no mechanical answer and the user has to choose.
  const cold = lessons
    .filter(lesson => !claimed.has(lesson.id))
    .sort((a, b) => (hits[a.id] ?? 0) - (hits[b.id] ?? 0))
    .slice(0, 3)

  for (const lesson of cold) push([lesson.id], 'prune', `${hits[lesson.id] ?? 0} hit(s) — the least-used entry still earning its tokens`)

  return out.slice(0, limit)
}

// Where the review is due. Exported because `lesson-prompt.mjs` stands down above it — asking "is this
// worth recording?" while the store has nowhere to put the answer is two gates arguing in one turn.
export const reviewThreshold = ({ max = 40, reviewAt = null } = {}) => Math.max(1, reviewAt ?? Math.ceil(max * 0.8))

// ── The decision, as a pure function ───────────────────────────────────────────
//
// `askedAtCount` rather than a plain per-session flag: answering the question and then writing another
// lesson is exactly the case where asking again is right, and it is also what BOUNDS the gate. Each
// further block costs a new entry, so there is no state it can hold a session in.
export const decide = ({ lessons = [], hits = {}, max = 40, reviewAt = null, askedThisSession = false, askedAtCount = 0 }) => {
  const valid = lessons.filter(lesson => !lesson.error)
  const count = valid.length
  const threshold = reviewThreshold({ max, reviewAt })

  if (!count) return { action: 'pass', why: 'no lessons on file', count, threshold }

  if (count < threshold) return { action: 'pass', why: `${count}/${max} lessons — below the review threshold of ${threshold}`, count, threshold }

  if (askedThisSession && count <= askedAtCount) {
    return { action: 'pass', why: 'already asked this session, and the store has not grown since', count, threshold }
  }

  return {
    action: 'ask',
    why: count > max ? `${count} lessons, OVER the cap of ${max}` : `${count} of ${max} lessons`,
    count,
    threshold,
    overCap: count > max,
    dispositions: dispositionsFor(valid, hits)
  }
}

// ── The block ──────────────────────────────────────────────────────────────────

const message = (config, verdict) => {
  const lines = verdict.dispositions.map(entry => `  · ${entry.disposition.toUpperCase()}  ${entry.ids.join(' + ')} — ${entry.why}`)

  return (
    `The lesson store is ${verdict.overCap ? 'OVER capacity' : 'nearly full'}: ${verdict.why} in \`${config.lessons.dir}\`.\n\n` +
    (verdict.overCap
      ? `\`lessons.mjs audit\` is failing right now, and the next lesson has nowhere to go.\n\n`
      : `Room is made BEFORE it runs out, not after — a store that is exactly full has already lost the argument.\n\n`) +
    `Candidates, strongest signal first:\n${lines.join('\n')}\n\n` +
    `PUT THIS TO THE USER NOW, with \`AskUserQuestion\`. Do not decide it yourself and do not touch a ` +
    `single file in \`${config.lessons.dir}\` before they answer — which lessons are still load-bearing is a ` +
    `judgement about this project, and curated memory deleted to make room is not recoverable.\n\n` +
    `Ask one question per candidate above (up to four at a time), each offering the real options:\n\n` +
    `  · CONSOLIDATE — fold two entries into one, keeping both trigger sets\n` +
    `  · GRADUATE — encode it as a guard in \`.claude/harness/\`, wire it in \`settings.json\` with ` +
    `both-direction tests, THEN delete the lesson. The best outcome and the most often skipped\n` +
    `  · PROMOTE — move it to \`CONVENTIONS.md\` if it is a standing fact rather than a behaviour change\n` +
    `  · RETRIGGER — keep it, rewrite the trigger terms to words that appear in a real request\n` +
    `  · DELETE — it was a one-off, or it is obsolete\n` +
    `  · KEEP — it still earns its tokens; raise nothing, defer the question\n\n` +
    `Raising \`lessons.max\` is not on that list. The cap is what keeps a curated set from becoming a log; ` +
    `raise it and this gate stops meaning anything.\n\n` +
    `Run \`node .claude/harness/lessons.mjs list\` and \`stats\` first if you need the full picture, then ` +
    `carry out whatever the user chose. The \`lessons-review\` skill has the long form.`
  )
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const main = async () => {
  const config = load()

  if (config.lessons?.enabled === false) process.exit(0)

  const lessons = loadLessons(config.lessons.dir)
  const hits = readJson(config.statePaths.lessonsState, {}).hits ?? {}
  const statePath = config.statePaths.lessonCapacityState

  if (process.argv.includes('--report')) {
    const verdict = decide({ lessons, hits, max: config.lessons.max, reviewAt: config.lessons.reviewAt })

    console.log(`  ${verdict.action === 'ask' ? 'WOULD ASK' : 'quiet'} — ${verdict.why} (threshold ${verdict.threshold})`)

    for (const entry of verdict.dispositions ?? []) console.log(`    ${entry.disposition}  ${entry.ids.join(' + ')} — ${entry.why}`)

    process.exit(0)
  }

  const payload = await readPayload()

  if (!payload) process.exit(0)
  if (payload.stop_hook_active === true) process.exit(0)

  const session = payload.session_id ?? 'unknown'
  const state = readJson(statePath, {})

  const verdict = decide({
    lessons,
    hits,
    max: config.lessons.max,
    reviewAt: config.lessons.reviewAt,
    askedThisSession: state.session === session,
    askedAtCount: state.count ?? 0
  })

  if (verdict.action !== 'ask') process.exit(0)

  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify({ session, count: verdict.count, at: new Date().toISOString() })}\n`)
  } catch {
    /* one extra ask is better than a crashed turn */
  }

  block(message(config, verdict))
}

if (process.argv[1]?.endsWith('lesson-capacity.mjs')) main()
