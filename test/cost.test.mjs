// Cost accounting is arithmetic over a rate card, and every way it can be quietly wrong is a way to
// under-report spend. These pin the four that matter: the cache multipliers, the two write TTLs being
// priced separately, model-id normalisation, and — the important one — a model missing from the table
// being COUNTED rather than priced at zero.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { PRICING, normaliseModel, priceRequests, rateFor } from '../template/.claude/harness/cost.mjs'

const request = (usage, model = 'claude-opus-5') => ({ requestId: 'r', model, usage })

test('input and output bill at the model rate', () => {
  const totals = priceRequests([request({ input_tokens: 1_000_000, output_tokens: 1_000_000 })])

  // $5/MTok in, $25/MTok out.
  assert.equal(totals.cost, 30)
})

test('cache reads bill at a tenth of the input rate', () => {
  const totals = priceRequests([request({ cache_read_input_tokens: 1_000_000 })])

  assert.equal(totals.cost, 0.5)
})

// THE TWO WRITE TTLs ARE PRICED SEPARATELY, and this is the case that catches a collapse of the two:
// a 1-hour write costs 1.6x what a 5-minute one does, so pricing both at 5m understates every cached
// byte in a session using the long TTL.
test('a 1-hour cache write costs 2x input and a 5-minute one 1.25x', () => {
  const oneHour = priceRequests([request({ cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 } })])
  const fiveMin = priceRequests([request({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1_000_000 } })])

  assert.equal(oneHour.cost, 10)
  assert.equal(fiveMin.cost, 6.25)
  assert.notEqual(oneHour.cost, fiveMin.cost, 'collapsing the two TTLs understates any 1-hour session')
})

test('the whole rate card composes on one request', () => {
  const totals = priceRequests([
    request({
      input_tokens: 1000,
      output_tokens: 1000,
      cache_read_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 1_000_000 }
    })
  ])

  assert.equal(Number(totals.cost.toFixed(4)), 16.78)
  assert.equal(totals.requests, 1)
  assert.equal(totals.cacheWrite1h, 1_000_000)
  assert.equal(totals.cacheWrite5m, 1_000_000)
})

// The older flat field, for a transcript that predates the per-TTL split. Charging it at the CHEAPER
// rate means this path can only ever understate — it never invents a premium nobody paid.
test('a flat cache_creation_input_tokens falls back to the 5-minute rate', () => {
  const totals = priceRequests([request({ cache_creation_input_tokens: 1_000_000 })])

  assert.equal(totals.cost, 6.25)
  assert.equal(totals.cacheWrite5m, 1_000_000)
})

test('the per-TTL split wins over the flat field when both are present', () => {
  const totals = priceRequests([
    request({ cache_creation_input_tokens: 999_999_999, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 } })
  ])

  assert.equal(totals.cacheWrite5m, 1_000_000, 'the flat field must not be added on top of the split')
})

// ── The rule that keeps the number honest ──────────────────────────────────────

test('an unknown model is counted and named, never priced at zero', () => {
  const totals = priceRequests([request({ input_tokens: 500, output_tokens: 250 }, 'claude-not-a-real-model')])

  assert.equal(totals.cost, 0)
  assert.equal(totals.requests, 1)
  assert.equal(totals.input, 500, 'the tokens are still tallied')
  assert.deepEqual(totals.unpriced.get('claude-not-a-real-model'), { requests: 1, tokens: 750 })
})

test('a record with no model at all is reported under a readable name', () => {
  const totals = priceRequests([request({ input_tokens: 10 }, null)])

  assert.equal(totals.unpriced.get('(no model recorded)').requests, 1)
})

// ── Rate lookup ────────────────────────────────────────────────────────────────

test('a context-window suffix is not a different rate card', () => {
  assert.equal(normaliseModel('claude-opus-5[1m]'), 'claude-opus-5')
  assert.deepEqual(rateFor('claude-opus-5[1m]'), PRICING['claude-opus-5'])
})

test('fast mode is priced as fast mode', () => {
  const standard = priceRequests([request({ output_tokens: 1_000_000, speed: 'standard' })])
  const fast = priceRequests([request({ output_tokens: 1_000_000, speed: 'fast' })])

  assert.equal(standard.cost, 25)
  assert.equal(fast.cost, 50)
})

test('fast mode on a model with no fast rate falls back to the standard card', () => {
  assert.deepEqual(rateFor('claude-haiku-4-5', 'fast'), PRICING['claude-haiku-4-5'])
})

test('an empty set of requests is zero, not a crash', () => {
  const totals = priceRequests([])

  assert.equal(totals.cost, 0)
  assert.equal(totals.requests, 0)
  assert.equal(totals.unpriced.size, 0)
})
