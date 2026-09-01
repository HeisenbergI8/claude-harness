// The transcript reader is the substrate for cost accounting and agent grading, so the two facts that
// are expensive to rediscover are pinned here: a tool_use block is an ATTEMPT rather than an event,
// and one API request writes many transcript lines that all repeat the same usage object.
//
// Both are proven by injection in the sense the README describes: remove the `ok` join and
// "a blocked write counts as a write" goes green; remove the requestId dedup and the token count
// triples. Each has a test below that fails in exactly that case.

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import {
  blocksOf,
  finalReport,
  mainTranscripts,
  requestUsage,
  resolveTypes,
  runsOfType,
  subagentTranscripts,
  toolCalls,
  transcriptRoot
} from '../template/.claude/harness/transcripts.mjs'

const jsonl = entries => `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`

const assistant = (content, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content }, ...extra })
const user = content => ({ type: 'user', message: { role: 'user', content } })

// A fake ~/.claude/projects tree: one main transcript, one subagent with a meta sibling.
const makeTree = ({ main = [], subagents = {} } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'provenly-transcripts-'))
  const cwd = '/Users/someone/project'
  const root = transcriptRoot(cwd, home)

  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'session-a.jsonl'), jsonl(main))

  for (const [name, { entries, meta }] of Object.entries(subagents)) {
    const dir = join(root, 'session-a', 'subagents')

    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.jsonl`), jsonl(entries))
    if (meta) writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify(meta))
  }

  return { home, cwd, root, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('the project root is the working directory with separators replaced', () => {
  assert.equal(transcriptRoot('/Users/x/y', '/home'), '/home/.claude/projects/-Users-x-y')
})

test('a truncated final line is skipped, not thrown on', () => {
  const tree = makeTree({ main: [assistant([{ type: 'text', text: 'done' }])] })

  writeFileSync(join(tree.root, 'session-a.jsonl'), `${JSON.stringify(assistant([{ type: 'text', text: 'done' }]))}\n{"partial":`)

  assert.equal(finalReport(join(tree.root, 'session-a.jsonl')), 'done')
  tree.cleanup()
})

test('a missing root reads as empty rather than throwing', () => {
  assert.deepEqual(mainTranscripts('/nowhere/at/all'), [])
  assert.deepEqual(subagentTranscripts('/nowhere/at/all'), [])
})

test('blocksOf tolerates a string content body', () => {
  assert.deepEqual(blocksOf({ message: { content: 'plain text' } }), [])
})

// ── The attempt-versus-event distinction ───────────────────────────────────────

test('a denied tool call is recorded as an attempt that did NOT succeed', () => {
  const tree = makeTree({
    main: [
      assistant([{ type: 'tool_use', id: 'a', name: 'Write', input: { file_path: 'src/x.ts' } }]),
      user([{ type: 'tool_result', tool_use_id: 'a', content: 'The tester agent may only write to: tests/**' }])
    ]
  })

  const [call] = toolCalls(join(tree.root, 'session-a.jsonl'))

  assert.equal(call.name, 'Write')
  assert.equal(call.ok, false, 'a guard denial must not read as a successful write')
  tree.cleanup()
})

test('is_error on the result marks the call failed', () => {
  const tree = makeTree({
    main: [
      assistant([{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'false' } }]),
      user([{ type: 'tool_result', tool_use_id: 'a', content: 'boom', is_error: true }])
    ]
  })

  assert.equal(toolCalls(join(tree.root, 'session-a.jsonl'))[0].ok, false)
  tree.cleanup()
})

test('an ordinary result is a success, and a call with no result is neither', () => {
  const tree = makeTree({
    main: [
      assistant([
        { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm run lint' } }
      ]),
      user([{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'ok' }] }])
    ]
  })

  const calls = toolCalls(join(tree.root, 'session-a.jsonl'))

  assert.equal(calls.find(call => call.id === 'a').ok, true)
  assert.equal(calls.find(call => call.id === 'b').ok, null, 'no result recorded is not the same as failure')
  tree.cleanup()
})

// ── Agent types ────────────────────────────────────────────────────────────────

test('the agent type comes from the meta sibling', () => {
  const tree = makeTree({
    main: [],
    subagents: { 'agent-1': { entries: [assistant([{ type: 'text', text: 'report' }])], meta: { agentType: 'tester' } } }
  })

  assert.deepEqual(runsOfType(tree.root, 'tester').map(run => run.agentId), ['1'])
  assert.equal(resolveTypes(tree.root).unresolved, 0)
  tree.cleanup()
})

test('with no meta sibling the type is joined from the main thread via tool_use_id', () => {
  const tree = makeTree({
    main: [
      assistant([{ type: 'tool_use', id: 'tu-1', name: 'Agent', input: { subagent_type: 'auditor' } }]),
      { ...user([{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }]), toolUseResult: { agentId: '9' } }
    ],
    subagents: { 'agent-9': { entries: [assistant([{ type: 'text', text: 'report' }])] } }
  })

  assert.deepEqual(runsOfType(tree.root, 'auditor').map(run => run.agentId), ['9'])
  tree.cleanup()
})

test('a run that can be typed by neither route is REPORTED, not silently dropped', () => {
  const tree = makeTree({
    main: [],
    subagents: { 'agent-7': { entries: [assistant([{ type: 'text', text: 'report' }])] } }
  })

  const { runs, unresolved } = resolveTypes(tree.root)

  assert.equal(runs.length, 1)
  assert.equal(unresolved, 1, 'an untypeable run must be counted so a consumer can say so')
  tree.cleanup()
})

// ── The final report ───────────────────────────────────────────────────────────

test('the final report is the LAST substantive assistant text', () => {
  const tree = makeTree({
    main: [
      assistant([{ type: 'text', text: 'first' }]),
      assistant([{ type: 'text', text: '   ' }]),
      assistant([{ type: 'text', text: 'the verdict' }]),
      user([{ type: 'text', text: 'a user message after it' }])
    ]
  })

  assert.equal(finalReport(join(tree.root, 'session-a.jsonl')), 'the verdict')
  tree.cleanup()
})

// ── The dedup that makes a naive reader wrong ──────────────────────────────────

test('usage repeated across the lines of ONE request is counted once', () => {
  const usage = { input_tokens: 100, output_tokens: 50 }
  const tree = makeTree({
    main: [
      assistant([{ type: 'thinking', thinking: '...' }], { requestId: 'req-1', message: { role: 'assistant', content: [], usage, model: 'claude-opus-5' } }),
      assistant([], { requestId: 'req-1', message: { role: 'assistant', content: [], usage, model: 'claude-opus-5' } }),
      assistant([], { requestId: 'req-1', message: { role: 'assistant', content: [], usage, model: 'claude-opus-5' } }),
      assistant([], { requestId: 'req-2', message: { role: 'assistant', content: [], usage, model: 'claude-opus-5' } })
    ]
  })

  const { requests } = requestUsage(join(tree.root, 'session-a.jsonl'))

  assert.equal(requests.length, 2, 'three lines of one request must not count as three requests')
  tree.cleanup()
})

test('a usage record with no requestId is kept aside rather than dropped', () => {
  const tree = makeTree({
    main: [assistant([], { message: { role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 1 } } })]
  })

  const { requests, untagged } = requestUsage(join(tree.root, 'session-a.jsonl'))

  assert.equal(requests.length, 0)
  assert.equal(untagged.length, 1, 'silently discarding usage is the same defect class as multiplying it')
  tree.cleanup()
})
