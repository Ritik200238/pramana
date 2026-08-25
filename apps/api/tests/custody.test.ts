/**
 * Taking custody, end to end.
 *
 * The claim this feature makes is a strong one — after this, we cannot read
 * your records and cannot claim them on chain — and strong claims are exactly
 * where a product usually ships a flag that changes a label and nothing else.
 *
 * So the assertions here are mostly negative, and the important one is the last
 * kind: that the anchor worker, holding the master seed and perfectly capable of
 * signing, does not. A worker that signed anyway would produce an anchor the
 * contract accepts, that verifies, that looks correct in every log — and that
 * records the wrong owner while the product tells them otherwise.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import { eq } from 'drizzle-orm'
import { createSelfCustodyKey, signAnchor } from '@ogt/og'
import { startHarness, signIn } from './helpers/e2e.ts'
import { ensureRecordKey } from '../src/services/record-key.ts'
import { startAnchorWorker } from '../src/jobs/anchor.ts'
import * as schema from '../src/db/schema.ts'

const ANCHOR_CONTRACT = '0x75016F7ce345E0527d20B5E08f273E42886D35A5'
const CHAIN_ID = 16602

/** Must match TEST_ENV in the harness. */
const MASTER_SEED = 'a-test-master-seed-long-enough-to-be-accepted'

let phoneCounter = 0

/** Sign in as somebody new, and find out who they are. */
async function newUser(harness: Awaited<ReturnType<typeof startHarness>>) {
  phoneCounter += 1
  const phone = `+9198765${String(43000 + phoneCounter).padStart(5, '0')}`
  const { token } = await signIn(harness, phone)

  const [user] = await harness.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.phone, phone))
    .limit(1)

  return { token, userId: user!.id }
}

/** A relayer that records rather than submits, so nothing needs a chain. */
function fakeClient() {
  const submitted: Array<{ owner: string; signature: string }> = []
  const signedByUs: string[] = []

  return {
    submitted,
    signedByUs,
    relayerAddress: '0x0000000000000000000000000000000000000099',
    relayerBalance: async () => ethers.parseEther('1'),
    nonceUsed: async () => false,
    snapshotCount: async () => 0,
    submit: async (signed: { owner: string; signature: string }) => {
      submitted.push({ owner: signed.owner, signature: signed.signature })
      return { txHash: '0x' + 'ab'.repeat(32), index: 0, gasUsed: 1n }
    },
    // The path that signs with the master seed. For a self-custody user this
    // must never be reached; recording it is how we find out if it is.
    anchor: async (owner: { address: string }) => {
      signedByUs.push(owner.address)
      return { txHash: '0x' + 'cd'.repeat(32), index: 0, gasUsed: 1n }
    },
  }
}

test('a person can take custody, and we stop being able to sign for them', async () => {
  const harness = await startHarness()

  try {
    const { token, userId } = await newUser(harness)
    const { app, db } = harness

    // Custodial to begin with, which is the default and stays the default.
    const before = await app.inject({
      method: 'GET',
      url: '/users/me/custody',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(before.statusCode, 200)
    assert.equal(before.json().selfCustody, false)

    const custodialPubKey = await ensureRecordKey(db, MASTER_SEED, userId)

    // --- the device generates a key we never see ----------------------------

    const mine = createSelfCustodyKey()

    const taken = await app.inject({
      method: 'POST',
      url: '/users/me/custody',
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: mine.publicKey, address: mine.address },
    })

    assert.equal(taken.statusCode, 200)
    assert.equal(taken.json().selfCustody, true)
    assert.equal(taken.json().address, mine.address)

    // The stored key is theirs now, and is not the one we derived.
    const [row] = await db
      .select({
        recordPubKey: schema.users.recordPubKey,
        anchorAddress: schema.users.anchorAddress,
        custodyTakenAt: schema.users.custodyTakenAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))

    assert.equal(row!.recordPubKey, mine.publicKey)
    assert.equal(row!.anchorAddress, mine.address)
    assert.notEqual(row!.recordPubKey, custodialPubKey)
    assert.ok(row!.custodyTakenAt instanceof Date)

    // And the phrase is nowhere. This is the whole point: a server that has it
    // has taken custody back, however well-intentioned the reason.
    const stored = JSON.stringify(row)
    for (const word of mine.phrase.split(' ')) {
      assert.ok(!stored.includes(word), `the recovery phrase leaked into storage: ${word}`)
    }
    assert.ok(!stored.includes(mine.privateKey))
  } finally {
    await harness.close()
  }
})

test('the master seed no longer produces this person\'s key, so ensureRecordKey leaves it alone', async () => {
  const harness = await startHarness()

  try {
    const { token, userId } = await newUser(harness)
    const mine = createSelfCustodyKey()

    await harness.app.inject({
      method: 'POST',
      url: '/users/me/custody',
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: mine.publicKey, address: mine.address },
    })

    /*
     * `ensureRecordKey` normally refuses when the stored address disagrees with
     * what the seed derives — that check catches a rotated or mistyped seed.
     * Here disagreement is the intended state, and treating it as drift would
     * stop this person's records being written at all.
     */
    const key = await ensureRecordKey(harness.db, MASTER_SEED, userId)
    assert.equal(key, mine.publicKey, 'their key must be used for new records')
  } finally {
    await harness.close()
  }
})

