/**
 * When to try the next model, and when trying it makes things worse.
 *
 * The Router's error table separates two kinds of 4xx that behave in opposite
 * ways, and the distinction is easy to get backwards because both are "the
 * request failed".
 *
 * 401, 402, 403 belong to the account. Every model in the chain fails
 * identically, so walking it is three requests to learn one thing.
 *
 * 429 belongs to the account too, and this is the one that was wrong. It was
 * treated as a reason to try the next model. The documentation says the limit
 * is per account, so failing over does not route around it — it fires another
 * request at the same throttled account, burns the rest of the chain, and makes
 * the throttling worse for whatever comes next.
 *
 * 408 is genuinely worth escaping: a timeout belongs to the provider that
 * stalled, and the next model is a different set of providers.
 *
 * Source: 0G docs, Router → Errors, and Router → Rate Limits.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OGRouterError, complete, retryAfterSeconds } from '../src/router.ts'

/** A client whose every call fails with a given status, counting attempts. */
function failingClient(status: number, headers?: Record<string, string>) {
  const calls: string[] = []
  return {
    calls,
    chat: {
      completions: {
        async create(body: { model: string }) {
          calls.push(body.model)
          const error = Object.assign(new Error(`status ${status}`), { status, headers })
          throw error
        },
      },
    },
  } as never
}

const ASK = {
  task: 'coach' as const,
  messages: [{ role: 'user' as const, content: 'hello' }],
}

test('a rate limit stops the chain instead of hammering it', async () => {
  const client = failingClient(429, { 'retry-after': '30' })

  await assert.rejects(() => complete(client, ASK), OGRouterError)

  // One request, not one per model. The account is throttled; the other models
  // are on the same account.
  assert.equal((client as unknown as { calls: string[] }).calls.length, 1)
})

test('the wait the Router asked for is carried to the caller', async () => {
  const client = failingClient(429, { 'retry-after': '30' })

  try {
    await complete(client, ASK)
    assert.fail('should have thrown')
  } catch (error) {
    assert.ok(error instanceof OGRouterError)
    // So a caller can say "try again in thirty seconds" rather than invent one.
    assert.equal(error.retryAfterSeconds, 30)
    assert.match(error.message, /rate limited/i)
  }
})

test('a timeout does try the next model', async () => {
  // A stalled provider is exactly what a chain of different models is for.
  const client = failingClient(408)

  await assert.rejects(() => complete(client, ASK))
  assert.equal((client as unknown as { calls: string[] }).calls.length, 3)
})

test('an account-level failure stops at the first model', async () => {
  for (const status of [401, 402, 403]) {
    const client = failingClient(status)
    await assert.rejects(() => complete(client, ASK))

    assert.equal(
      (client as unknown as { calls: string[] }).calls.length,
      1,
      `status ${status} should not have walked the chain`,
    )
  }
})

test('a server error walks the chain, because it belongs to one model', async () => {
  // 503 is documented as "no healthy providers for the requested model", which
  // is precisely the case another model can answer.
  for (const status of [500, 502, 503]) {
    const client = failingClient(status)
    await assert.rejects(() => complete(client, ASK))

    assert.equal(
      (client as unknown as { calls: string[] }).calls.length,
      3,
      `status ${status} should have tried every model`,
    )
  }
})

test('a missing or nonsense Retry-After reads as null, not zero', () => {
  // Zero would mean "retry immediately", which is the opposite of what an
  // absent header means.
  assert.equal(retryAfterSeconds({ headers: {} }), null)
  assert.equal(retryAfterSeconds({}), null)
  assert.equal(retryAfterSeconds({ headers: { 'retry-after': 'soon' } }), null)
  assert.equal(retryAfterSeconds({ headers: { 'retry-after': '-5' } }), null)
  assert.equal(retryAfterSeconds({ headers: { 'retry-after': '0' } }), 0)
})
