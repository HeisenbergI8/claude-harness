#!/usr/bin/env node
// What this harness costs to run, read from the session transcripts.
//
//   node .claude/harness/cost.mjs            a table
//   node .claude/harness/cost.mjs --json     the same numbers, machine-readable
//   node .claude/harness/cost.mjs --verbose  per-session detail
//
// ── WHY THIS IS A COMMAND AND NOT A GATE ───────────────────────────────────────
//
// Cost is a question you ask occasionally, not a decision you make every turn. It is also not
// available to a hook at all: the payload carries session_id, transcript_path, cwd, prompt_id,
// permission_mode, hook_event_name and stop_hook_active — and no usage of any kind. The numbers exist
// only in the transcript JSONL, so cost accounting has to be a reader. That is the right shape anyway.
//
// ── WHAT IT IS FOR ─────────────────────────────────────────────────────────────
//
// Every gate here has a cost and none of them has ever had to justify it. A gate that fires on every
// turn, replays a subagent's context, or re-runs a verify command is spending real money to protect
// something — and "is that trade worth it" is unanswerable without a number. This is that number.
//
// ── WHAT IT CANNOT SEE ─────────────────────────────────────────────────────────
//
// - Anything outside this project's transcript directory.
// - Wall-clock. Time is in the ledger, tokens are here, and the two are NOT joined: the ledger has no
//   requestId and the transcript has no prompt_id, so a join would have to go through two clocks. A
//   guess presented as a measurement is worse than an absent column.
// - Whether the prices below are still current. See PRICING.

import { existsSync } from 'node:fs'

import { mainTranscripts, requestUsage, resolveTypes, subagentTranscripts, transcriptRoot } from './transcripts.mjs'

// ── PRICING ────────────────────────────────────────────────────────────────────
//
// Dollars per million tokens. SOURCED, NOT REMEMBERED — taken from the `claude-api` skill's model
// table on 2026-08-15; that table carries its own cache date of 2026-06-24. Model pricing is exactly
// the kind of fact that a half-remembered number would sail through unchallenged, and a hardcoded
// table in a script is exactly where it would sit.
//
// RE-CHECK BEFORE QUOTING A NUMBER THAT MATTERS. A price that moved upstream produces a wrong answer
// here silently, and nothing in this file can detect that.
//
// Cache multipliers apply to the INPUT rate: reads 0.1x, 5-minute writes 1.25x, 1-hour writes 2x. The
// two write TTLs are priced separately on purpose — collapsing them understates any session using the
// 1-hour TTL by a factor of 1.6 on every cached byte.
export const PRICING_TAKEN_AT = '2026-08-15'

export const PRICING = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  // Sonnet 5 carries an introductory rate of $2/$10 through 2026-08-31. The STANDARD rate is used
  // here, so a Sonnet 5 figure covering that window is an OVERSTATEMENT of up to a third rather than
  // a quiet understatement. Erring high is the safe direction for a number used to justify cutting
  // something.
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 }
}

// Fast mode runs the same model at premium rates, and `usage.speed` says which was served.
export const FAST_PRICING = {
  'claude-opus-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 10, output: 50 }
}

const CACHE_READ = 0.1
const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2

// `claude-opus-5[1m]` and `claude-opus-5` are the same rate card; the suffix is a context variant.
export const normaliseModel = model => String(model ?? '').replace(/\[.*\]$/, '').trim()

export const rateFor = (model, speed) => {
  const id = normaliseModel(model)

  if (speed === 'fast' && FAST_PRICING[id]) return FAST_PRICING[id]

  return PRICING[id] ?? null
}

// ── The sum ────────────────────────────────────────────────────────────────────
//
// Pure, and exported, so the arithmetic is tested without a transcript on disk.
//
// AN UNPRICED MODEL IS COUNTED, NEVER ZEROED. A model missing from the table above is a table that
// needs updating, and silently pricing its tokens at nothing turns that into a smaller bill. The
// tokens are still tallied and the model is named in the report.
export const priceRequests = requests => {
  const totals = {
    requests: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    cost: 0,
    unpriced: new Map()
  }

  for (const record of requests) {
    const usage = record.usage ?? {}
    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0

    // The per-TTL split is the accurate source. `cache_creation_input_tokens` is the older flat total;
    // when only that is present it is charged at the 5-minute rate, which is the CHEAPER of the two —
    // so this path understates rather than inventing a premium nobody paid.
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? (usage.cache_creation ? 0 : usage.cache_creation_input_tokens ?? 0)

    totals.requests += 1
    totals.input += input
    totals.output += output
    totals.cacheRead += cacheRead
    totals.cacheWrite5m += write5m
    totals.cacheWrite1h += write1h

    const rate = rateFor(record.model, usage.speed)

    if (!rate) {
      const id = normaliseModel(record.model) || '(no model recorded)'
      const seen = totals.unpriced.get(id) ?? { requests: 0, tokens: 0 }

      totals.unpriced.set(id, {
        requests: seen.requests + 1,
        tokens: seen.tokens + input + output + cacheRead + write5m + write1h
      })
      continue
    }

    totals.cost +=
      ((input + cacheRead * CACHE_READ + write5m * CACHE_WRITE_5M + write1h * CACHE_WRITE_1H) * rate.input +
        output * rate.output) /
      1_000_000
  }

  return totals
}

