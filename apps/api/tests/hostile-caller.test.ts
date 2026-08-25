/**
 * A signed-in stranger, reaching for somebody else's record.
 *
 * Anonymous access is already covered elsewhere, by a test that enumerates the
 * server's own route table so a new route inherits the check without anybody
 * remembering. This is the other half, and it is the half that enumeration
 * cannot do: a caller with a perfectly valid session, using a perfectly valid
 * endpoint, passing an id that is not theirs.
 *
 * Every one of these is a single missing `eq(table.userId, userId)` away from
 * being real. The clause is present in all of them today — the point of writing
 * these down is that it stays present, and that removing one fails here rather
 * than in somebody's health record.
 *
 * Each case asserts two things, because a refusal that still had an effect is
 * the worst of both: the request is refused, and the victim's data is untouched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { ethers } from 'ethers'
import { createSelfCustodyKey, signAnchor } from '@ogt/og'
import { startHarness, signIn, VALID_PROFILE } from './helpers/e2e.ts'
import * as schema from '../src/db/schema.ts'

const ANCHOR_CONTRACT = '0x75016F7ce345E0527d20B5E08f273E42886D35A5'
const CHAIN_ID = 16602

let phones = 0

interface Person {
  token: string
  userId: string
  headers: { authorization: string }
}

async function person(harness: Awaited<ReturnType<typeof startHarness>>): Promise<Person> {
  phones += 1
  const phone = `+9198762${String(30000 + phones).padStart(5, '0')}`
  const { token } = await signIn(harness, phone)

  await harness.app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { authorization: `Bearer ${token}` },
    payload: VALID_PROFILE,
  })

  const [user] = await harness.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.phone, phone))
    .limit(1)

  return { token, userId: user!.id, headers: { authorization: `Bearer ${token}` } }
}

/** A meal with one item, belonging to somebody. */
async function mealFor(harness: Awaited<ReturnType<typeof startHarness>>, userId: string) {
  const [meal] = await harness.db
    .insert(schema.meals)
    .values({
      userId,
      eatenAt: new Date(),
      mealType: 'lunch',
      kcal: 180,
      proteinG: 9,
      carbG: 20,
      fatG: 4,
      confidence: 'confirmed',
      source: 'photo',
    })
    .returning({ id: schema.meals.id })

  const [item] = await harness.db
    .insert(schema.mealItems)
    .values({
      mealId: meal!.id,
      name: 'dal',
      grams: 150,
      kcal: 180,
      proteinG: 9,
      carbG: 20,
      fatG: 4,
      confidence: 'confirmed',
      portionLabel: '1 katori',
      units: 1,
      modelConfidence: 0.9,
    })
    .returning({ id: schema.mealItems.id })

  return { mealId: meal!.id, itemId: item!.id }
}

/**
 * Put somebody into self-custody.
 *
 * Both anchor routes check the *caller's* custody state before they look at any
 * snapshot, so an attacker who has not taken custody is refused for a reason
 * that has nothing to do with ownership — which is how the first version of
 * these two tests passed against a build with the scoping removed.
 */
async function takeCustody(harness: Awaited<ReturnType<typeof startHarness>>, who: Person) {
  const key = createSelfCustodyKey()
  const response = await harness.app.inject({
    method: 'POST',
    url: '/users/me/custody',
    headers: who.headers,
    payload: { publicKey: key.publicKey, address: key.address },
  })
  assert.equal(response.statusCode, 200, response.body)
  return key
}

