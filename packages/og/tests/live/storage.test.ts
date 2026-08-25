/**
 * A real record, written to 0G Storage and read back.
 *
 * Everything else about storage has been proved without a network: the ECIES
 * round trip against the SDK's own primitives, the key format, the fragment
 * offsets. What none of that could show is whether a live indexer accepts what
 * we upload and returns the same bytes.
 *
 * This is the one gap in the storage story that needed funds, and it needs very
 * little: a snapshot is a few kilobytes.
 *
 * Requires a funded OG_STORAGE_PRIVATE_KEY. Without one every case skips
 * loudly, because a suite that goes green having done nothing is worse than one
 * that fails.
 *
 *   npm run test:storage -w @ogt/og
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import { NETWORKS, OGStorage, publicKeyFor } from '../../src/index.ts'

const KEY = process.env['OG_STORAGE_PRIVATE_KEY']
const CONFIGURED = typeof KEY === 'string' && /^0x[0-9a-fA-F]{64}$/.test(KEY)

const skip = CONFIGURED ? false : 'no OG_STORAGE_PRIVATE_KEY — see the header of this file'

/** Shaped like a real snapshot, including text that breaks naive encoders. */
function snapshot(marker: string) {
  return {
    schemaVersion: 1,
    marker,
    generatedAt: new Date(0).toISOString(),
    meals: [
      { name: 'दाल चावल', kcal: 420, proteinG: 14 },
      { name: 'roti with ghee', kcal: 180, proteinG: 5 },
    ],
    facts: ['lactose intolerant', 'fasts on Tuesdays'],
  }
}

function storage(): OGStorage {
  return new OGStorage({ network: NETWORKS.testnet, signerPrivateKey: KEY! })
}

test('the signer that pays for storage has funds', { skip }, async () => {
  const provider = new ethers.JsonRpcProvider(NETWORKS.testnet.rpcUrl, NETWORKS.testnet.chainId, {
    staticNetwork: true,
  })
  const balance = await provider.getBalance(new ethers.Wallet(KEY!).address)

  // A zero balance fails every upload with an error about funds rather than
  // about storage, which sends somebody debugging the wrong layer.
  assert.ok(balance > 0n, 'fund the storage signer before running this')
})

test('a record survives a round trip through 0G Storage', { skip }, async () => {
  const store = storage()

  // Encrypted to a key we hold for this test only; production derives one per
  // user from the master seed.
  const owner = ethers.Wallet.createRandom()
  const recipientPubKey = publicKeyFor(owner.privateKey)

  const marker = `round-trip-${Date.now()}`
  const original = snapshot(marker)

  const written = await store.putSnapshot(original, recipientPubKey)

  assert.ok(written.rootHashes.length > 0, 'an upload must return a retrieval key')
  assert.ok(written.bytes > 0)
  console.log(`  uploaded ${written.bytes} bytes as ${written.rootHashes.join(', ')}`)
  console.log(`  tx ${written.txHashes.join(', ')}`)

  const recovered = await store.getSnapshot<typeof original>(
    written.rootHashes,
    owner.privateKey,
  )

  // Byte-for-byte, including the Devanagari. Anything less and a record written
  // today is not the record read back next year.
  assert.deepEqual(recovered, original)
  assert.equal(recovered.marker, marker)
})

test('the ciphertext is not readable with the wrong key', { skip }, async () => {
  const store = storage()

  const owner = ethers.Wallet.createRandom()
  const intruder = ethers.Wallet.createRandom()

  const original = snapshot(`isolation-${Date.now()}`)
  const written = await store.putSnapshot(original, publicKeyFor(owner.privateKey))

  // Per-user keys are the reason a storage breach is not a data breach, and
  // this is that claim against a live indexer rather than against a fixture.
  await assert.rejects(
    () => store.getSnapshot(written.rootHashes, intruder.privateKey),
    'somebody else key must not decrypt this record',
  )
})
