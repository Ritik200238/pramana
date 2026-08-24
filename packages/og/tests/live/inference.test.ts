/**
 * Live inference against the 0G Compute Router.
 *
 * This is the check that cannot be faked. Everything else in the suite proves
 * we handle an attestation receipt correctly when we are handed one; only this
 * proves the Router actually hands us one, from a real provider, for a real
 * request.
 *
 * That matters more here than it would in most products. The claim on the
 * sign-in screen — that a person's food photographs are processed inside
 * hardware-sealed enclaves — rests entirely on `verify_tee` returning a signed
 * trace. No hosted model API offers an equivalent, which is what makes 0G
 * genuinely load-bearing rather than a deployment target. If this test cannot
 * pass, that sentence should come off the screen.
 *
 * Requires a funded inference key. Create one at https://pc.0g.ai — connect a
 * wallet, deposit 0G, then issue an API key. It must be an inference key
 * (`sk-`); management keys (`mk-`) cannot call inference.
 *
 *   OG_ROUTER_API_KEY=sk-... npm run test:live -w @ogt/og
 *
 * Without a key every case below skips loudly rather than passing quietly. A
 * suite that goes green because it did nothing is worse than one that fails.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { complete, createClient } from '../../src/router.ts'
import { describeReceipt, isProvable, isTrustworthy } from '../../src/attestation.ts'
import { CHAINS } from '../../src/models.ts'

const KEY = process.env['OG_ROUTER_API_KEY']
const CONFIGURED = typeof KEY === 'string' && KEY.startsWith('sk-')

const skip = CONFIGURED
  ? false
  : 'no funded OG_ROUTER_API_KEY — see the header of this file'

/** A 1x1 PNG. Enough to prove the vision path accepts an image at all. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('a text task returns a TEE receipt from a real provider', { skip }, async () => {
  const client = createClient({ apiKey: KEY! })

  const started = Date.now()
  const result = await complete(client, {
    task: 'coach',
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    maxTokens: 16,
    // The default, stated explicitly because it is the point of the test.
    verifyTee: true,
  })
  const elapsed = Date.now() - started

  assert.ok(result.text.length > 0, 'the model must actually answer')

  console.log(`  model      ${result.model}`)
  console.log(`  failovers  ${result.failovers}`)
  console.log(`  latency    ${elapsed} ms`)
  console.log(`  tokens     ${result.usage.promptTokens}/${result.usage.completionTokens}`)
  console.log(`  ${describeReceipt(result.attestation)}`)

  // `unavailable` means the Router returned no trace at all. That is the
  // failure worth catching: the code would carry on, and the privacy claim
  // would be resting on nothing.
  assert.notEqual(
    result.attestation.status,
    'unavailable',
    'the Router returned no attestation trace — verify_tee is not being honoured',
  )
  assert.notEqual(result.attestation.status, 'unrequested', 'verify_tee was not sent')
  assert.equal(result.attestation.status, 'verified', 'the provider TEE signature must verify')

  assert.ok(isTrustworthy(result.attestation), 'a verified receipt must read as trustworthy')
  assert.ok(isProvable(result.attestation), 'a receipt without a provider proves nothing')
  assert.ok(result.attestation.provider, 'the receipt must name the provider that ran it')
  assert.ok(result.attestation.requestId, 'and carry a request id the user can quote')
})

test('the meal vision path accepts an image and attests', { skip }, async () => {
  const client = createClient({ apiKey: KEY! })

  const result = await complete(client, {
    task: 'mealVision',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with the single word: seen' },
          { type: 'image_url', image_url: { url: PIXEL } },
        ],
      },
    ],
    maxTokens: 16,
  })

  console.log(`  model ${result.model} — ${describeReceipt(result.attestation)}`)

  // Photographs are the most identifying thing this product handles. If the
  // vision chain ever answers without attestation, it must fail here.
  assert.equal(result.attestation.status, 'verified', 'meal photos must run attested')
  assert.ok(result.text.length > 0)
})

test('every chain has at least one model that answers today', { skip }, async () => {
  const client = createClient({ apiKey: KEY! })

  for (const task of Object.keys(CHAINS) as Array<keyof typeof CHAINS>) {
    // Whisper takes audio, not chat messages; it is exercised by the transcribe
    // path rather than here.
    if (task === 'speech') continue

    const result = await complete(client, {
      task,
      messages: [{ role: 'user', content: 'Reply with: ok' }],
      maxTokens: 8,
    })

    assert.ok(result.text.length > 0, `chain "${task}" produced nothing`)
    console.log(`  ${task}: ${result.model} (${result.failovers} failovers)`)
  }
})

test('a bad key fails fast instead of burning the whole chain', { skip }, async () => {
  const client = createClient({ apiKey: 'sk-definitely-not-a-real-key' })

  const started = Date.now()
  await assert.rejects(
    complete(client, {
      task: 'coach',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 8,
    }),
  )

  // A rejected key fails identically on every model, so trying all three would
  // cost three times the latency to learn the same thing.
  const elapsed = Date.now() - started
  console.log(`  rejected in ${elapsed} ms`)
})