test('one person cannot correct another person\'s meal item', async () => {
  const harness = await startHarness()

  try {
    const victim = await person(harness)
    const attacker = await person(harness)

    const { mealId, itemId } = await mealFor(harness, victim.userId)

    /*
     * PATCH with a field the route actually accepts. The first version of this
     * test sent POST with `grams`, which 404s on the verb and fails validation
     * on the body — so it passed against a build with the ownership check
     * removed. A test that cannot tell those apart is worse than none.
     */
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/meals/${mealId}/items/${itemId}`,
      headers: attacker.headers,
      payload: { units: 4 },
    })

    assert.ok(response.statusCode >= 400, `expected a refusal, got ${response.statusCode}`)

    // Refused and inert. A correction that "failed" but still wrote would be
    // the worst outcome, and the status alone would not have caught it.
    const [item] = await harness.db
      .select({ grams: schema.mealItems.grams, units: schema.mealItems.units })
      .from(schema.mealItems)
      .where(eq(schema.mealItems.id, itemId))

    assert.equal(item!.grams, 150, "the victim's meal must be unchanged")
    assert.equal(item!.units, 1, 'and its portion must not move')
  } finally {
    await harness.close()
  }
})

test('one person cannot repeat another person\'s meal into their own day', async () => {
  const harness = await startHarness()

  try {
    const victim = await person(harness)
    const attacker = await person(harness)

    const { mealId } = await mealFor(harness, victim.userId)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/meals/repeat',
      headers: attacker.headers,
      payload: { sourceMealId: mealId },
    })

    assert.ok(response.statusCode >= 400, `expected a refusal, got ${response.statusCode}`)

    /*
     * Copying somebody else's meal reads as harmless until you notice what it
     * discloses: a successful repeat would tell the attacker exactly what the
     * victim ate, by putting it in their own day.
     */
    const theirMeals = await harness.db
      .select({ id: schema.meals.id })
      .from(schema.meals)
      .where(eq(schema.meals.userId, attacker.userId))

    assert.equal(theirMeals.length, 0, 'nothing may be copied across')
  } finally {
    await harness.close()
  }
})

test('one person cannot close another person\'s open topic', async () => {
  const harness = await startHarness()

  try {
    const victim = await person(harness)
    const attacker = await person(harness)

    const [fact] = await harness.db
      .insert(schema.lifeFacts)
      .values({
        userId: victim.userId,
        kind: 'symptom',
        verbatim: 'chest has felt tight since Monday',
        occurredAt: new Date(),
      })
      .returning({ id: schema.lifeFacts.id })

    await harness.app.inject({
      method: 'POST',
      url: `/users/me/facts/${fact!.id}/resolve`,
      headers: attacker.headers,
    })

    /*
     * Silencing somebody else's coach about a symptom they never said was
     * finished is the harm the resolve column exists to prevent, arrived at
     * from the other direction.
     */
    const [row] = await harness.db
      .select({ resolvedAt: schema.lifeFacts.resolvedAt })
      .from(schema.lifeFacts)
      .where(eq(schema.lifeFacts.id, fact!.id))

    assert.equal(row!.resolvedAt, null, 'their topic must still be open')
  } finally {
    await harness.close()
  }
})

test('one person cannot attach a signature to another person\'s snapshot', async () => {
  const harness = await startHarness()

  try {
    const victim = await person(harness)
    const attacker = await person(harness)

    // The victim takes custody, so their snapshots wait on their own signature.
    const victimKey = createSelfCustodyKey()
    await harness.app.inject({
      method: 'POST',
      url: '/users/me/custody',
      headers: victim.headers,
      payload: { publicKey: victimKey.publicKey, address: victimKey.address },
    })

    const [snapshot] = await harness.db
      .insert(schema.snapshots)
      .values({
        userId: victim.userId,
        rootHashes: ['0x' + '55'.repeat(32)],
        txHashes: ['0x' + '66'.repeat(32)],
        schemaVersion: 1,
        bytes: 256,
      })
      .returning({ id: schema.snapshots.id })

    /*
     * The attacker is in self-custody too, and signs with the very key the
     * server has on file for them — so the signature verifies as genuinely
     * theirs.
     *
     * That is deliberate, and it is what makes this test mean anything. An
     * earlier version signed with an unrelated key, so the route refused with
     * `wrong_signer` and would have refused identically with the ownership
     * scoping removed. Now the scoping is the only thing standing between the
     * attacker and a signature written onto somebody else's snapshot.
     */
    const attackerKey = await takeCustody(harness, attacker)
    const signed = await signAnchor(
      new ethers.Wallet(attackerKey.privateKey),
      ANCHOR_CONTRACT,
      CHAIN_ID,
      {
        rootHashes: ['0x' + '55'.repeat(32)],
        schemaVersion: 1,
        nonce: BigInt('0x' + snapshot!.id.replaceAll('-', '')),
      },
    )

    const response = await harness.app.inject({
      method: 'POST',
      url: `/users/me/anchors/${snapshot!.id}/signature`,
      headers: attacker.headers,
      payload: { signature: signed.signature, deadline: signed.deadline.toString() },
    })

    assert.ok(response.statusCode >= 400, `expected a refusal, got ${response.statusCode}`)

    const [row] = await harness.db
      .select({ ownerSignature: schema.snapshots.ownerSignature })
      .from(schema.snapshots)
      .where(eq(schema.snapshots.id, snapshot!.id))

    // Storing it would have the relayer submit a signature the contract
    // rejects, and we would pay for the revert.
    assert.equal(row!.ownerSignature, null, 'nothing unverified may be stored')
  } finally {
    await harness.close()
  }
})

test('one person cannot see another person\'s pending anchors', async () => {
  const harness = await startHarness()

  try {
    const victim = await person(harness)
    const attacker = await person(harness)

    const victimKey = createSelfCustodyKey()
    await harness.app.inject({
      method: 'POST',
      url: '/users/me/custody',
      headers: victim.headers,
      payload: { publicKey: victimKey.publicKey, address: victimKey.address },
    })

    await harness.db.insert(schema.snapshots).values({
      userId: victim.userId,
      rootHashes: ['0x' + '77'.repeat(32)],
      txHashes: ['0x' + '88'.repeat(32)],
      schemaVersion: 1,
      bytes: 128,
    })

    // Same reason as above: without custody the route returns early and the
    // scoping clause is never exercised.
    await takeCustody(harness, attacker)

    const response = await harness.app.inject({
      method: 'GET',
      url: '/users/me/anchors/pending',
      headers: attacker.headers,
    })

    assert.equal(response.statusCode, 200)

    // A root hash is a retrieval key on 0G Storage. Leaking one is not a
    // metadata leak; it is a pointer to the record itself.
    const body = response.body
    assert.ok(!body.includes('77'.repeat(32)), 'a root hash must not cross between people')
    assert.deepEqual((response.json() as { pending: unknown[] }).pending, [])
  } finally {
    await harness.close()
  }
})

test('taking custody affects only the person who asked', async () => {
  const harness = await startHarness()

  try {
    const victim = await person(harness)
    const attacker = await person(harness)

    const key = createSelfCustodyKey()
    await harness.app.inject({
      method: 'POST',
      url: '/users/me/custody',
      headers: attacker.headers,
      payload: { publicKey: key.publicKey, address: key.address },
    })

    const [theirs] = await harness.db
      .select({
        custodyTakenAt: schema.users.custodyTakenAt,
        recordPubKey: schema.users.recordPubKey,
      })
      .from(schema.users)
      .where(eq(schema.users.id, victim.userId))

    // Moving somebody else's key would lock them out of their own history
    // permanently, with no way back.
    assert.equal(theirs!.custodyTakenAt, null)
    assert.notEqual(theirs!.recordPubKey, key.publicKey)
  } finally {
    await harness.close()
  }
})