test('a mismatched key and address is refused', async () => {
  const harness = await startHarness()

  try {
    const { token } = await newUser(harness)
    const mine = createSelfCustodyKey()
    const other = createSelfCustodyKey()

    const response = await harness.app.inject({
      method: 'POST',
      url: '/users/me/custody',
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: mine.publicKey, address: other.address },
    })

    // Accepting this would encrypt records to one account and anchor them to
    // another — unrecoverable by anybody, while every step reports success.
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'key_mismatch')
  } finally {
    await harness.close()
  }
})

test('taking custody twice is refused rather than silently orphaning the first key', async () => {
  const harness = await startHarness()

  try {
    const { token } = await newUser(harness)
    const first = createSelfCustodyKey()
    const second = createSelfCustodyKey()

    const take = (key: { publicKey: string; address: string }) =>
      harness.app.inject({
        method: 'POST',
        url: '/users/me/custody',
        headers: { authorization: `Bearer ${token}` },
        payload: { publicKey: key.publicKey, address: key.address },
      })

    assert.equal((await take(first)).statusCode, 200)

    const again = await take(second)
    assert.equal(again.statusCode, 409)
    assert.equal(again.json().error, 'already_self_custody')
  } finally {
    await harness.close()
  }
})

test('the anchor worker refuses to sign for somebody who took custody', async () => {
  const harness = await startHarness()

  try {
    const { token, userId } = await newUser(harness)
    const { db } = harness
    const mine = createSelfCustodyKey()

    await harness.app.inject({
      method: 'POST',
      url: '/users/me/custody',
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: mine.publicKey, address: mine.address },
    })

    const [snapshot] = await db
      .insert(schema.snapshots)
      .values({
        userId,
        rootHashes: ['0x' + '11'.repeat(32)],
        txHashes: ['0x' + '22'.repeat(32)],
        schemaVersion: 1,
        bytes: 512,
      })
      .returning({ id: schema.snapshots.id })

    const client = fakeClient()
    const worker = startAnchorWorker({
      db,
      client: client as never,
      masterSeed: MASTER_SEED,
      logger: quietLogger(),
    })
    worker.stop()

    const first = await worker.runOnce()

    // Waiting, not failed, and above all not signed by us.
    assert.equal(first.waiting, 1)
    assert.equal(first.anchored, 0)
    assert.equal(first.failed, 0)
    assert.equal(client.signedByUs.length, 0, 'we must not sign as an owner whose key we do not hold')
    assert.equal(client.submitted.length, 0)

    // --- their device signs -------------------------------------------------

    const wallet = new ethers.Wallet(mine.privateKey)
    const signed = await signAnchor(wallet, ANCHOR_CONTRACT, CHAIN_ID, {
      rootHashes: ['0x' + '11'.repeat(32)],
      schemaVersion: 1,
      nonce: BigInt('0x' + snapshot!.id.replaceAll('-', '')),
    })

    const posted = await harness.app.inject({
      method: 'POST',
      url: `/users/me/anchors/${snapshot!.id}/signature`,
      headers: { authorization: `Bearer ${token}` },
      payload: { signature: signed.signature, deadline: signed.deadline.toString() },
    })
    assert.equal(posted.statusCode, 200)

    const second = await worker.runOnce()

    // Now it anchors — with their signature, paid for by us, owned by them.
    assert.equal(second.anchored, 1)
    assert.equal(second.waiting, 0)
    assert.equal(client.submitted.length, 1)
    assert.equal(client.submitted[0]?.owner, mine.address)
    assert.equal(client.submitted[0]?.signature, signed.signature)
    assert.equal(client.signedByUs.length, 0, 'still never signed by us')
  } finally {
    await harness.close()
  }
})

test('a signature from the wrong key is refused before it can cost us a revert', async () => {
  const harness = await startHarness()

  try {
    const { token, userId } = await newUser(harness)
    const mine = createSelfCustodyKey()
    const impostor = createSelfCustodyKey()

    await harness.app.inject({
      method: 'POST',
      url: '/users/me/custody',
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: mine.publicKey, address: mine.address },
    })

    const [snapshot] = await harness.db
      .insert(schema.snapshots)
      .values({
        userId,
        rootHashes: ['0x' + '33'.repeat(32)],
        txHashes: ['0x' + '44'.repeat(32)],
        schemaVersion: 1,
        bytes: 128,
      })
      .returning({ id: schema.snapshots.id })

    const signed = await signAnchor(
      new ethers.Wallet(impostor.privateKey),
      ANCHOR_CONTRACT,
      CHAIN_ID,
      {
        rootHashes: ['0x' + '33'.repeat(32)],
        schemaVersion: 1,
        nonce: BigInt('0x' + snapshot!.id.replaceAll('-', '')),
      },
    )

    const response = await harness.app.inject({
      method: 'POST',
      url: `/users/me/anchors/${snapshot!.id}/signature`,
      headers: { authorization: `Bearer ${token}` },
      payload: { signature: signed.signature, deadline: signed.deadline.toString() },
    })

    // Caught here rather than on chain: the contract would revert and we would
    // pay for the revert, far from the cause.
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'wrong_signer')

    const [row] = await harness.db.select().from(schema.snapshots)
    assert.equal(row!.ownerSignature, null, 'nothing unverified may be stored')
  } finally {
    await harness.close()
  }
})

test('a custodial user is told there is nothing for them to sign', async () => {
  const harness = await startHarness()

  try {
    const { token } = await newUser(harness)

    const pending = await harness.app.inject({
      method: 'GET',
      url: '/users/me/anchors/pending',
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(pending.statusCode, 200)
    assert.deepEqual(pending.json().pending, [])
  } finally {
    await harness.close()
  }
})

function quietLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as never
}
