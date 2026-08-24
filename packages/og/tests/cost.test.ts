/**
 * What a request actually cost.
 *
 * The Router reports the exact charge with every response, in neuron, and the
 * documentation is direct about it: "you don't need to compute costs yourself —
 * the Router tells you exactly what was charged."
 *
 * We were computing it ourselves, from constants in the repository, and
 * throwing the reported figure away. Those constants had drifted: meal vision —
 * the highest-volume call in the product — was carried at 54% of its real rate,
 * the coach model at 42%, and speech as free when it is billed. Nothing failed.
 * Every cost figure the product produced was simply too small, including the one
 * the per-user daily ceiling was sized against.
 *
 * Source: 0G docs, Router → Chat Completions, "Response shape".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCostNeuron } from '../src/router.ts'
import { NEURON_PER_OG, formatCharge, formatOg } from '../src/payments.ts'

/** The exact block from the documentation. */
const DOCUMENTED = {
  x_0g_trace: {
    request_id: '0852f405-6c56-40c2-a800-e6fd70785065',
    provider: '0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C',
    billing: {
      input_cost: '19000000000000',
      output_cost: '1916800000000000',
      total_cost: '1935800000000000',
    },
  },
}

test('the documented billing block parses to the exact charge', () => {
  assert.equal(readCostNeuron(DOCUMENTED), 1_935_800_000_000_000n)
})

test('a sixteen-digit charge keeps every digit', () => {
  // The reason this is BigInt and stored as text. As a double, a figure this
  // size starts losing precision well before anybody notices a wrong bill.
  const exact = '9007199254740993' // Number.MAX_SAFE_INTEGER + 2
  const parsed = readCostNeuron({ x_0g_trace: { billing: { total_cost: exact } } })

  assert.equal(parsed?.toString(), exact)
  assert.notEqual(Number(exact).toString(), exact, 'a double would have lost this')
})

test('the charge converts to 0G at the documented scale', () => {
  const cost = readCostNeuron(DOCUMENTED)
  assert.ok(cost !== null)

  // 1e18 neuron = 1 0G.
  assert.equal(NEURON_PER_OG, 10n ** 18n)
  assert.equal(formatOg(cost), '0.001935')
})

test('a missing billing block is null, not zero', () => {
  // Zero would quietly understate spend and look like a free request. Null says
  // we do not know, which is the truth and is visible in the record.
  assert.equal(readCostNeuron({ x_0g_trace: { request_id: 'r' } }), null)
  assert.equal(readCostNeuron({}), null)
  assert.equal(readCostNeuron(null), null)
})

test('a malformed charge is rejected rather than coerced', () => {
  for (const value of ['', 'free', '12.5', '-100', '1e18']) {
    assert.equal(
      readCostNeuron({ x_0g_trace: { billing: { total_cost: value } } }),
      null,
      `"${value}" must not be read as a charge`,
    )
  }
})

test('costs accumulate exactly across many requests', () => {
  // A day of meals, summed. Floating point would drift; BigInt cannot.
  const one = readCostNeuron(DOCUMENTED)
  assert.ok(one !== null)

  let total = 0n
  for (let i = 0; i < 1000; i += 1) total += one

  assert.equal(total, 1_935_800_000_000_000n * 1000n)
  assert.equal(formatOg(total), '1.9358')
})

test('a real charge is never displayed as zero', () => {
  // One meal photo, at the live rate. At the six-decimal default this used to
  // render as "0" and tell somebody their usage was free.
  const oneVisionCall = 1_935_800_000n

  const shown = formatCharge(oneVisionCall)
  assert.notEqual(shown, '0', 'a charge that happened must not read as free')
  assert.match(shown, /^0\.0*[1-9]/)
})

test('a genuinely zero amount still shows as zero', () => {
  assert.equal(formatCharge(0n), '0')
  assert.equal(formatOg(0n), '0')
})

test('whole amounts are unaffected', () => {
  assert.equal(formatCharge(NEURON_PER_OG), '1')
  assert.equal(formatCharge(NEURON_PER_OG * 5n), '5')
})
