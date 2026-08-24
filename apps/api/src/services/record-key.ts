/**
 * The key a person's records are encrypted to.
 *
 * `users.record_pub_key` existed from the first migration and was never once
 * written. Every reference to it was a read or a filter, and both background
 * workers selected `WHERE record_pub_key IS NOT NULL` — so both found zero rows
 * for every user, forever.
 *
 * The effect was total and silent. No snapshot was ever built, so 0G Storage
 * never received a byte; the snapshots table stayed empty, so nothing was ever
 * anchored; and no coach was ever minted. Three of the four bindings to 0G were
 * inert for one hundred percent of users, and nothing logged a word about it,
 * because "no users are due" is indistinguishable from "everything is done".
 *
 * The fix is not only to populate the column. It is to stop a missing key being
 * able to silently empty a worker again: the queries no longer filter on it,
 * and the key is created on demand where it is needed.
 */

import { eq } from 'drizzle-orm'
import { deriveRecordPublicKey } from '@ogt/og'
import type { Database } from '../db/index.ts'
import { users } from '../db/schema.ts'

/**
 * Return this user's record public key, creating it if it does not exist.
 *
 * Derived rather than generated, so it is identical on every call and can be
 * recomputed from one backed-up secret. The same account owns the record on
 * chain — see `deriveRecordPublicKey` for why those are deliberately one key.
 */
export async function ensureRecordKey(
  db: Database,
  masterSeed: string,
  userId: string,
): Promise<string> {
  const [existing] = await db
    .select({ recordPubKey: users.recordPubKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (existing?.recordPubKey) return existing.recordPubKey

  const recordPubKey = deriveRecordPublicKey(masterSeed, userId)

  // Stored rather than derived on every read so the export endpoint can show a
  // person the key their record is addressed to without holding the seed.
  await db
    .update(users)
    .set({ recordPubKey, updatedAt: new Date() })
    .where(eq(users.id, userId))

  return recordPubKey
}
