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
import { deriveOwnerAccount, deriveRecordPublicKey } from '@ogt/og'
import type { Database } from '../db/index.ts'
import { users } from '../db/schema.ts'

/**
 * Return this user's record public key, creating it if it does not exist.
 *
 * Derived rather than generated, so it is identical on every call and can be
 * recomputed from one backed-up secret. The same account owns the record on
 * chain — see `deriveRecordPublicKey` for why those are deliberately one key.
 */
export class SeedDriftError extends Error {
  constructor(userId: string, stored: string, derived: string) {
    super(
      `The anchor master seed no longer derives this user's account. Stored ${stored}, ` +
        `derived ${derived} for user ${userId}. Refusing to write a record they could ` +
        'not read. Restore the original seed, or migrate existing records deliberately.',
    )
    this.name = 'SeedDriftError'
  }
}

export async function ensureRecordKey(
  db: Database,
  masterSeed: string,
  userId: string,
): Promise<string> {
  const [existing] = await db
    .select({ recordPubKey: users.recordPubKey, anchorAddress: users.anchorAddress })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const anchorAddress = deriveOwnerAccount(masterSeed, userId).address

  /*
   * A changed seed is caught here rather than discovered later.
   *
   * Everything about a user's record — the key it is encrypted to and the
   * account that owns it on chain — is derived from one secret. If that secret
   * is rotated, retyped with a typo, or restored from the wrong backup, every
   * derivation silently moves: new records get encrypted to a key the user's
   * old records were not, and anchored to an address that owns none of their
   * history. Nothing would fail. The data would simply stop being theirs.
   *
   * The stored address is the witness that makes that detectable, which is the
   * whole reason to keep a value we could otherwise recompute.
   */
  if (existing?.anchorAddress && existing.anchorAddress !== anchorAddress) {
    throw new SeedDriftError(userId, existing.anchorAddress, anchorAddress)
  }

  if (existing?.recordPubKey && existing.anchorAddress) return existing.recordPubKey

  const recordPubKey = existing?.recordPubKey ?? deriveRecordPublicKey(masterSeed, userId)

  // Stored rather than derived on every read, so the export and proof surfaces
  // can show a person their own key and address without holding the seed.
  await db
    .update(users)
    .set({ recordPubKey, anchorAddress, updatedAt: new Date() })
    .where(eq(users.id, userId))

  return recordPubKey
}
