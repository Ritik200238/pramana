/**
 * The whole 0G pipeline, end to end, against the real thing.
 *
 * Every piece of this has been proved separately: the storage client against a
 * live indexer, the anchor and coach clients against the live chain, the
 * workers against a fake. What has never run is the sequence the product
 * actually performs — a person logs a meal, a scheduler notices they are due,
 * a snapshot is built from their real rows, encrypted, uploaded to 0G Storage,
 * anchored on 0G Chain, and their coach minted from what it has learned.
 *
 * That sequence is where the seams are. Each part working says nothing about
 * whether they hand off correctly, and the defects in this repository have
 * almost all lived in the handoffs rather than the parts.
 *
 * Real Postgres (PGlite), real 0G Storage, real 0G Chain. Only the model is a
 * stub, because reading a plate is a separate question with its own live test.
 *
 *   npm run test:pipeline -w @ogt/api
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { AnchorClient, CoachClient, NETWORKS, OGStorage, deriveOwnerAccount } from '@ogt/og'
import * as schema from '../../src/db/schema.ts'
import type { Database } from '../../src/db/index.ts'
import { runSnapshot } from '../../src/jobs/snapshot.ts'
import { startAnchorWorker } from '../../src/jobs/anchor.ts'
import { startCoachWorker } from '../../src/jobs/coach-brain.ts'
import { ensureRecordKey } from '../../src/services/record-key.ts'

const RELAYER = process.env['OG_STORAGE_PRIVATE_KEY']
const ANCHOR = process.env['OG_ANCHOR_ADDRESS']
const COACH = process.env['OG_COACH_ADDRESS']
const SEED = process.env['OG_ANCHOR_MASTER_SEED']

const ready = Boolean(RELAYER && ANCHOR && COACH && SEED)
const skip = ready ? false : 'needs a funded relayer, the deployed addresses and a master seed'

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'drizzle')

/** Quiet enough to read the assertions, loud enough to see a failure. */
const logger = {
  info: () => undefined,
  warn: (o: unknown, m?: string) => console.error('  warn:', m ?? o),
  error: (o: unknown, m?: string) => console.error('  error:', m ?? o, o),
} as never

async function freshDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const client = await PGlite.create()
  for (const file of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt.trim())
    }
  }
  return {
    db: drizzle(client, { schema }) as unknown as Database,
    close: () => client.close(),
  }
}

test('a meal becomes an encrypted record on 0G Storage, anchored on 0G Chain', { skip }, async () => {
  const { db, close } = await freshDatabase()

  try {
    // --- a person, with something worth storing -------------------------------

    const [user] = await db
      .insert(schema.users)
      .values({ phone: `+9199${Date.now().toString().slice(-8)}`, sex: 'male', ageYears: 28 })
      .returning({ id: schema.users.id })

    const userId = user!.id
    const recordPubKey = await ensureRecordKey(db, SEED!, userId)
    assert.match(recordPubKey, /^0x0[23][0-9a-f]{64}$/)

    await db.insert(schema.weightLogs).values({ userId, weightKg: 72 })
    await db.insert(schema.userFoods).values({
      userId,
      name: 'dal as they make it',
      normalisedName: 'dal as they make it',
      unit: 'katori',
      gramsPerUnit: 150,
      kcalPer100g: 120,
      proteinPer100g: 6,
      carbPer100g: 18,
      fatPer100g: 2,
    })

    // --- storage: the real indexer -------------------------------------------

    const storage = new OGStorage({
      network: NETWORKS.testnet,
      signerPrivateKey: RELAYER!,
    })

    const written = await runSnapshot({
      db,
      storage,
      userId,
      recordPubKey,
      from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      to: new Date(),
    })

    console.log(`  snapshot ${written.bytes} bytes -> ${written.rootHashes.join(', ')}`)
    assert.ok(written.rootHashes.length > 0, 'the snapshot must have a retrieval key')

    const [row] = await db.select().from(schema.snapshots)
    assert.ok(row, 'the snapshot must be recorded in the database')
    assert.deepEqual(row!.rootHashes, written.rootHashes)
    assert.equal(row!.anchorTxHash, null, 'not anchored yet')

    // --- chain: the real contract, through the worker -------------------------

    const anchorWorker = startAnchorWorker({
      db,
      client: new AnchorClient({
        rpcUrl: NETWORKS.testnet.rpcUrl,
        contractAddress: ANCHOR!,
        relayerPrivateKey: RELAYER!,
        chainId: NETWORKS.testnet.chainId,
      }),
      masterSeed: SEED!,
      logger,
    })
    anchorWorker.stop()

    const anchored = await anchorWorker.runOnce()
    console.log(`  anchor pass: ${JSON.stringify(anchored)}`)
    assert.equal(anchored.anchored, 1, 'the pending snapshot must be anchored')
    assert.equal(anchored.failed, 0)

    const [afterAnchor] = await db.select().from(schema.snapshots)
    assert.match(afterAnchor!.anchorTxHash ?? '', /^0x[0-9a-f]{64}$/, 'a real transaction hash')
    assert.equal(typeof afterAnchor!.anchorIndex, 'number')
    console.log(`  anchored in ${afterAnchor!.anchorTxHash} at index ${afterAnchor!.anchorIndex}`)

    // The record is owned by the person, on chain, verifiable independently.
    const owner = deriveOwnerAccount(SEED!, userId)
    const client = new AnchorClient({
      rpcUrl: NETWORKS.testnet.rpcUrl,
      contractAddress: ANCHOR!,
      relayerPrivateKey: RELAYER!,
      chainId: NETWORKS.testnet.chainId,
    })
    assert.equal(await client.snapshotCount(owner.address), 1)

    // --- the coach: minted from what it has learned ---------------------------

    const coachWorker = startCoachWorker({
      db,
      storage,
      client: new CoachClient({
        rpcUrl: NETWORKS.testnet.rpcUrl,
        contractAddress: COACH!,
        relayerPrivateKey: RELAYER!,
        chainId: NETWORKS.testnet.chainId,
      }),
      masterSeed: SEED!,
      logger,
    })
    coachWorker.stop()

    const minted = await coachWorker.runOnce()
    console.log(`  coach pass: ${JSON.stringify(minted)}`)
    assert.equal(minted.minted, 1, 'a coach must be minted for somebody who has taught it something')

    const [afterCoach] = await db
      .select({ tokenId: schema.users.coachTokenId, learned: schema.users.coachLearnedCount })
      .from(schema.users)

    assert.equal(typeof afterCoach!.tokenId, 'number', 'the token id must be recorded')
    assert.ok(afterCoach!.learned! > 0, 'and what it knows')
    console.log(`  coach token ${afterCoach!.tokenId}, knows ${afterCoach!.learned}`)

    // --- and the record still reads back --------------------------------------

    const recovered = await storage.getSnapshot<{ userId: string }>(
      written.rootHashes,
      owner.privateKey,
    )
    assert.equal(recovered.userId, userId, 'the record must decrypt with the user own key')
  } finally {
    await close()
  }
})
