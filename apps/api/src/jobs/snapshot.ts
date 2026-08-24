/**
 * Nightly snapshot to 0G Storage, anchored on 0G Chain.
 *
 * This is the feature that genuinely needs 0G rather than merely running on it.
 * The user's record is ECIES-encrypted to their own public key, written to 0G
 * Storage, and the returned root hashes are anchored on chain by their own
 * address. The result is a health record that is portable, provably theirs, and
 * outlives this company.
 *
 * Two rules, both learned the expensive way by other people:
 *
 *   1. **Never write per meal.** Batched nightly. Per-event writes make cost and
 *      latency untenable and would put a chain in the middle of a camera shutter.
 *
 *   2. **The root hashes ARE the data.** Lose them and the ciphertext is
 *      unreachable. They are written to Postgres inside the same transaction
 *      that records the snapshot, anchored on chain, and included in every
 *      export the user takes.
 */

import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm'
import type { OGStorage } from '@ogt/og'
import type { Database } from '../db/index.ts'
import {
  chatMessages,
  lifeFacts,
  mealItems,
  meals,
  snapshots,
  users,
  weightLogs,
} from '../db/schema.ts'

/**
 * Payload schema version.
 *
 * Written into every snapshot and into the on-chain anchor so a reader years
 * from now can interpret an old payload without guessing. Bump on any breaking
 * change to the shape below.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1

export interface SnapshotPayload {
  schemaVersion: number
  userId: string
  generatedAt: string
  window: { from: string; to: string }
  profile: Record<string, unknown>
  meals: unknown[]
  weights: unknown[]
  facts: unknown[]
  chat: unknown[]
}

export interface BuildPayloadInput {
  db: Database
  userId: string
  from: Date
  to: Date
  now?: Date
}

/**
 * Assemble everything the user said and logged in the window.
 *
 * Deliberately includes the chat verbatim. The record is theirs, and a health
 * history missing the sentence "stomach's been off three days" is less useful
 * than one that keeps it.
 */
export async function buildPayload(input: BuildPayloadInput): Promise<SnapshotPayload> {
  const { db, userId, from, to } = input
  const now = input.now ?? new Date()

  const [profile] = await db
    .select({
      sex: users.sex,
      ageYears: users.ageYears,
      heightCm: users.heightCm,
      activity: users.activity,
      goal: users.goal,
      diet: users.diet,
      cooks: users.cooks,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const mealRows = await db
    .select()
    .from(meals)
    .where(and(eq(meals.userId, userId), gte(meals.eatenAt, from), lte(meals.eatenAt, to)))

  const mealIds = mealRows.map((meal) => meal.id)
  const itemRows =
    mealIds.length > 0
      ? await db.select().from(mealItems).where(inArray(mealItems.mealId, mealIds))
      : []

  const itemsByMeal = new Map<string, unknown[]>()
  for (const item of itemRows) {
    const list = itemsByMeal.get(item.mealId) ?? []
    list.push(item)
    itemsByMeal.set(item.mealId, list)
  }

  const weights = await db
    .select()
    .from(weightLogs)
    .where(
      and(eq(weightLogs.userId, userId), gte(weightLogs.recordedAt, from), lte(weightLogs.recordedAt, to)),
    )

  const facts = await db
    .select()
    .from(lifeFacts)
    .where(and(eq(lifeFacts.userId, userId), gte(lifeFacts.occurredAt, from), lte(lifeFacts.occurredAt, to)))

  const chat = await db
    .select()
    .from(chatMessages)
    .where(
      and(eq(chatMessages.userId, userId), gte(chatMessages.createdAt, from), lte(chatMessages.createdAt, to)),
    )

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    userId,
    generatedAt: now.toISOString(),
    window: { from: from.toISOString(), to: to.toISOString() },
    profile: profile ?? {},
    meals: mealRows.map((meal) => ({ ...meal, items: itemsByMeal.get(meal.id) ?? [] })),
    weights,
    facts,
    chat,
  }
}

export interface RunSnapshotInput {
  db: Database
  storage: OGStorage
  userId: string
  /** The user's compressed secp256k1 public key. The ciphertext is addressed to them. */
  recordPubKey: string
  from: Date
  to: Date
}

export interface RunSnapshotResult {
  snapshotId: string
  rootHashes: string[]
  bytes: number
  fragmented: boolean
}

/**
 * Build, encrypt, upload, and record one snapshot.
 *
 * The database row is written only after the upload returns root hashes. A row
 * claiming a snapshot exists when the bytes never landed would be worse than no
 * row at all, because it looks like a backup.
 */
export async function runSnapshot(input: RunSnapshotInput): Promise<RunSnapshotResult> {
  const payload = await buildPayload({
    db: input.db,
    userId: input.userId,
    from: input.from,
    to: input.to,
  })

  const uploaded = await input.storage.putSnapshot(payload, input.recordPubKey)

  const [row] = await input.db
    .insert(snapshots)
    .values({
      userId: input.userId,
      rootHashes: uploaded.rootHashes,
      txHashes: uploaded.txHashes,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      bytes: uploaded.bytes,
      fragmented: uploaded.fragmented,
    })
    .returning({ id: snapshots.id })

  if (!row) throw new Error('Snapshot uploaded but the record could not be saved')

  return {
    snapshotId: row.id,
    rootHashes: uploaded.rootHashes,
    bytes: uploaded.bytes,
    fragmented: uploaded.fragmented,
  }
}

