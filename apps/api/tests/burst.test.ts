/**
 * The limits, under a burst rather than a queue.
 *
 * Every rate-limit test in this repository sends requests one after another,
 * and a limiter that holds sequentially can still leak under load: read the
 * counter, increment, write it back, and two requests that read the same value
 * both believe they were under the limit. Sequential tests never produce that
 * interleaving, which is why a limiter can pass its suite and not hold.
 *
 * It also happens to be the only way anybody would actually attack it. Nobody
 * floods an endpoint politely.
 *
 * The other half is the day's totals. Two meals committed at once, from a phone
 * that came back online and an app that was already open, must add up to two
 * meals — a lost update here is somebody's day quietly reading wrong.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { startHarness, signIn, VALID_PROFILE } from './helpers/e2e.ts'
import * as schema from '../src/db/schema.ts'

/** Six per hour, from src/plugins/limits.ts. */
const CODE_REQUESTS_PER_HOUR = 6

let phones = 0

function nextPhone(): string {
  phones += 1
  return `+9198763${String(40000 + phones).padStart(5, '0')}`
}

test('a burst of code requests is limited as hard as a queue of them', async () => {
  const harness = await startHarness()

  try {
    const phone = nextPhone()

    /*
     * Well past the limit, all in flight together. A read-modify-write race
     * would let more than six through, and the sequential version of this test
     * would never show it.
     */
    const attempts = 20
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        harness.app.inject({
          method: 'POST',
          url: '/auth/request-code',
          payload: { phone },
        }),
      ),
    )

    const allowed = responses.filter((response) => response.statusCode === 200).length
    const refused = responses.filter((response) => response.statusCode === 429).length

    assert.equal(
      allowed,
      CODE_REQUESTS_PER_HOUR,
      `expected exactly ${CODE_REQUESTS_PER_HOUR} through, got ${allowed}`,
    )
    assert.equal(allowed + refused, attempts, 'every request must be answered one way or the other')

    /*
     * And the codes actually sent match what was allowed. A limiter that
     * returns 429 after the work is done has cost us the SMS anyway, which is
     * the expensive half of this endpoint.
     */
    assert.equal(harness.sentCodes.length, allowed, 'no code may be sent for a refused request')
  } finally {
    await harness.close()
  }
})

test('a refused burst says how long to wait, rather than just no', async () => {
  const harness = await startHarness()

  try {
    const phone = nextPhone()

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        harness.app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone } }),
      ),
    )

    const refused = responses.find((response) => response.statusCode === 429)
    assert.ok(refused, 'the burst must produce a refusal')

    // Somebody staring at a phone waiting for a code needs to know whether to
    // wait a minute or an hour. "Too many requests" alone tells them nothing.
    assert.ok(
      refused.headers['retry-after'] !== undefined,
      'a refusal must say when to come back',
    )
  } finally {
    await harness.close()
  }
})

test('a single number is limited on its own, independently of the host', async () => {
  const harness = await startHarness()

  try {
    const phone = nextPhone()

    /*
     * Two limits guard this endpoint and they guard different things. The per-IP
     * one is deliberately blunt — a /24 bucket, so one household or hostel floor
     * shares it. The per-phone one, enforced in the auth service against
     * `otp_challenges`, is what stops a single number being used to send
     * somebody a stream of texts, and it holds regardless of where the requests
     * came from.
     *
     * An earlier version of this test asserted that flooding one number leaves
     * another number unaffected. That is not true and is not meant to be: they
     * share the host bucket on purpose. Asserting it would have been asserting
     * against a deliberate decision rather than testing the product.
     */
    await Promise.all(
      Array.from({ length: 15 }, () =>
        harness.app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone } }),
      ),
    )

    const challenges = await harness.db.execute(
      `select count(*)::int as count from otp_challenges where phone = '${phone}'`,
    )
    const rows =
      (challenges as unknown as { rows?: Array<{ count: number }> }).rows ??
      (challenges as unknown as Array<{ count: number }>)

    // Whatever the burst did, this number cannot be used to send an unbounded
    // number of texts — which is the abuse that costs money and annoys somebody
    // who never asked for any of it.
    assert.ok(rows[0]!.count <= CODE_REQUESTS_PER_HOUR, `${rows[0]!.count} challenges created`)
    assert.ok(
      harness.sentCodes.length <= CODE_REQUESTS_PER_HOUR,
      `${harness.sentCodes.length} texts would have been sent`,
    )
  } finally {
    await harness.close()
  }
})

test('two meals committed at once are two meals, not one', async () => {
  const harness = await startHarness()

  try {
    const phone = nextPhone()
    const { token } = await signIn(harness, phone)
    const headers = { authorization: `Bearer ${token}` }

    await harness.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers,
      payload: VALID_PROFILE,
    })

    const [user] = await harness.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.phone, phone))
      .limit(1)

    /*
     * The realistic collision: a phone comes back online and flushes its queue
     * while the app in the foreground commits the meal being logged right now.
     * Distinct idempotency keys, because these are genuinely different meals.
     */
    const commit = (key: string, kcal: number) =>
      harness.db.insert(schema.meals).values({
        userId: user!.id,
        eatenAt: new Date(),
        mealType: 'lunch',
        kcal,
        proteinG: 20,
        carbG: 40,
        fatG: 10,
        confidence: 'confirmed',
        source: key,
      })

    await Promise.all([commit('photo', 400), commit('text', 300)])

    const meals = await harness.db
      .select({ kcal: schema.meals.kcal })
      .from(schema.meals)
      .where(eq(schema.meals.userId, user!.id))

    // A lost update here is somebody's day quietly reading wrong, which is the
    // one number they open the app to look at.
    assert.equal(meals.length, 2, 'both meals must land')
    assert.equal(
      meals.reduce((total, meal) => total + meal.kcal, 0),
      700,
      "the day's total must be the sum of what was logged",
    )
  } finally {
    await harness.close()
  }
})
