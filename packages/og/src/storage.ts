/**
 * 0G Storage — the user-owned, encrypted health record.
 *
 * API verified against the SDK source in `oglabs resources/0g-storage-ts-sdk`:
 *   - `new Indexer(indexerUrl)`
 *   - `new MemData(bytes)` for in-memory payloads (we never touch the filesystem)
 *   - `indexer.upload(file, rpcUrl, signer, { encryption }) -> [tx, err]`
 *   - `indexer.downloadToBlob(rootHash, { proof, decryption }) -> [blob, err]`
 *   - `EncryptionOption = { type:'aes256', key } | { type:'ecies', recipientPubKey }`
 *
 * Two design rules that are not negotiable:
 *
 *   1. **Never write per-meal.** Snapshots are batched nightly. Per-event writes
 *      would make both cost and latency untenable, and the UI must never block
 *      on storage - Postgres is the hot path.
 *
 *   2. **The root hash is the retrieval key.** Lose it and the data is
 *      unreachable, encrypted or not. Every root hash is persisted alongside
 *      the snapshot and included in the user's export.
 */

import { ethers } from 'ethers'
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk'

export interface NetworkConfig {
  readonly name: 'testnet' | 'mainnet'
  readonly chainId: number
  readonly rpcUrl: string
  readonly indexerUrl: string
  readonly explorerUrl: string
}

/**
 * Canonical values from `0g-doc/docs/ai-context.md`.
 *
 * Galileo is chain 16602. Several older docs and deployment scripts still say
 * 16601 - they are stale. The public RPCs below are development endpoints; a
 * third-party RPC (Ankr, dRPC) belongs in production.
 */
export const NETWORKS = {
  testnet: {
    name: 'testnet',
    chainId: 16602,
    rpcUrl: 'https://evmrpc-testnet.0g.ai',
    indexerUrl: 'https://indexer-storage-testnet-turbo.0g.ai',
    explorerUrl: 'https://chainscan-galileo.0g.ai',
  },
  mainnet: {
    name: 'mainnet',
    chainId: 16661,
    rpcUrl: 'https://evmrpc.0g.ai',
    indexerUrl: 'https://indexer-storage-turbo.0g.ai',
    explorerUrl: 'https://chainscan.0g.ai',
  },
} as const satisfies Record<string, NetworkConfig>

export interface StorageConfig {
  network: NetworkConfig
  /** Backend-held key that pays for storage. The user never holds a wallet. */
  signerPrivateKey: string
  /** Override the RPC, e.g. to use a production third-party endpoint. */
  rpcUrlOverride?: string
}

export interface SnapshotResult {
  /**
   * The retrieval keys. Persist these or the data is gone.
   *
   * Usually one. The SDK fragments large payloads, and a fragmented upload
   * returns an ordered list that must be passed back to `downloadToBlob`
   * intact - dropping any of them loses the snapshot as surely as losing all
   * of them, so this is always a list rather than a single hash.
   */
  rootHashes: string[]
  txHashes: string[]
  explorerUrls: string[]
  bytes: number
  fragmented: boolean
}

export class OGStorage {
  private readonly indexer: Indexer
  private readonly signer: ethers.Wallet
  private readonly rpcUrl: string
  private readonly network: NetworkConfig

  constructor(config: StorageConfig) {
    this.network = config.network
    this.rpcUrl = config.rpcUrlOverride ?? config.network.rpcUrl
    const provider = new ethers.JsonRpcProvider(this.rpcUrl)
    this.signer = new ethers.Wallet(config.signerPrivateKey, provider)
    this.indexer = new Indexer(config.network.indexerUrl)
  }

  /**
   * Upload an encrypted snapshot of a user's record.
   *
   * ECIES encrypts to the user's own public key, so the ciphertext is
   * addressed to them rather than to us. That is what makes "your record,
   * not ours" a technical statement instead of a policy one.
   */
  async putSnapshot(payload: unknown, recipientPubKey: string): Promise<SnapshotResult> {
    const json = JSON.stringify(payload)
    const bytes = new TextEncoder().encode(json)
    const file = new MemData(bytes)

    const [tx, err] = await this.indexer.upload(file, this.rpcUrl, this.signer, {
      encryption: { type: 'ecies', recipientPubKey },
      finalityRequired: true,
    })

    if (err !== null) {
      throw new Error(`0G Storage upload failed: ${err.message}`)
    }
    if (tx === null) {
      throw new Error('0G Storage upload returned no result; the snapshot is unrecoverable.')
    }

    // The SDK returns a single-fragment shape or a multi-fragment one.
    const fragmented = 'rootHashes' in tx
    const rootHashes = fragmented ? tx.rootHashes : [tx.rootHash]
    const txHashes = fragmented ? tx.txHashes : [tx.txHash]

    if (rootHashes.length === 0 || rootHashes.some((h) => !h)) {
      throw new Error('0G Storage upload returned an empty root hash; refusing to record it.')
    }

    return {
      rootHashes,
      txHashes,
      explorerUrls: txHashes.filter(Boolean).map((h) => `${this.network.explorerUrl}/tx/${h}`),
      bytes: bytes.length,
      fragmented,
    }
  }

  /**
   * Retrieve and decrypt a snapshot.
   *
   * Pass every root hash from the upload, in order. The private key belongs to
   * the user and stays with the caller - we never persist it.
   */
  async getSnapshot<T>(rootHashes: readonly string[], privateKey: string): Promise<T> {
    if (rootHashes.length === 0) {
      throw new Error('At least one root hash is required to retrieve a snapshot.')
    }

    /*
     * `proof: true` is not optional for this payload, whatever the SDK default.
     *
     * It turns on Merkle proof verification, and the documentation names the
     * case directly: "Enable proof verification for sensitive files." A health
     * record is the most sensitive file this product has.
     *
     * The reason it matters more than it looks: the payload is encrypted in
     * counter mode, which is malleable. A storage node returning altered
     * ciphertext does not produce a decryption error — it produces altered
     * plaintext. Flipped bits become flipped bits in somebody's medical
     * history, and nothing downstream would notice, because there is no
     * authentication tag to fail. The Merkle proof is the check that catches
     * it.
     *
     * The extra work costs nothing that matters here: snapshots are restored
     * rarely, and never on a path a user is waiting on.
     */
    const options = { proof: true, decryption: { privateKey } } as const

    // The overloads are distinct: one string, or an array of them.
    const [blob, err] =
      rootHashes.length === 1
        ? await this.indexer.downloadToBlob(rootHashes[0]!, options)
        : await this.indexer.downloadToBlob([...rootHashes], options)

    if (err !== null) {
      throw new Error(`0G Storage download failed: ${err.message}`)
    }

    const text = await blob.text()
    return JSON.parse(text) as T
  }

  /** The address funding storage. Useful for balance alerts before writes fail. */
  get signerAddress(): string {
    return this.signer.address
  }
}

/** Derive the compressed secp256k1 public key ECIES encrypts to. */
export function publicKeyFor(privateKey: string): string {
  return ethers.SigningKey.computePublicKey(new ethers.Wallet(privateKey).signingKey.publicKey, true)
}
