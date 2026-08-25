/**
 * The facts a person can see, and close.
 *
 * `life_facts` was doing real work everywhere — the coach's context, the weekly
 * review, the proactive nudge, the encrypted snapshot, the export — and had no
 * endpoint that listed it. The route that closes a topic existed and resolved
 * something nobody could see.
 *
 * The schema states the stakes plainly: "a resolved fact is NEVER raised again
 * by the proactive engine — this column exists because of a documented harm: a
 * coach that kept surfacing a healed injury for three months and then argued
 * with the user about it."
 *
 * So the property under test is not that a list endpoint returns rows. It is
 * that closing a topic actually closes it, and that one person's record is never
 * another person's.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { startHarness, signIn } from './helpers/e2e.ts'
import * as schema from '../src/db/schema.ts'

let phones = 0

async function person(harness: Awaited<ReturnType<typeof startHarness>>) {
  phones += 1
  const phone = `+9198760${String(10000 + phones).padStart(5, '0')}`
  const { token } = await signIn(harness, phone)

  const [user] = await harness.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.phone, phone))
    .limit(1)

  return { token, userId: user!.id }
}

async function remember(
  harness: Awaited<ReturnType<typeof startHarness>>,
  userId: string,
  verbatim: string,
  kind: 'symptom' | 'sleep' = 'symptom',
) {
  const [row] = await harness.db
    .insert(schema.lifeFacts)
    .values({ userId, kind, verbatim, occurredAt: new Date() })
    .returning({ id: schema.lifeFacts.id })
  return row!.id
}

test('what a person said comes back in their own words', async () => {
  const harness = await startHarness()

  try {
    const { token, userId } = await person(harness)
    await remember(harness, userId, 'my knee has been hurting since Tuesday')

    const response = await harness.app.inject({
      method: 'GET',
      url: '/users/me/facts',
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(response.statusCode, 200)
    const { facts } = response.json() as { facts: Array<{ verbatim: string; kind: string }> }

    assert.equal(facts.length, 1)
    // Verbatim. A summary returned as though it were what they said would be a
    // quiet way of throwing away what they said.
    assert.equal(facts[0]!.verbatim, 'my knee has been hurting since Tuesday')
    assert.equal(facts[0]!.kind, 'symptom')
  } finally {
    await harness.close()
  }
})

test('a topic that is sorted stops being listed, and stays in the record', async () => {
  const harness = await startHarness()

  try {
    const { token, userId } = await person(harness)
    const knee = await remember(harness, userId, 'knee hurts')
    await remember(harness, userId, 'slept badly', 'sleep')

    const closed = await harness.app.inject({
      method: 'POST',
      url: `/users/me/facts/${knee}/resolve`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(closed.statusCode, 200)

    const after = await harness.app.inject({
      method: 'GET',
      url: '/users/me/facts',
      headers: { authorization: `Bearer ${token}` },
    })

    const { facts } = after.json() as { facts: Array<{ verbatim: string }> }
    assert.deepEqual(
      facts.map((fact) => fact.verbatim),
      ['slept badly'],
      'a closed topic must not be raised again; an open one must remain',
    )

    /*
     * R6 — nothing said to us is ever thrown away. Resolving marks a topic
     * finished; it does not delete it. The row is still there, and still in the
     * export and the encrypted snapshot.
     */
    const rows = await harness.db
      .select()
      .from(schema.lifeFacts)
      .where(eq(schema.lifeFacts.id, knee))

    assert.equal(rows.length, 1, 'resolving must not delete anything')
    assert.ok(rows[0]!.resolvedAt instanceof Date)
    assert.equal(rows[0]!.verbatim, 'knee hurts')
  } finally {
    await harness.close()
  }
})

test('one person cannot see or close another person\'s record', async () => {
  const harness = await startHarness()

  try {
    const mine = await person(harness)
    const theirs = await person(harness)

    const theirFact = await remember(harness, theirs.userId, 'private thing')

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/users/me/facts',
      headers: { authorization: `Bearer ${mine.token}` },
    })
    assert.deepEqual((listed.json() as { facts: unknown[] }).facts, [])

    // Resolving somebody else's topic would silence their coach about something
    // they never said was finished.
    await harness.app.inject({
      method: 'POST',
      url: `/users/me/facts/${theirFact}/resolve`,
      headers: { authorization: `Bearer ${mine.token}` },
    })

    const [row] = await harness.db
      .select()
      .from(schema.lifeFacts)
      .where(eq(schema.lifeFacts.id, theirFact))

    assert.equal(row!.resolvedAt, null, 'their topic must still be open')
  } finally {
    await harness.close()
  }
})

test('the endpoint is reachable without a session, and is not', async () => {
  const harness = await startHarness()

  try {
    // The auth allowlist is enumerated elsewhere; this is the specific check
    // that a route added later inherited the guard.
    const response = await harness.app.inject({ method: 'GET', url: '/users/me/facts' })
    assert.equal(response.statusCode, 401)
  } finally {
    await harness.close()
  }
})
