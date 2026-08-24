/**
 * Anchoring, against a real chain.
 *
 * The Foundry suite proves the contract behaves. This proves the *client*
 * does — that the EIP-712 domain, the type string, and the way the root-hash
 * array is hashed all agree with what the contract computes. Those three are
 * exactly the places where a signing implementation goes wrong, and every one
 * of them fails identically: the contract reports an invalid signature, which
 * looks the same as an attack.
 *
 * Requires anvil on PATH. It forks live 0G Galileo, so the chain id, the EVM
 * configuration and the gas are real; only the funds are not.
 *
 *   npm run test:fork -w @ogt/og
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { ethers } from 'ethers'
import { AnchorClient, deriveOwnerAccount, signAnchor } from '../../src/anchor.ts'
import { CoachClient, brainMetadataHash } from '../../src/coach-agent.ts'

const PORT = 8547
const RPC = `http://127.0.0.1:${PORT}`
const UPSTREAM = 'https://evmrpc-testnet.0g.ai'
const CHAIN_ID = 16602

/** Anvil's published development key. Worthless on any real network. */
const RELAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

let anvil: ChildProcess | null = null
let contractAddress = ''
let coachAddress = ''

/** Compiled by `forge build`; read rather than duplicated here. */
async function deployedBytecode(
  name = 'HealthRecordAnchor',
): Promise<{ abi: unknown[]; bytecode: string }> {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = fileURLToPath(
    new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url),
  )
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as {
    abi: unknown[]
    bytecode: { object: string }
  }
  return { abi: artifact.abi, bytecode: artifact.bytecode.object }
}

before(async () => {
  anvil = spawn('anvil', ['--fork-url', UPSTREAM, '--port', String(PORT), '--silent'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await provider.getBlockNumber()
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  const { abi, bytecode } = await deployedBytecode()
  const deployer = new ethers.Wallet(RELAYER_KEY, provider)
  const factory = new ethers.ContractFactory(abi as ethers.InterfaceAbi, bytecode, deployer)
  const contract = await factory.deploy(deployer.address)
  await contract.waitForDeployment()
  contractAddress = await contract.getAddress()

  const coachArtifact = await deployedBytecode('CoachAgent')
  const coachFactory = new ethers.ContractFactory(
    coachArtifact.abi as ethers.InterfaceAbi,
    coachArtifact.bytecode,
    deployer,
  )
  // No oracle: sealed-key transfers stay disabled rather than accepting
  // unverified proofs, which is the right default before a verifier exists.
  const coachContract = await coachFactory.deploy(deployer.address, ethers.ZeroAddress)
  await coachContract.waitForDeployment()
  coachAddress = await coachContract.getAddress()
})

after(async () => {
  anvil?.kill()
})

test('the fork really is 0G, not a default local chain', async () => {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true })
  const network = await provider.getNetwork()
  assert.equal(Number(network.chainId), CHAIN_ID)
})

test('a signature made by the client is accepted by the contract', async () => {
  const client = new AnchorClient({
    rpcUrl: RPC,
    contractAddress,
    relayerPrivateKey: RELAYER_KEY,
    chainId: CHAIN_ID,
  })

  const owner = deriveOwnerAccount('a-master-seed-long-enough-to-be-accepted', 'user-1')
  const result = await client.anchor(owner, {
    rootHashes: [ethers.keccak256(ethers.toUtf8Bytes('snapshot-one'))],
    schemaVersion: 1,
    nonce: 1n,
  })

  // If the domain, the type string, or the array hashing disagreed with the
  // contract by one byte, this would have reverted as an invalid signature.
  assert.match(result.txHash, /^0x[0-9a-f]{64}$/)
  assert.equal(result.index, 0)
  assert.ok(result.gasUsed > 0n)

  assert.equal(await client.snapshotCount(owner.address), 1)
})

test('the record belongs to the signer, never to whoever paid', async () => {
  const client = new AnchorClient({
    rpcUrl: RPC,
    contractAddress,
    relayerPrivateKey: RELAYER_KEY,
    chainId: CHAIN_ID,
  })

  const owner = deriveOwnerAccount('a-master-seed-long-enough-to-be-accepted', 'user-2')
  await client.anchor(owner, {
    rootHashes: [ethers.keccak256(ethers.toUtf8Bytes('snapshot-two'))],
    schemaVersion: 1,
    nonce: 1n,
  })

  assert.equal(await client.snapshotCount(owner.address), 1)
  // The whole point of paying on somebody's behalf.
  assert.equal(await client.snapshotCount(client.relayerAddress), 0)
})

test('a fragmented snapshot anchors as one entry', async () => {
  const client = new AnchorClient({
    rpcUrl: RPC,
    contractAddress,
    relayerPrivateKey: RELAYER_KEY,
    chainId: CHAIN_ID,
  })

  const owner = deriveOwnerAccount('a-master-seed-long-enough-to-be-accepted', 'user-3')
  const fragments = ['a', 'b', 'c'].map((part) =>
    ethers.keccak256(ethers.toUtf8Bytes(`fragment-${part}`)),
  )

  // A large record is split across several storage uploads. The order matters,
  // and hashing the concatenation is what commits to it.
  const result = await client.anchor(owner, {
    rootHashes: fragments,
    schemaVersion: 1,
    nonce: 1n,
  })
  assert.equal(result.index, 0)
  assert.equal(await client.snapshotCount(owner.address), 1)
})

