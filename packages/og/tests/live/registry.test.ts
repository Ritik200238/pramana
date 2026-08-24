/**
 * Our model registry, checked against the live 0G Router catalogue.
 *
 * Every claim in models.ts is a claim about somebody else's infrastructure: that
 * a model exists, that it is hardware-attested, that it accepts an image, that
 * it costs what we budgeted. None of those are ours to guarantee, and all of
 * them can change without us noticing — a model is deprecated, attestation is
 * withdrawn, a price moves.
 *
 * The privacy claim is the one that matters most. This product tells people
 * their food photos are processed inside hardware-sealed enclaves. If a model
 * in a chain quietly stops being attested, that sentence becomes false while
 * every test still passes and nothing in the product looks different.
 *
 * `GET /v1/models` needs no API key, so this costs nothing to run and can be
 * run by anyone wanting to check the claim for themselves. It is kept out of
 * the default suite because a unit test that fails when the wifi drops teaches
 * people to ignore failures.
 *
 * Run with:  npm run test:live -w @ogt/og
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS, MODELS } from '../../src/models.ts'

const CATALOGUE = 'https://router-api.0g.ai/v1/models'

interface LiveModel {
  id: string
  tee_attested?: boolean | null
  tee_type?: string | null
  architecture?: { input_modalities?: string[] }
  pricing?: Record<string, string | number>
}

let cached: Map<string, LiveModel> | null = null

async function catalogue(): Promise<Map<string, LiveModel>> {
  if (cached) return cached

  const response = await fetch(CATALOGUE, { signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, 'the Router catalogue must be reachable')

  const body = (await response.json()) as { data: LiveModel[] }
  cached = new Map(body.data.map((model) => [model.id, model]))
  return cached
}

test('every model we route to still exists on the Router', async () => {
  const live = await catalogue()

  const missing = Object.values(MODELS)
    .map((model) => model.id)
    .filter((id) => !live.has(id))

  // A model that has been retired fails every request routed to it, and the
  // failover chain would mask that until the last entry went too.
  assert.deepEqual(missing, [], 'these models are configured but no longer offered')
})

test('every model in a chain is genuinely TEE-attested, live', async () => {
  const live = await catalogue()

  const unattested: string[] = []
  for (const [task, chain] of Object.entries(CHAINS)) {
    for (const model of chain) {
      const entry = live.get(model.id)
      if (!entry) continue // covered by the test above
      if (entry.tee_attested !== true) {
        unattested.push(`${model.id} in "${task}" reports tee_attested=${entry.tee_attested}`)
      }
    }
  }

  assert.deepEqual(
    unattested,
    [],
    'identified health data must only reach attested models — the privacy claim depends on it',
  )
})

test('our attestation flags match what the Router reports', async () => {
  const live = await catalogue()

  for (const model of Object.values(MODELS)) {
    const entry = live.get(model.id)
    if (!entry) continue
    assert.equal(
      model.tee,
      entry.tee_attested === true,
      `${model.id}: we record tee=${model.tee}, the Router reports ${entry.tee_attested}`,
    )
  }
})

test('a model we send photographs to actually accepts images', async () => {
  const live = await catalogue()

  for (const model of Object.values(MODELS)) {
    const entry = live.get(model.id)
    if (!entry || !model.vision) continue

    const modalities = entry.architecture?.input_modalities ?? []
    assert.ok(
      modalities.includes('image'),
      `${model.id} is used for meal photos but reports modalities ${modalities.join(', ')}`,
    )
  }
})

test('the proxied models remain excluded from every chain', async () => {
  const live = await catalogue()

  // `claude-*` and `gpt-*` are proxied to their original providers for billing
  // convenience. They report no attestation at all, which is the whole reason
  // they are absent here — this asserts the Router still agrees with that
  // reading rather than that we merely believed it once.
  const proxied = [...live.values()].filter(
    (entry) => /^(claude|gpt)-/.test(entry.id) && entry.tee_attested !== true,
  )
  assert.ok(proxied.length > 0, 'expected the catalogue to still carry proxied models')

  const chained = new Set<string>(Object.values(CHAINS).flatMap((chain) => chain.map((m) => m.id)))
  for (const entry of proxied) {
    assert.equal(chained.has(entry.id), false, `${entry.id} is unattested and must not be routed to`)
  }
})

test('the vision chain spans more than one model', async () => {
  // The Router fails over within a model's own provider set, so a chain of one
  // is a single point of failure for the highest-volume call in the product.
  assert.ok(CHAINS.mealVision.length >= 2, 'meal vision needs a fallback')

  const ids = new Set(CHAINS.mealVision.map((model) => model.id))
  assert.equal(ids.size, CHAINS.mealVision.length, 'a chain of duplicates is not a chain')
})
