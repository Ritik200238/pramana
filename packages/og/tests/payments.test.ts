import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NEURON_PER_OG,
  PAYMENT_LAYER,
  estimateCostNeuron,
  estimateDaysRemaining,
  formatOg,
  isInsufficientBalance,
  parseOg,
  readBalance,
} from '../src/payments.ts'

test('the payment layer addresses match the 0G docs', () => {
  assert.equal(PAYMENT_LAYER.testnet, '0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939')
  assert.equal(PAYMENT_LAYER.mainnet, '0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32')
})

test('balance arithmetic is integer-only', () => {
  // A balance is money. Floating point has no business near it, and bigint
  // makes that structural rather than a convention someone can forget.
  assert.equal(NEURON_PER_OG, 10n ** 18n)
  assert.equal(typeof parseOg('1.5'), 'bigint')
})

test('og formatting round-trips', () => {
  for (const value of ['0', '1', '0.5', '12.345678', '1000']) {
    assert.equal(formatOg(parseOg(value)), value, `round trip failed for ${value}`)
  }
})

test('a whole number formats without a decimal point', () => {
  assert.equal(formatOg(NEURON_PER_OG * 3n), '3')
})

test('trailing zeros are trimmed', () => {
  assert.equal(formatOg(parseOg('1.500000')), '1.5')
})

test('sub-precision dust does not render as a false balance', () => {
  // One neuron is far below display precision. Showing "0.000000" would be
  // misleading; showing "0" is honest.
  assert.equal(formatOg(1n), '0')
})

test('cost follows the Router formula exactly', () => {
  // total = input x prompt_price + output x completion_price, no markup.
  const cost = estimateCostNeuron({
    promptTokens: 1000,
    completionTokens: 200,
    promptPriceNeuron: 100n,
    completionPriceNeuron: 500n,
  })
  assert.equal(cost, 1000n * 100n + 200n * 500n)
})

test('cost never goes negative on malformed token counts', () => {
  const cost = estimateCostNeuron({
    promptTokens: -50,
    completionTokens: -10,
    promptPriceNeuron: 100n,
    completionPriceNeuron: 500n,
  })
  assert.equal(cost, 0n)
})

test('runway is null when there is nothing to extrapolate from', () => {
  // Guessing a runway is worse than admitting we cannot compute one.
  assert.equal(estimateDaysRemaining(1000n, 0n), null)
  assert.equal(estimateDaysRemaining(1000n, -5n), null)
})

test('runway divides balance by observed daily burn', () => {
  // 700 spent over 7 days = 100/day. 1000 balance = 10 days.
  assert.equal(estimateDaysRemaining(1000n, 700n), 10)
})

test('a 402 is recognised as an exhausted balance', () => {
  const error = Object.assign(new Error('insufficient_balance'), { status: 402 })
  assert.equal(isInsufficientBalance(error), true)
})

test('other errors are not mistaken for an empty balance', () => {
  for (const status of [400, 401, 429, 500]) {
    const error = Object.assign(new Error('nope'), { status })
    assert.equal(isInsufficientBalance(error), false, `status ${status} misread`)
  }
  assert.equal(isInsufficientBalance(new Error('plain')), false)
})

test('reading a balance refuses an inference key', async () => {
  // sk- keys deliberately cannot reach /v1/account/*, so a leaked inference key
  // cannot be used to inspect an account. Failing loudly here beats a confusing
  // 401 from the network.
  await assert.rejects(
    () => readBalance('sk-not-a-management-key'),
    /management key/i,
  )
})
