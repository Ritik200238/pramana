import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS, MODELS, assertAllChainsAreTeeAttested } from '../src/models.ts'

test('every model in every chain is TEE-attested', () => {
  // The privacy claim is "we cannot read your health data". That is only true
  // for attested models, so this invariant is the claim in executable form.
  assert.doesNotThrow(() => assertAllChainsAreTeeAttested())
})

test('no proxied frontier model appears in any chain', () => {
  // claude-* and gpt-* on the Router report tee_attested: null. They are
  // convenient billing, not confidential execution.
  for (const [task, chain] of Object.entries(CHAINS)) {
    for (const model of chain) {
      assert.doesNotMatch(model.id, /^(claude|gpt)-/, `${model.id} must not be in chain ${task}`)
    }
  }
})

test('every chain that can fail over has more than one model', () => {
  // Most Router models have 1-2 providers, so a single-model chain is a single
  // point of failure. Speech is the documented exception: whisper-large-v3 is
  // the only speech-to-text model served.
  for (const [task, chain] of Object.entries(CHAINS)) {
    if (task === 'speech') continue
    assert.ok(chain.length >= 2, `chain "${task}" has no fallback`)
  }
})

test('vision chains only contain vision-capable models', () => {
  for (const model of CHAINS.mealVision) {
    assert.equal(model.vision, true, `${model.id} cannot accept images`)
  }
})

test('the meal vision chain leads with the cheapest model', () => {
  const costs = CHAINS.mealVision.map((m) => m.usdPerPromptToken)
  assert.equal(
    costs[0],
    Math.min(...costs),
    'photo logging is the highest-volume call; it must lead with the cheapest capable model',
  )
})

test('chains contain no duplicate models', () => {
  for (const [task, chain] of Object.entries(CHAINS)) {
    const ids = chain.map((m) => m.id)
    assert.equal(new Set(ids).size, ids.length, `chain "${task}" repeats a model`)
  }
})

test('the primary vision model is materially cheaper than a frontier model', () => {
  // The economic case for building on 0G is this ratio. If it ever collapses,
  // the free tier stops being affordable and the product strategy changes.
  const ours = MODELS.qwen3vl30b.usdPerPromptToken
  const claudeSonnetPromptUsd = 0.0000019 // from the Router catalogue, for comparison only
  assert.ok(
    claudeSonnetPromptUsd / ours > 50,
    'expected at least a 50x input-cost advantage over a frontier model',
  )
})

test('every model declares non-negative pricing', () => {
  for (const model of Object.values(MODELS)) {
    assert.ok(model.usdPerPromptToken >= 0)
    assert.ok(model.usdPerCompletionToken >= 0)
  }
})
