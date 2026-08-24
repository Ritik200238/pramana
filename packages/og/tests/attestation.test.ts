/**
 * Attestation receipts.
 *
 * This is the file that decides whether "we cannot read your health data" is a
 * checkable claim or a marketing sentence. Everything else in this package
 * could be pointed at another provider; this could not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeReceipt,
  isProvable,
  isTrustworthy,
  readReceipt,
  type AttestationReceipt,
} from '../src/attestation.ts'

function routerResponse(trace: unknown): unknown {
  return {
    id: 'chatcmpl-1',
    choices: [{ message: { content: 'ok' } }],
    x_0g_trace: trace,
  }
}

test('a verified response yields a provable receipt', () => {
  const receipt = readReceipt(
    routerResponse({
      request_id: '0852f405-6c56-40c2-a800-e6fd70785065',
      provider: '0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C',
      tee_verified: true,
    }),
    'qwen3-vl-30b',
  )

  assert.equal(receipt.status, 'verified')
  assert.equal(receipt.provider, '0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C')
  assert.equal(receipt.requestId, '0852f405-6c56-40c2-a800-e6fd70785065')
  assert.equal(receipt.model, 'qwen3-vl-30b')
  assert.ok(isProvable(receipt))
  assert.ok(isTrustworthy(receipt))
})

test('a failed signature is untrustworthy, not merely unproven', () => {
  // tee_verified: false means a signature was present and did NOT verify. We do
  // not know what produced that output, so it must never reach a user as health
  // guidance.
  const receipt = readReceipt(routerResponse({ tee_verified: false }), 'qwen3-vl-30b')

  assert.equal(receipt.status, 'failed')
  assert.equal(isTrustworthy(receipt), false)
  assert.equal(isProvable(receipt), false)
})

test('absent verification is honest, not silently treated as success', () => {
  const receipt = readReceipt(routerResponse({ request_id: 'x' }), 'qwen3-vl-30b')

  assert.equal(receipt.status, 'unrequested')
  assert.equal(isProvable(receipt), false, 'unrequested is not evidence')
  assert.equal(isTrustworthy(receipt), true, 'but it is not a failure either')
})

test('a null verdict is unrequested, not verified', () => {
  const receipt = readReceipt(routerResponse({ tee_verified: null }), 'qwen3-vl-30b')
  assert.equal(receipt.status, 'unrequested')
})

test('a response with no trace block is recorded as unavailable', () => {
  const receipt = readReceipt({ choices: [] }, 'qwen3-vl-30b')
  assert.equal(receipt.status, 'unavailable')
  assert.equal(isProvable(receipt), false)
})

test('a malformed trace does not throw and does not claim verification', () => {
  const receipt = readReceipt(routerResponse({ tee_verified: 'yes please' }), 'qwen3-vl-30b')
  assert.equal(receipt.status, 'unavailable')
  assert.equal(isProvable(receipt), false)
})

test('junk input never produces a provable receipt', () => {
  for (const junk of [null, undefined, 'string', 42, []]) {
    const receipt = readReceipt(junk, 'm')
    assert.equal(isProvable(receipt), false, `claimed proof from ${JSON.stringify(junk)}`)
  }
})

test('every receipt carries the model that produced it', () => {
  const receipt = readReceipt(routerResponse({ tee_verified: true }), 'qwen3.7-plus')
  assert.equal(receipt.model, 'qwen3.7-plus')
})

test('a receipt is timestamped so it can be reconciled later', () => {
  const receipt = readReceipt(routerResponse({ tee_verified: true }), 'm')
  assert.ok(!Number.isNaN(Date.parse(receipt.verifiedAt)))
})

test('the human description tells the truth for each state', () => {
  const states: Array<[AttestationReceipt['status'], RegExp]> = [
    ['verified', /sealed enclave/i],
    ['failed', /could not be verified/i],
    ['unavailable', /did not return a result/i],
    ['unrequested', /not requested/i],
  ]

  for (const [status, pattern] of states) {
    const text = describeReceipt({
      status,
      provider: '0xabcdef0123456789',
      requestId: 'r',
      model: 'm',
      verifiedAt: new Date().toISOString(),
    })
    assert.match(text, pattern, `wrong description for ${status}`)
  }
})

test('the verified description does not overclaim', () => {
  const text = describeReceipt({
    status: 'verified',
    provider: '0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C',
    requestId: 'r',
    model: 'm',
    verifiedAt: new Date().toISOString(),
  })

  // It may say the enclave was sealed. It must not claim anything about what
  // the model concluded, or promise the advice is correct.
  assert.doesNotMatch(text, /accurate|correct|safe to follow|medical/i)
})

test('the router sends verify_tee by default and treats failure as failover', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'router.ts'), 'utf8')

  assert.match(source, /verify_tee:\s*true/, 'verification must be requested')
  assert.match(source, /opts\.verifyTee !== false/, 'and must be the default')
  assert.match(
    source,
    /attestation\.status === 'failed'[\s\S]{0,200}continue/,
    'an unverifiable response must fail over rather than be returned',
  )
})
