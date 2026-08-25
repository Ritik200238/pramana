/**
 * Comparing our own database against the chain.
 *
 * The product says a record is a timeline nobody can rewrite. Writing a root
 * hash to a public chain does not make that true — somebody comparing what is
 * served against what was anchored makes it true, and until this existed
 * nobody did.
 *
 * The gap was specific and easy to miss. The restore path read root hashes out
 * of our `snapshots` table and had 0G Storage verify the downloaded bytes
 * against them. That catches a storage node returning altered ciphertext, which
 * genuinely matters here: the payload is counter-mode encrypted with no
 * authentication tag, so altered ciphertext decrypts to altered plaintext
 * rather than failing. What it cannot catch is a changed row — the Merkle proof
 * verifies against whichever hash it was handed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAnchor } from '../src/services/anchor-check.ts'

const OWNER = '0x00000000000000000000000000000000000000aa'
const HASH_A = '0x' + '11'.repeat(32)
const HASH_B = '0x' + '22'.repeat(32)

/** A chain that answers with whatever it was given. */
function chain(rootHashes: string[] | Error) {
  return {
    snapshotAt: async () => {
      if (rootHashes instanceof Error) throw rootHashes
      return { rootHashes, schemaVersion: 1, createdAt: 0 }
    },
  } as never
}

test('a row that matches the chain is verified', async () => {
  const result = await checkAnchor({
    client: chain([HASH_A, HASH_B]),
    owner: OWNER,
    anchorIndex: 0,
    rootHashes: [HASH_A, HASH_B],
  })

  assert.deepEqual(result, { status: 'verified', index: 0 })
})

test('a row the chain disagrees with is a mismatch, with both sides reported', async () => {
  /*
   * The case the whole thing exists for. Somebody with write access to our
   * database points a snapshot at different bytes; the download succeeds, the
   * Merkle proof passes against the hash it was handed, and nothing downstream
   * notices. This is what notices.
   */
  const result = await checkAnchor({
    client: chain([HASH_A]),
    owner: OWNER,
    anchorIndex: 3,
    rootHashes: [HASH_B],
  })

  assert.equal(result.status, 'mismatch')
  assert.deepEqual(result, {
    status: 'mismatch',
    index: 3,
    onChain: [HASH_A],
    // Both sides, because whoever reads this needs to see what changed rather
    // than be told that something did.
    inDatabase: [HASH_B],
  })
})

test('a hash is a hash however it was written down', async () => {
  // Checksummed on one side, lowercase on the other, and stored in a different
  // order after a fragmented upload. None of that is tampering.
  const result = await checkAnchor({
    client: chain([HASH_A.toUpperCase().replace('0X', '0x'), HASH_B]),
    owner: OWNER,
    anchorIndex: 0,
    rootHashes: [HASH_B, HASH_A],
  })

  assert.equal(result.status, 'verified')
})

test('a missing hash is a mismatch, not a partial match', async () => {
  // The chain has two, we have one of them. Treating a subset as agreement
  // would let half a record be dropped silently.
  const result = await checkAnchor({
    client: chain([HASH_A, HASH_B]),
    owner: OWNER,
    anchorIndex: 0,
    rootHashes: [HASH_A],
  })

  assert.equal(result.status, 'mismatch')
})

test('extra hashes in our row are a mismatch, in both directions', async () => {
  /*
   * Both directions, because they fail differently and only one of them is
   * caught by comparing element by element.
   *
   * The chain having more than us trips the first differing element. Us having
   * more than the chain does not — every hash the chain holds matches, and the
   * extra one is simply never reached. Without an explicit length check that
   * reads as agreement, which is the direction an attacker would choose: append
   * a root hash pointing at bytes they control and have it verify.
   */
  const weHaveMore = await checkAnchor({
    client: chain([HASH_A]),
    owner: OWNER,
    anchorIndex: 0,
    rootHashes: [HASH_A, HASH_B],
  })
  assert.equal(weHaveMore.status, 'mismatch', 'an appended hash must not verify')

  const chainHasMore = await checkAnchor({
    client: chain([HASH_A, HASH_B]),
    owner: OWNER,
    anchorIndex: 0,
    rootHashes: [HASH_A],
  })
  assert.equal(chainHasMore.status, 'mismatch', 'a dropped hash must not verify')
})

test('a snapshot not yet anchored is not an accusation', async () => {
  // Normal for anything recent, and for everyone in self-custody who has not
  // opened the app since. Reporting it as a failure would make the check
  // useless by crying wolf constantly.
  const result = await checkAnchor({
    client: chain([HASH_A]),
    owner: OWNER,
    anchorIndex: null,
    rootHashes: [HASH_A],
  })

  assert.deepEqual(result, { status: 'not-anchored' })
})

test('an unreachable chain is reported as unknown, never as verified', async () => {
  const result = await checkAnchor({
    client: chain(new Error('RPC timeout')),
    owner: OWNER,
    anchorIndex: 0,
    rootHashes: [HASH_A],
  })

  /*
   * Absence of proof is not proof of absence, and it is certainly not proof of
   * agreement. Returning "verified" when the chain could not be reached would
   * make every network blip look like a guarantee.
   */
  assert.equal(result.status, 'unavailable')
  assert.match((result as { reason: string }).reason, /RPC timeout/)
})

test('the export carries what somebody needs to repeat this check', async () => {
  /*
   * The defect this whole file exists to close was not a wrong function — it
   * was a correct one nobody called, and an export that named a transaction
   * hash but not the index it was written at, so the comparison could not be
   * repeated by the person holding the file.
   *
   * Asserted against the route's source, because that is where it would
   * silently go away again.
   */
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'routes', 'export.ts'),
    'utf8',
  )

  assert.match(source, /checkAnchor\(/, 'the export must actually run the check')
  assert.match(source, /anchorIndex: snap\.anchorIndex/, 'and hand over the index')
  assert.match(source, /anchorOwner/, 'and the account that owns the anchors')

  // And the server has to give it a client, or every export reports
  // "unavailable" forever while looking wired.
  const server = readFileSync(join(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8')
  assert.match(server, /anchorClient: new AnchorClient/)
})
