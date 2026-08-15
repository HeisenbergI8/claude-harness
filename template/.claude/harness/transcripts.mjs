#!/usr/bin/env node
// Shared reader for Claude Code's own session transcripts.
//
// Everything else in this harness reads the ledger — what the hooks recorded. This reads what the
// SESSION recorded, which is a different and larger record: every tool call with its result, every
// subagent's final report, and the token usage that no hook payload carries. It is the only source for
// "what did that agent actually do", and it is on disk already.
//
// ONE READER, MANY CONSUMERS. `cost.mjs` and `agent-eval.mjs` both need to walk transcripts, resolve
// subagent files and recover agent types. The second one to need it copies the first one's walker, and
// then the format shifts and only one of them is fixed. This harness already learned that lesson with
// the activity ledger; the fix was one reader, and it is the same fix here.
//
// ── WHERE THINGS LIVE ──────────────────────────────────────────────────────────
//
//   ~/.claude/projects/<cwd-with-separators-as-dashes>/
//     <session-uuid>.jsonl                          the main thread
//     <session-uuid>/subagents/agent-<id>.jsonl     one per subagent run
//     <session-uuid>/subagents/agent-<id>.meta.json its agentType, description and spawning toolUseId
//     <session-uuid>/tool-results/                  large tool outputs, not walked here
//
// The directory-name mapping is verified on POSIX only. On Windows the separator is different and this
// has not been checked against a real install, so a wrong root returns "no transcripts" rather than
// wrong numbers — which is the safe direction, and why every consumer says so when it finds nothing.
//
// ── NOTHING HERE THROWS ────────────────────────────────────────────────────────
//
// A live session is being appended to while this reads it, so a truncated final line is normal rather
// than exceptional. Bad lines are skipped, missing directories return empty. A reporting tool that
// crashes on a half-written byte is a reporting tool nobody runs twice.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const transcriptRoot = (cwd = process.cwd(), home = homedir()) =>
  join(home, '.claude', 'projects', cwd.replace(/[/\\]/g, '-'))

export const readLines = function* (path) {
  let text

  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue

    try {
      yield JSON.parse(line)
    } catch {
      /* a partially-written final line is normal on a live session */
    }
  }
}

export const blocksOf = entry => {
  const content = entry?.message?.content

  return Array.isArray(content) ? content.filter(block => block && typeof block === 'object') : []
}

const isDirectory = path => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export const mainTranscripts = root =>
  existsSync(root)
    ? readdirSync(root)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => ({ session: name.replace(/\.jsonl$/, ''), path: join(root, name) }))
    : []

export const subagentTranscripts = root => {
  if (!existsSync(root)) return []

  const out = []

  for (const entry of readdirSync(root)) {
    const dir = join(root, entry, 'subagents')

    if (!isDirectory(dir)) continue

    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue

      out.push({
        session: entry,
        name,
        agentId: /^agent-(.+)\.jsonl$/.exec(name)?.[1] ?? null,
        path: join(dir, name),
        metaPath: join(dir, name.replace(/\.jsonl$/, '.meta.json'))
      })
    }
  }

  return out
}

// ── Resolving an agent's type ──────────────────────────────────────────────────
//
// MEASURE BEFORE BUILDING THE CLEVER THING. The type can be recovered by joining two entries in the
// MAIN transcript — the `subagent_type` sits on the Agent tool_use, the agentId that names the
// subagent file sits on the tool RESULT, and `tool_use_id` connects them. That join is real, it works,
// and it is what the harness this was extracted from does for every run.
//
// It is also almost always unnecessary. Every subagent file has a `.meta.json` sibling stating
// `agentType` outright — 178 of 178 across every project on the machine where this was written. So the
// sibling is the primary path and the join is the fallback, not the other way round.
//
// The fallback is kept rather than deleted because its absence is SILENT: a transcript written by an
// older build would resolve to no type at all, `runsOfType` would match nothing, and a report covering
// zero runs looks exactly like a report covering clean ones. For the same reason `resolveTypes`
// returns the unresolved count, so a consumer can say "3 runs could not be typed" instead of implying
// there were none.

const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export const typeFromMeta = run => readJson(run.metaPath)?.agentType ?? null

// agentId -> subagent_type, via the two-pass tool_use_id join. The fallback described above.
export const typesFromMainThread = root => {
  const byToolUseId = new Map()
  const byAgentId = new Map()

  for (const { path } of mainTranscripts(root)) {
    for (const entry of readLines(path)) {
      for (const block of blocksOf(entry)) {
        if (block.type === 'tool_use' && block.input?.subagent_type) byToolUseId.set(block.id, block.input.subagent_type)

        if (block.type === 'tool_result' && entry.toolUseResult?.agentId) {
          const type = byToolUseId.get(block.tool_use_id)

          if (type) byAgentId.set(entry.toolUseResult.agentId, type)
        }
      }
    }
  }

  return byAgentId
}