const add = (into, from) => {
  into.requests += from.requests
  into.input += from.input
  into.cacheRead += from.cacheRead
  into.cacheWrite5m += from.cacheWrite5m
  into.cacheWrite1h += from.cacheWrite1h
  into.output += from.output
  into.cost += from.cost

  for (const [model, seen] of from.unpriced) {
    const current = into.unpriced.get(model) ?? { requests: 0, tokens: 0 }

    into.unpriced.set(model, { requests: current.requests + seen.requests, tokens: current.tokens + seen.tokens })
  }

  return into
}

const empty = () => priceRequests([])

// ── Collection ─────────────────────────────────────────────────────────────────

export const collect = (root = transcriptRoot()) => {
  const main = empty()
  const byAgent = new Map()
  const sessions = []
  let untagged = 0

  for (const { session, path } of mainTranscripts(root)) {
    const { requests, untagged: loose } = requestUsage(path)
    const priced = priceRequests(requests)

    untagged += loose.length
    sessions.push({ session, kind: 'main', ...priced })
    add(main, priced)
  }

  const { runs, unresolved } = resolveTypes(root)
  const byPath = new Map(runs.map(run => [run.path, run]))

  for (const run of subagentTranscripts(root)) {
    const { requests, untagged: loose } = requestUsage(run.path)
    const priced = priceRequests(requests)
    const type = byPath.get(run.path)?.type ?? '(untyped)'

    untagged += loose.length
    sessions.push({ session: run.session, kind: type, ...priced })
    add(byAgent.get(type) ?? byAgent.set(type, empty()).get(type), priced)
  }

  const total = add(empty(), main)

  for (const priced of byAgent.values()) add(total, priced)

  return { root, main, byAgent, sessions, total, untagged, unresolved }
}

// ── Report ─────────────────────────────────────────────────────────────────────

const thousands = value => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value))
const dollars = value => `$${value.toFixed(value < 1 ? 4 : 2)}`

const line = (label, totals) =>
  `  ${label.padEnd(18)} ${String(totals.requests).padStart(6)}  ${thousands(totals.input).padStart(7)}  ` +
  `${thousands(totals.cacheRead).padStart(8)}  ${thousands(totals.cacheWrite5m + totals.cacheWrite1h).padStart(8)}  ` +
  `${thousands(totals.output).padStart(7)}  ${dollars(totals.cost).padStart(10)}`

if (process.argv[1]?.endsWith('cost.mjs')) {
  const root = transcriptRoot()

  if (!existsSync(root)) {
    console.log(`- cost: no transcripts for this project yet (${root})`)
    process.exit(0)
  }

  const report = collect(root)

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          pricingTakenAt: PRICING_TAKEN_AT,
          total: { ...report.total, unpriced: Object.fromEntries(report.total.unpriced) },
          byAgent: Object.fromEntries([...report.byAgent].map(([type, totals]) => [type, { ...totals, unpriced: Object.fromEntries(totals.unpriced) }])),
          untaggedRequests: report.untagged,
          unresolvedAgents: report.unresolved
        },
        null,
        2
      )
    )
    process.exit(0)
  }

  if (report.total.requests === 0) {
    console.log('- cost: transcripts found, but no usage recorded in them yet')
    process.exit(0)
  }

  console.log(`\ncost — ${report.sessions.length} transcript(s), prices as of ${PRICING_TAKEN_AT}\n`)
  console.log(`  ${'where'.padEnd(18)} ${'reqs'.padStart(6)}  ${'input'.padStart(7)}  ${'cache rd'.padStart(8)}  ${'cache wr'.padStart(8)}  ${'output'.padStart(7)}  ${'cost'.padStart(10)}`)
  console.log(line('main thread', report.main))

  for (const [type, totals] of [...report.byAgent.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(line(type, totals))
  }

  console.log(`  ${'-'.repeat(70)}`)
  console.log(line('TOTAL', report.total))

  if (process.argv.includes('--verbose')) {
    console.log('\nPER TRANSCRIPT')
    for (const entry of report.sessions.filter(row => row.requests > 0).sort((a, b) => b.cost - a.cost)) {
      console.log(line(`${entry.kind}/${entry.session.slice(0, 8)}`, entry))
    }
  }

  if (report.total.unpriced.size > 0) {
    console.log('\nNOT PRICED — these tokens are counted above but contribute $0 to the cost column:')
    for (const [model, seen] of report.total.unpriced) {
      console.log(`  ${model}: ${seen.requests} request(s), ${thousands(seen.tokens)} tokens — add it to PRICING in cost.mjs`)
    }
  }

  if (report.untagged > 0) console.log(`\n  ${report.untagged} usage record(s) carried no requestId and could not be deduplicated — see requestUsage().`)
  if (report.unresolved > 0) console.log(`  ${report.unresolved} subagent run(s) could not be typed and are grouped under (untyped).`)

  console.log(
    '\nHOW TO READ THIS:\n' +
      '  Cache reads bill at 0.1x the input rate, 5-minute writes at 1.25x, 1-hour writes at 2x.\n' +
      '  One request writes many transcript lines; these are deduplicated by requestId. Without that\n' +
      '  the figure would be roughly 2.5x too high.\n' +
      `  Prices are a dated snapshot (${PRICING_TAKEN_AT}), not a live lookup. Re-check before quoting one.\n`
  )
}