test('a spent nonce is visible before wasting a transaction on it', async () => {
  const client = new AnchorClient({
    rpcUrl: RPC,
    contractAddress,
    relayerPrivateKey: RELAYER_KEY,
    chainId: CHAIN_ID,
  })

  const owner = deriveOwnerAccount('a-master-seed-long-enough-to-be-accepted', 'user-4')
  assert.equal(await client.nonceUsed(owner.address, 9n), false)

  await client.anchor(owner, {
    rootHashes: [ethers.keccak256(ethers.toUtf8Bytes('snapshot-four'))],
    schemaVersion: 1,
    nonce: 9n,
  })

  assert.equal(await client.nonceUsed(owner.address, 9n), true)
})

test('the relayer cannot alter what the owner signed', async () => {
  const client = new AnchorClient({
    rpcUrl: RPC,
    contractAddress,
    relayerPrivateKey: RELAYER_KEY,
    chainId: CHAIN_ID,
  })

  const owner = deriveOwnerAccount('a-master-seed-long-enough-to-be-accepted', 'user-5')
  const signed = await signAnchor(owner, contractAddress, CHAIN_ID, {
    rootHashes: [ethers.keccak256(ethers.toUtf8Bytes('what the user wrote'))],
    schemaVersion: 1,
    nonce: 1n,
  })

  // Asserted against the deployed contract rather than only in Foundry,
  // because this is the property the whole custody argument rests on.
  await assert.rejects(
    client.submit({
      ...signed,
      rootHashes: [ethers.keccak256(ethers.toUtf8Bytes('what the relayer prefers'))],
    }),
  )
})

test('derivation is deterministic, and distinct per user', () => {
  const seed = 'a-master-seed-long-enough-to-be-accepted'

  // Stable across restarts is what makes this recoverable from one secret
  // instead of a per-user key store that can be lost.
  assert.equal(
    deriveOwnerAccount(seed, 'user-1').address,
    deriveOwnerAccount(seed, 'user-1').address,
  )
  assert.notEqual(
    deriveOwnerAccount(seed, 'user-1').address,
    deriveOwnerAccount(seed, 'user-2').address,
  )
  assert.notEqual(
    deriveOwnerAccount(seed, 'user-1').address,
    deriveOwnerAccount(`${seed}-different`, 'user-1').address,
  )
})

test('a short master seed is refused', () => {
  assert.throws(() => deriveOwnerAccount('too-short', 'user-1'), /at least 32/)
})

// ----------------------------------------------------------------- the coach

function coachClient(): CoachClient {
  return new CoachClient({
    rpcUrl: RPC,
    contractAddress: coachAddress,
    relayerPrivateKey: RELAYER_KEY,
    chainId: CHAIN_ID,
  })
}

test('a coach is minted to the user, paid for by the relayer', async () => {
  const client = coachClient()
  const owner = deriveOwnerAccount('a-master-seed-long-enough-to-be-accepted', 'coach-user-1')

  const brain = JSON.stringify({ foods: ['dal as they make it'], facts: ['lactose intolerant'] })
  const result = await client.mint(owner, {
    rootHash: ethers.keccak256(ethers.toUtf8Bytes('brain-root')),
    metadataHash: brainMetadataHash(brain),
    schemaVersion: 1,
    nonce: 1n,
  })

  assert.match(result.txHash, /^0x[0-9a-f]{64}$/)
  // The whole claim: the coach belongs to the person, not to whoever paid.
  assert.equal(await client.coachCount(owner.address), 1)
  assert.equal(await client.coachCount(client.relayerAddress), 0)
  assert.equal(await client.versionCount(result.tokenId), 1)
})

test('the brain evolves, and the history keeps every version', async () => {
  const client = coachClient()
  const owner = deriveOwnerAccount('a-master-seed-long-enough-to-be-accepted', 'coach-user-2')

  const minted = await client.mint(owner, {
    rootHash: ethers.keccak256(ethers.toUtf8Bytes('brain-v1')),
    metadataHash: brainMetadataHash('{"learned":10}'),
    schemaVersion: 1,
    nonce: 1n,
  })

  const evolved = await client.evolve(owner, {
    tokenId: minted.tokenId,
    rootHash: ethers.keccak256(ethers.toUtf8Bytes('brain-v2')),
    metadataHash: brainMetadataHash('{"learned":340}'),
    learnedCount: 340,
    nonce: 2n,
  })

  assert.equal(evolved.version, 1)
  // "My coach has learned 340 things" has to be checkable against a chain,
  // not a number rendered from our own database.
  assert.equal(await client.versionCount(minted.tokenId), 2)
})

test('a mint nonce cannot be spent twice', async () => {
  const client = coachClient()
  const owner = deriveOwnerAccount('a-master-seed-long-enough-to-be-accepted', 'coach-user-3')

  const input = {
    rootHash: ethers.keccak256(ethers.toUtf8Bytes('brain')),
    metadataHash: brainMetadataHash('{}'),
    schemaVersion: 1,
    nonce: 99n,
  }

  await client.mint(owner, input)
  assert.equal(await client.nonceUsed(owner.address, 99n), true)

  // This is what stops a retry after a lost receipt minting a second coach.
  await assert.rejects(client.mint(owner, input))
  assert.equal(await client.coachCount(owner.address), 1)
})

test('the metadata hash commits to the exact brain', () => {
  // If a storage provider returned different bytes at the same address, this
  // is the value that would no longer match.
  const brain = '{"foods":["poha"],"learned":1}'
  assert.equal(brainMetadataHash(brain), brainMetadataHash(brain))
  assert.notEqual(brainMetadataHash(brain), brainMetadataHash(`${brain} `))
})