export const resolveTypes = root => {
  const runs = subagentTranscripts(root)
  const fromMeta = runs.map(run => ({ ...run, type: typeFromMeta(run) }))

  if (fromMeta.every(run => run.type)) return { runs: fromMeta, unresolved: 0 }

  const joined = typesFromMainThread(root)
  const resolved = fromMeta.map(run => ({ ...run, type: run.type ?? joined.get(run.agentId) ?? null }))

  return { runs: resolved, unresolved: resolved.filter(run => !run.type).length }
}

export const runsOfType = (root, wanted) => resolveTypes(root).runs.filter(run => run.type === wanted)

// ── Tool calls ─────────────────────────────────────────────────────────────────
//
// A `tool_use` block is an ATTEMPT, NOT AN EVENT. This distinction is the whole reason this function
// exists rather than callers filtering blocks themselves, and getting it wrong produces confident false
// findings: in the system this came from, six writes into source looked like an agent editing code it
// was forbidden to touch, until the tool RESULTS showed three of them denied by a guard. Three of those
// six were the guard working correctly, being reported as a breach.
//
// So every call carries `ok`, joined from its result. `ok === null` means no result was recorded —
// which is neither success nor failure, and must not be read as either.
export const toolCalls = path => {
  const entries = [...readLines(path)]
  const calls = new Map()

  for (const entry of entries) {
    for (const block of blocksOf(entry)) {
      if (block.type !== 'tool_use') continue

      calls.set(block.id, { id: block.id, name: block.name, input: block.input ?? {}, at: entry.timestamp ?? '', result: null, ok: null })
    }
  }

  for (const entry of entries) {
    for (const block of blocksOf(entry)) {
      if (block.type !== 'tool_result') continue

      const call = calls.get(block.tool_use_id)

      if (!call) continue

      const content = Array.isArray(block.content)
        ? block.content.map(inner => (typeof inner?.text === 'string' ? inner.text : '')).join('\n')
        : block.content

      call.result = typeof content === 'string' ? content : JSON.stringify(content ?? '')

      // `is_error` is authoritative when present. The text patterns catch a denial delivered as an
      // ordinary result, which is how PreToolUse `deny` arrives.
      call.ok = !(block.is_error === true || /permission.*denie|\bmay only write to\b|^Blocked:/im.test(call.result))
    }
  }

  return [...calls.values()]
}

// The agent's last substantive text block — its report. It is delivered in chat and never written to a
// file, so the transcript is the only place it exists.
export const finalReport = path => {
  let last = ''

  for (const entry of readLines(path)) {
    if (entry?.message?.role !== 'assistant') continue

    for (const block of blocksOf(entry)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) last = block.text
    }
  }

  return last
}

// ── Usage, deduplicated ────────────────────────────────────────────────────────
//
// THE BUG THAT MAKES A NAIVE READER WRONG BY ~2.5x.
//
// One API request writes MULTIPLE transcript lines — one per content block: thinking, then text, then
// each tool_use — and EVERY one of those lines repeats the SAME `usage` object. Summing usage per line
// therefore counts one request as many.
//
// Measured on this repository's own transcript while writing this file: 105 assistant entries carrying
// 41 distinct requestIds. A per-line sum reports 2.6x the true spend. That is not a rounding error —
// it is a confident number wrong by more than the decisions it would inform.
//
// Dedup is by `requestId`. An entry without one is kept and counted separately rather than dropped: it
// is either a format change or a shape this has not seen, and silently discarding usage is the same
// class of failure as silently multiplying it.
export const requestUsage = path => {
  const seen = new Map()
  const untagged = []

  for (const entry of readLines(path)) {
    const usage = entry?.message?.usage

    if (!usage || entry?.message?.role !== 'assistant') continue

    const record = { requestId: entry.requestId ?? null, model: entry.message.model ?? null, at: entry.timestamp ?? '', usage }

    if (!record.requestId) {
      untagged.push(record)
      continue
    }

    if (!seen.has(record.requestId)) seen.set(record.requestId, record)
  }

  return { requests: [...seen.values()], untagged }
}

// ── CLI ────────────────────────────────────────────────────────────────────────
//
// Enough to answer "is this reader finding anything at all", which is the first question when a report
// comes back empty.
if (process.argv[1]?.endsWith('transcripts.mjs')) {
  const root = transcriptRoot()
  const { runs, unresolved } = resolveTypes(root)
  const byType = new Map()

  for (const run of runs) byType.set(run.type ?? '(unresolved)', (byType.get(run.type ?? '(unresolved)') ?? 0) + 1)

  console.log(`  root: ${root}`)
  console.log(`  ${existsSync(root) ? 'exists' : 'DOES NOT EXIST — no transcripts for this project'}`)
  console.log(`  main transcripts: ${mainTranscripts(root).length}`)
  console.log(`  subagent runs: ${runs.length}${unresolved ? ` (${unresolved} could not be typed)` : ''}`)

  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${count}x  ${type}`)
}
