#!/usr/bin/env node
// The lesson store: a small, deliberately CAPPED set of things this project learned the hard way.
//
//   node .claude/harness/lessons.mjs inject   UserPromptSubmit hook — push matching lessons into context
//   node .claude/harness/lessons.mjs audit    non-zero on cap breach, malformed file, duplicate id
//   node .claude/harness/lessons.mjs list     what is on file, with hit counts
//   node .claude/harness/lessons.mjs stats    usage counters, so pruning is a data decision
//
// Three constraints produced this shape:
//
//   1. A KNOWLEDGE BASE NOBODY READS IS A LOG. Retrieval is a HOOK, not a habit: `inject` runs on
//      UserPromptSubmit and pushes matching lessons into context whether or not the model remembers
//      this file exists. A non-matching prompt costs nothing.
//
//   2. EVERY ENTRY IS PAID FOR IN TOKENS on every matching prompt, so the cap is the discipline. Past
//      ~40 the index stops being scannable and injection stops being cheap.
//
//   3. THE INTENDED END STATE OF A LESSON IS DELETION. Once it hardens into a standing rule it
//      graduates into project docs, a guard, or a decision record, and the file is removed. This
//      directory stages what is not yet mechanically enforceable. The store SHRINKING because three
//      entries became one guard is the system working as designed.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { load } from './config.mjs'

// Terms this common match everything, which would inject the whole store on every prompt and train the
// reader to ignore it.
const STOP_TERMS = new Set(['the', 'a', 'is', 'in', 'to', 'and', 'or', 'of', 'it', 'this', 'that', 'code', 'file', 'for'])

const REQUIRED = ['id', 'trigger', 'scope', 'learned']

// Deliberately not YAML. Three scalar fields and a comma list do not justify a dependency, and a parser
// that cannot throw on exotic input is a parser that cannot break the hook.
export const parseLesson = (name, raw) => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)

  if (!match) return { name, error: 'missing frontmatter block' }

  const meta = {}

  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')

    if (separator === -1) continue

    meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }

  const missing = REQUIRED.filter(key => !meta[key])

  if (missing.length) return { name, error: `missing frontmatter: ${missing.join(', ')}` }

  const body = match[2].trim()

  // TRIGGERS ARE THE HIGHEST-LEVERAGE FIELD. A lesson that never matches a prompt was never written.
  const terms = meta.trigger
    .split(',')
    .map(term => term.trim().toLowerCase())
    .filter(term => term && !STOP_TERMS.has(term))

  return {
    name,
    id: meta.id,
    scope: meta.scope,
    learned: meta.learned,
    evidence: meta.evidence ?? '',
    encoded: meta.encoded ?? '',
    terms,
    body,
    bodyLines: body.split('\n').length,
    summary: (body.split('\n').find(line => line.startsWith('**Lesson:**')) ?? body.split('\n')[0] ?? '')
      .replace('**Lesson:**', '')
      .trim()
  }
}

export const loadLessons = (dir) => {
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter(name => name.endsWith('.md') && name !== 'README.md')
    .sort()
    .map(name => parseLesson(name, readFileSync(join(dir, name), 'utf8')))
}

// SUBSTRING rather than word matching, on purpose: "hook" should match "hooks", "lockfile" should match
// "lockfiles". A false positive costs a few hundred tokens; a false negative costs the entire
// mechanism, because a lesson that fails to surface is a lesson that was never written.
export const matches = (lesson, text) => lesson.terms.some(term => text.includes(term))

const readState = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { sessions: {}, hits: {} }
  }
}

