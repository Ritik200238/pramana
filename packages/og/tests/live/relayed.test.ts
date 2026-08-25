/**
 * The path the product actually uses, against the live chain.
 *
 * The contracts were exercised after deployment with `cast`, which calls
 * `anchorSnapshot` and `mintCoach` directly as the sender. That is not what the
 * application does. It derives an account for the user, signs EIP-712, and has
 * a relayer submit and pay — because the people this is built for hold no
 * wallet and cannot fund an address.
 *
 * That path was proved against a fork. The fork then turned out to be wrong
 * about something real: 0G enforces a minimum priority fee that anvil accepted
 * happily. So the relayed path is worth proving where it will actually run.
 *
 * Requires the deployed addresses and a funded relayer.
 *
 *   npm run test:relayed -w @ogt/og
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import { AnchorClient, CoachClient, brainMetadataHash, deriveOwnerAccount } from '../../src/index.ts'

const RPC = process.env['OG_RPC_URL_OVERRIDE'] ?? 'https://evmrpc-testnet.0g.ai'
const CHAIN_ID = 16602

const RELAYER = process.env['OG_STORAGE_PRIVATE_KEY']
const ANCHOR = process.env['OG_ANCHOR_ADDRESS']
const COACH = process.env['OG_COACH_ADDRESS']
const SEED = process.env['OG_ANCHOR_MASTER_SEED']

const ready = Boolean(RELAYER && ANCHOR && COACH && SEED)
const skip = ready ? false : 'needs a funded relayer and the deployed addresses'

/** A user who exists only for this run, so the nonce space is always fresh. */
function freshUser(): string {
  return `live-test-${ethers.hexlify(ethers.randomBytes(8))}`
}

test('an anchor signed by the owner is submitted and paid for by the relayer', { skip }, async () => {
  const client = new AnchorClient({
    rpcUrl: RPC,
    contractAddress: ANCHOR!,
    relayerPrivateKey: RELAYER!,
    chainId: CHAIN_ID,
  })

  const userId = freshUser()
  const owner = deriveOwnerAccount(SEED!, userId)

  /*
   * Measured before and after rather than asserted as zero.
   *
   * The relayer on this deployment is also the account that deployed the
   * contracts and anchored a snapshot by hand afterwards, so it legitimately
   * has a history. The property that matters is not that the payer owns
   * nothing — it is that paying for somebody else's anchor adds nothing to it.
   */
  const relayerBefore = await client.snapshotCount(client.relayerAddress)

  const result = await client.anchor(owner, {
    rootHashes: [ethers.keccak256(ethers.toUtf8Bytes(`snapshot-${userId}`))],
    schemaVersion: 1,
    nonce: 1n,
  })

  console.log(`  anchored in ${result.txHash}, ${result.gasUsed} gas`)
  console.log(`  owner ${owner.address}, relayer ${client.relayerAddress}`)

  assert.match(result.txHash, /^0x[0-9a-f]{64}$/)
  assert.equal(result.index, 0)

  // The whole argument for the relayed design: the record belongs to somebody
  // who never held a coin, and paying for it gives the payer no claim on it.
  assert.equal(await client.snapshotCount(owner.address), 1)
  assert.equal(await client.snapshotCount(client.relayerAddress), relayerBefore)
})

test('a coach minted this way belongs to the user, not the payer', { skip }, async () => {
  const client = new CoachClient({
    rpcUrl: RPC,
    contractAddress: COACH!,
    relayerPrivateKey: RELAYER!,
    chainId: CHAIN_ID,
  })

  const userId = freshUser()
  const owner = deriveOwnerAccount(SEED!, userId)

  const brain = JSON.stringify({ foods: ['dal as they make it'], learned: 2 })
  const result = await client.mint(owner, {
    rootHash: ethers.keccak256(ethers.toUtf8Bytes(`brain-${userId}`)),
    metadataHash: brainMetadataHash(brain),
    schemaVersion: 1,
    nonce: 1n,
  })

  console.log(`  minted token ${result.tokenId} in ${result.txHash}, ${result.gasUsed} gas`)

  assert.equal(await client.coachCount(owner.address), 1)
  assert.equal(await client.versionCount(result.tokenId), 1)
})

test('a spent nonce is refused by the live contract', { skip }, async () => {
  const client = new AnchorClient({
    rpcUrl: RPC,
    contractAddress: ANCHOR!,
    relayerPrivateKey: RELAYER!,
    chainId: CHAIN_ID,
  })

  const userId = freshUser()
  const owner = deriveOwnerAccount(SEED!, userId)
  const request = {
    rootHashes: [ethers.keccak256(ethers.toUtf8Bytes(`replay-${userId}`))],
    schemaVersion: 1,
    nonce: 7n,
  }

  await client.anchor(owner, request)
  assert.equal(await client.nonceUsed(owner.address, 7n), true)

  // This is what stops a retry after a lost receipt anchoring the same snapshot
  // twice, and it is worth confirming on the chain that will enforce it.
  await assert.rejects(() => client.anchor(owner, request))
})
