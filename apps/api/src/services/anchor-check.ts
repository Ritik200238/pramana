/**
 * Checking our own database against the chain.
 *
 * The product's claim is that a record is a timeline nobody can rewrite. What
 * makes that true is not the writing — it is somebody comparing what is served
 * against what was anchored. Until this existed, nobody did.
 *
 * The restore path read root hashes out of our own `snapshots` table and asked
 * 0G Storage to verify the downloaded bytes against them. That catches a
 * storage node returning altered ciphertext, which matters — the payload is
 * encrypted in counter mode and has no authentication tag, so altered
 * ciphertext decrypts to altered plaintext rather than failing. What it cannot
 * catch is the row. Change `root_hashes` in our database and the Merkle proof
 * still passes, because it verifies against the hash it was handed.
 *
 * So this reads the anchor back and compares. It is a small function and it is
 * the difference between an anchor that proves something and an anchor that is
 * decoration on our own reads.
 *
 * Deliberately not fatal by itself: the caller decides what a mismatch means.
 * A mismatch on an export is worth refusing over; a mismatch found while
 * sweeping is worth an alert and a look, not an outage.
 */

import type { AnchorClient } from '@ogt/og'

export type AnchorCheck =
  | { status: 'verified'; index: number }
  /** Anchored, and what the chain holds is not what we hold. */
  | { status: 'mismatch'; index: number; onChain: string[]; inDatabase: string[] }
  /** Not anchored yet, which is normal for a recent snapshot. */
  | { status: 'not-anchored' }
  /** The chain could not be reached. Absence of proof, not proof of absence. */
  | { status: 'unavailable'; reason: string }

export interface CheckInput {
  client: AnchorClient
  /** The account that owns the record on chain. */
  owner: string
  /** The index recorded when we anchored it. */
  anchorIndex: number | null
  /** What our database says the snapshot is. */
  rootHashes: string[]
}

/** Case- and order-insensitive: a hash is a hash however it was written down. */
function sameHashes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const normalise = (list: readonly string[]) =>
    [...list].map((hash) => hash.toLowerCase()).sort()

  const left = normalise(a)
  const right = normalise(b)
  return left.every((hash, index) => hash === right[index])
}

export async function checkAnchor(input: CheckInput): Promise<AnchorCheck> {
  if (input.anchorIndex === null) return { status: 'not-anchored' }

  let onChain: { rootHashes: string[] }
  try {
    onChain = await input.client.snapshotAt(input.owner, input.anchorIndex)
  } catch (error) {
    /*
     * An unreachable RPC is not a tampered record, and reporting it as one
     * would turn every network blip into an accusation. Said plainly instead,
     * so the caller can decide.
     */
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'could not reach the chain',
    }
  }

  if (!sameHashes(onChain.rootHashes, input.rootHashes)) {
    return {
      status: 'mismatch',
      index: input.anchorIndex,
      onChain: onChain.rootHashes,
      inDatabase: input.rootHashes,
    }
  }

  return { status: 'verified', index: input.anchorIndex }
}
