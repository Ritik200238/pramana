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
  pricing_usd?: { prompt?: string; completion?: string }
  supported_parameters?: string[]
  max_completion_tokens?: number
  provider_count?: number
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

test('our published prices still match the live catalogue', async () => {
  const live = await catalogue()

  /*
   * Hardcoded prices rot silently, and this product's unit economics are the
   * argument for it existing at all.
   *
   * When this check was first written, three of six were wrong: meal vision —
   * the highest-volume call — was carried at 54% of its real rate, the coach
   * model at 42%, and speech as free when it is billed. Nothing failed. Every
   * cost figure the product produced was simply too small.
   */
  const drifted: string[] = []

  for (const model of Object.values(MODELS)) {
    const entry = live.get(model.id)
    if (!entry?.pricing_usd) continue

    const prompt = Number(entry.pricing_usd.prompt ?? '0')
    const completion = Number(entry.pricing_usd.completion ?? '0')

    // Exact comparison. A price is a published number, not a measurement, so
    // there is no tolerance to allow for.
    if (prompt !== model.usdPerPromptToken) {
      drifted.push(`${model.id} prompt: ours ${model.usdPerPromptToken}, live ${prompt}`)
    }
    if (completion !== model.usdPerCompletionToken) {
      drifted.push(`${model.id} completion: ours ${model.usdPerCompletionToken}, live ${completion}`)
    }
  }

  assert.deepEqual(drifted, [], 'update packages/og/src/models.ts to the live figures')
})

test('we only send parameters the model advertises', async () => {
  const live = await catalogue()

  /*
   * The Router does not silently drop a parameter a model does not support —
   * the documentation says it answers 400, using `tools` as the example.
   *
   * `temperature` was being sent to every model unconditionally, and kimi-k3
   * does not advertise it. kimi-k3 is the last entry in two chains, so that
   * request would have failed at exactly the moment the earlier models were
   * already failing and the fallback was all that remained — and the failover
   * treats a client error as non-retryable, so the whole chain would end there.
   */
  const wrong: string[] = []

  for (const model of Object.values(MODELS)) {
    const entry = live.get(model.id)
    const advertised = entry?.supported_parameters
    if (!advertised) continue

    const declared = {
      temperature: model.supports.temperature,
      response_format: model.supports.responseFormat,
    }

    for (const [name, weSaySupported] of Object.entries(declared)) {
      const theySaySupported = advertised.includes(name)
      if (weSaySupported !== theySaySupported) {
        wrong.push(`${model.id} ${name}: we say ${weSaySupported}, catalogue says ${theySaySupported}`)
      }
    }
  }

  assert.deepEqual(wrong, [], 'update the supports block in packages/og/src/models.ts')
})

test('every chained model accepts the parameters we always send', async () => {
  const live = await catalogue()

  // max_tokens goes on every chat request with no condition on it, so a model
  // that did not accept it could never serve a single call.
  const unusable: string[] = []
  for (const [task, chain] of Object.entries(CHAINS)) {
    if (task === 'speech') continue
    for (const model of chain) {
      const advertised = live.get(model.id)?.supported_parameters
      if (advertised && !advertised.includes('max_tokens')) {
        unusable.push(`${model.id} in "${task}" does not accept max_tokens`)
      }
    }
  }

  assert.deepEqual(unusable, [], 'these models cannot serve a request as we build it')
})

test('our default output length fits inside every model’s ceiling', async () => {
  const live = await catalogue()

  // The router asks for 800 tokens by default. A model whose ceiling is lower
  // would reject or truncate, and truncation is the worse of the two because a
  // half-written JSON answer fails to parse for reasons that look unrelated.
  const tooSmall: string[] = []
  for (const model of Object.values(MODELS)) {
    const ceiling = live.get(model.id)?.max_completion_tokens
    if (typeof ceiling === 'number' && ceiling < 800 && model.id !== MODELS.whisper.id) {
      tooSmall.push(`${model.id} caps at ${ceiling}`)
    }
  }

  assert.deepEqual(tooSmall, [], 'the default max_tokens exceeds what these models allow')
})

test('no chain rests entirely on single-provider models', async () => {
  const live = await catalogue()

  // The Router fails over within a model's own provider set, so a chain made
  // only of single-provider models has no redundancy anywhere in it.
  for (const [task, chain] of Object.entries(CHAINS)) {
    if (task === 'speech') continue // whisper is the only speech model; noted in models.ts

    const redundant = chain.filter((model) => (live.get(model.id)?.provider_count ?? 0) > 1)
    assert.ok(
      redundant.length > 0,
      `every model in "${task}" is served by a single provider`,
    )
  }
})
