/**
 * Idempotent writes, against a real database.
 *
 * The unique constraint is doing the load-bearing work here, so these run
 * against Postgres rather than a stub. A mock would happily let two concurrent
 * inserts through and report success.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signIn, startHarness, VALID_PROFILE, type Harness } from './helpers/e2e.ts'

async function withUser(
  body: (h: Harness, headers: Record<string, string>) => Promise<void>,
): Promise<void> {
  const harness = await startHarness()
  try {
    const { token } = await signIn(harness, '9812345678')
    const headers = { authorization: `Bearer ${token}` }

    await harness.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers,
      payload: VALID_PROFILE,
    })

    await body(harness, headers)
  } finally {
    await harness.close()
  }
}

test('the same weight entry replayed twice is recorded once', async () => {
  await withUser(async (h, headers) => {
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: '/users/me/weight',
        headers: { ...headers, 'idempotency-key': 'weight-monday' },
        payload: { weightKg: 71.5 },
      })

    const first = await send()
    const second = await send()

    assert.equal(first.statusCode, 201, first.body)
    assert.equal(second.statusCode, 201, second.body)
    assert.equal(second.headers['idempotent-replay'], 'true', 'the replay must be recognised')
    assert.deepEqual(second.json(), first.json(), 'and must return the original answer')

    // Onboarding logs one weight, and the replay must not have added a third.
    const rows = await h.db.execute('select count(*)::int as count from weight_logs')
    const list = (rows as unknown as { rows?: Array<{ count: number }> }).rows ?? rows
    assert.equal((list as Array<{ count: number }>)[0]?.count, 2)
  })
})

test('without a key, two identical writes are two writes', async () => {
  await withUser(async (h, headers) => {
    for (let i = 0; i < 2; i += 1) {
      await h.app.inject({
        method: 'POST',
        url: '/users/me/weight',
        headers,
        payload: { weightKg: 70 },
      })
    }

    // Idempotency is opt-in. Somebody genuinely weighing themselves twice is a
    // thing that happens, and the server must not decide otherwise.
    const rows = await h.db.execute('select count(*)::int as count from weight_logs')
    const list = (rows as unknown as { rows?: Array<{ count: number }> }).rows ?? rows
    assert.equal((list as Array<{ count: number }>)[0]?.count, 3)
  })
})

test('a key reused for different content is refused, not answered', async () => {
  await withUser(async (h, headers) => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/users/me/weight',
      headers: { ...headers, 'idempotency-key': 'reused' },
      payload: { weightKg: 71 },
    })
    assert.equal(first.statusCode, 201)

    const second = await h.app.inject({
      method: 'POST',
      url: '/users/me/weight',
      headers: { ...headers, 'idempotency-key': 'reused' },
      payload: { weightKg: 99 },
    })

    // Returning the stored response would answer a question nobody asked, and
    // would silently discard a real weight.
    assert.equal(second.statusCode, 422, second.body)
    assert.equal(second.json().error, 'idempotency_key_reused')
  })
})

test('two people may use the same key without colliding', async () => {
  const harness = await startHarness()
  try {
    const alice = await signIn(harness, '9812345601')
    const bob = await signIn(harness, '9812345602')

    for (const person of [alice, bob]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/users/me/profile',
        headers: { authorization: `Bearer ${person.token}`, 'idempotency-key': 'onboarding' },
        payload: VALID_PROFILE,
      })
      // Keys are scoped per user. A global namespace would let one person's
      // key deny another's write, or hand them its response.
      assert.equal(response.statusCode, 200, response.body)
      assert.notEqual(response.headers['idempotent-replay'], 'true')
    }
  } finally {
    await harness.close()
  }
})

test('a concurrent replay is told to retry rather than run twice', async () => {
  await withUser(async (h, headers) => {
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: '/users/me/weight',
        headers: { ...headers, 'idempotency-key': 'concurrent' },
        payload: { weightKg: 68 },
      })

    // Issued together so both reach the claim before either completes.
    const [a, b] = await Promise.all([send(), send()])
    const statuses = [a.statusCode, b.statusCode].sort()

    // Whichever ordering the database picks, exactly one may do the work. The
    // other is either told to retry or handed the finished answer.
    assert.ok(
      statuses[0] === 201 && (statuses[1] === 201 || statuses[1] === 409),
      `expected one write and one replay or conflict, got ${statuses.join(',')}`,
    )

    const rows = await h.db.execute('select count(*)::int as count from weight_logs')
    const list = (rows as unknown as { rows?: Array<{ count: number }> }).rows ?? rows
    assert.equal((list as Array<{ count: number }>)[0]?.count, 2, 'the write must have run once')
  })
})

test('a failed write does not poison the key', async () => {
  await withUser(async (h, headers) => {
    const rejected = await h.app.inject({
      method: 'POST',
      url: '/users/me/weight',
      headers: { ...headers, 'idempotency-key': 'retry-me' },
      payload: { weightKg: 5000 },
    })
    assert.equal(rejected.statusCode, 400, 'the weight is out of range')

    const accepted = await h.app.inject({
      method: 'POST',
      url: '/users/me/weight',
      headers: { ...headers, 'idempotency-key': 'retry-me' },
      payload: { weightKg: 70 },
    })

    // Storing failures would make a transient fault permanent for anyone who
    // retried with the same key.
    assert.equal(accepted.statusCode, 201, accepted.body)
  })
})