const writeState = (path, state) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state)}\n`)
  } catch {
    /* state is an optimisation, never a hard dependency */
  }
}

const readStdin = async () => {
  const chunks = []

  for await (const chunk of process.stdin) chunks.push(chunk)

  return Buffer.concat(chunks).toString('utf8')
}

// ── inject ─────────────────────────────────────────────────────────────────────
//
// Pure selection, exported so the tests can assert what WOULD be injected without a hook payload.
//
// A lesson whose full text is already verbatim in this session's context does not need sending again —
// a repeat is bytes the model has already read. Repeats become a one-line pointer; FIRST sight is
// unchanged, because the cost being removed is repetition, not recall.
export const select = ({ lessons, prompt, alreadySent = [], firstOfSession = true }) => {
  const sent = new Set(alreadySent)
  const hits = lessons.filter(lesson => prompt && matches(lesson, prompt))

  return {
    index: firstOfSession ? lessons : [],
    fresh: hits.filter(lesson => !sent.has(lesson.id)),
    repeats: hits.filter(lesson => sent.has(lesson.id)),
    hits
  }
}

const inject = async config => {
  let payload = {}

  try {
    payload = JSON.parse(await readStdin())
  } catch {
    /* an empty prompt still gets the index once */
  }

  const lessons = loadLessons(config.lessons.dir).filter(lesson => !lesson.error)

  if (!lessons.length) process.exit(0)

  const prompt = String(payload?.prompt ?? '').toLowerCase()
  const session = String(payload?.session_id ?? 'unknown')
  const statePath = config.statePaths.lessonsState
  const state = readState(statePath)
  const entry = state.sessions[session]

  const { index, fresh, repeats, hits } = select({
    lessons,
    prompt,
    alreadySent: entry?.sent ?? [],
    firstOfSession: !entry
  })

  state.sessions[session] = { sent: [...new Set([...(entry?.sent ?? []), ...fresh.map(lesson => lesson.id)])] }

  // Counted on every match, fresh or repeat: `stats` measures how often a lesson is RELEVANT, which is
  // what pruning decisions are made on. Suppressing a redundant copy must not make a lesson look less
  // used than it is.
  for (const lesson of hits) state.hits[lesson.id] = (state.hits[lesson.id] ?? 0) + 1

  const sessionIds = Object.keys(state.sessions)

  if (sessionIds.length > 200) for (const id of sessionIds.slice(0, sessionIds.length - 200)) delete state.sessions[id]

  writeState(statePath, state)

  const sections = []

  if (index.length) {
    sections.push(
      `This project keeps ${index.length} lesson(s) in \`${config.lessons.dir}\` — things it learned the ` +
        `hard way. The full text of any that match your prompt is injected automatically.\n` +
        index.map(lesson => `  · ${lesson.id} — ${lesson.summary}`).join('\n')
    )
  }

  for (const lesson of fresh) {
    sections.push(
      `LESSON — ${lesson.id} (learned ${lesson.learned})\n${lesson.body}\n\n` +
        `This is a prior decision made by someone with more context than you have right now. ` +
        `Override it if you have a reason, but SAY that you are.`
    )
  }

  if (repeats.length) {
    sections.push(`Also relevant, already shown this session: ${repeats.map(lesson => lesson.id).join(', ')}`)
  }

  if (!sections.length) process.exit(0)

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: sections.join('\n\n') }
    })}\n`
  )
  process.exit(0)
}

// ── audit ──────────────────────────────────────────────────────────────────────
//
// A cap that is only a comment is not a cap. Wire this into your verify command.
export const auditLessons = (lessons, { max, maxBodyLines }) => {
  const problems = []
  const warnings = []
  const seen = new Map()

  for (const lesson of lessons) {
    if (lesson.error) {
      problems.push(`${lesson.name}: ${lesson.error}`)
      continue
    }

    if (seen.has(lesson.id)) problems.push(`duplicate id "${lesson.id}" in ${lesson.name} and ${seen.get(lesson.id)}`)
    seen.set(lesson.id, lesson.name)

    if (lesson.bodyLines > maxBodyLines) {
      warnings.push(`${lesson.id}: ${lesson.bodyLines} lines (over ${maxBodyLines}) — usually two lessons, or belongs in project docs`)
    }

    if (!lesson.terms.length) warnings.push(`${lesson.id}: no usable trigger terms — it can never be retrieved`)
    if (lesson.encoded) warnings.push(`${lesson.id}: encoded as ${lesson.encoded} — GRADUATE IT, then delete the lesson`)
  }

  // Two lessons sharing three or more triggers always inject together: they are one lesson filed twice.
  const valid = lessons.filter(lesson => !lesson.error)

  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const shared = valid[i].terms.filter(term => valid[j].terms.includes(term))

      if (shared.length >= 3) {
        warnings.push(`${valid[i].id} and ${valid[j].id} share ${shared.length} triggers — consolidate them`)
      }
    }
  }

  if (valid.length > max) {
    problems.push(
      `${valid.length} lessons, cap is ${max}. Do NOT raise the cap — consolidate, graduate, or prune. ` +
        `The cap is what keeps a curated set from becoming a log.`
    )
  }

  return { problems, warnings, count: valid.length }
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const main = async () => {
  const config = load()
  const command = process.argv[2]

  if (config.lessons?.enabled === false) process.exit(0)

  if (command === 'inject') return inject(config)

  const lessons = loadLessons(config.lessons.dir)
  const state = readState(config.statePaths.lessonsState)

  if (command === 'audit') {
    const { problems, warnings, count } = auditLessons(lessons, config.lessons)

    for (const warning of warnings) console.log(`  WARN  ${warning}`)
    for (const problem of problems) console.log(`  FAIL  ${problem}`)

    console.log(`- lessons: ${count}/${config.lessons.max}`)
    process.exit(problems.length ? 1 : 0)
  }

  if (command === 'list') {
    if (!lessons.length) console.log('  no lessons recorded')

    for (const lesson of lessons) {
      if (lesson.error) {
        console.log(`  ${lesson.name}: BROKEN — ${lesson.error}`)
        continue
      }

      console.log(`  ${lesson.id}  (${state.hits[lesson.id] ?? 0} hits, ${lesson.scope}, ${lesson.learned})`)
      console.log(`      ${lesson.summary}`)
      console.log(`      triggers: ${lesson.terms.join(', ')}`)
    }

    process.exit(0)
  }

  if (command === 'stats') {
    const rows = lessons
      .filter(lesson => !lesson.error)
      .map(lesson => ({ id: lesson.id, hits: state.hits[lesson.id] ?? 0 }))
      .sort((a, b) => b.hits - a.hits)

    for (const row of rows) console.log(`  ${String(row.hits).padStart(4)}  ${row.id}`)

    const never = rows.filter(row => row.hits === 0)

    if (never.length) {
      console.log(
        `\n  ${never.length} lesson(s) have never matched a prompt. That is usually a TRIGGER bug rather ` +
          `than a reason to delete — check the terms against the words that appear in a real request.`
      )
    }

    process.exit(0)
  }

  console.log('usage: lessons.mjs <inject|audit|list|stats>')
  process.exit(2)
}

if (process.argv[1]?.endsWith('lessons.mjs')) main()
