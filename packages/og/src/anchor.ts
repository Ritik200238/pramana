/**
 * On-chain anchoring.
 *
 * This is the piece that was missing. `HealthRecordAnchor` existed, the deploy
 * script existed, the database carried `anchor_tx_hash` and `anchor_index`
 * columns, and a query called `findPendingAnchors` existed to find snapshots
 * needing one — and nothing ever called it. There was no path from the running
 * product to the chain at all, so "the user owns the pointer" was a property of
 * a contract nobody could reach.
 *
 * Two problems had to be solved to reach it, and they pull against each other.
 *
 * The contract only ever writes to `msg.sender` or to an account that signed
 * for it, deliberately: a backend that can anchor on your behalf can also
 * anchor something you did not author. But the people this product is for sign
 * in with a phone number and a six-digit code and do not hold a wallet, so
 * requiring the owner to send the transaction meant every user needed a funded
 * address first — which is why, in practice, nobody ever anchored.
 *
 * The relayed path separates the two: the owner signs, anyone may pay. What
 * remains is who holds the owner's key, and that is a custody decision this
 * module makes explicit rather than hides. See `deriveOwnerAccount`.
 */

import { ethers } from 'ethers'
import { publicKeyFor } from './storage.ts'

/** Only what is called here. A full ABI would be noise. */
export const ANCHOR_ABI = [
  'function anchorSnapshot(bytes32[] rootHashes, uint32 schemaVersion) returns (uint256)',
  'function anchorSnapshotFor(address owner, bytes32[] rootHashes, uint32 schemaVersion, uint256 nonce, uint256 deadline, bytes signature) returns (uint256)',
  'function nonceUsed(address owner, uint256 nonce) view returns (bool)',
  'function snapshotCount(address owner) view returns (uint256)',
  'function snapshotAt(address owner, uint256 index) view returns (bytes32[] rootHashes, uint32 schemaVersion, uint64 createdAt)',
  'event SnapshotAnchored(address indexed owner, uint256 indexed index, bytes32 indexed firstRootHash, uint256 fragmentCount, uint32 schemaVersion)',
] as const

const EIP712_TYPES = {
  AnchorSnapshot: [
    { name: 'rootHashesHash', type: 'bytes32' },
    { name: 'schemaVersion', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/** How long a signature stays good. Long enough to survive a retry, not a day. */
export const SIGNATURE_TTL_SECONDS = 15 * 60

/**
 * The account that owns a user's record.
 *
 * Derived deterministically from a master seed and the user's id, so it is
 * stable across restarts, needs no per-user key storage, and can be recomputed
 * from a backup of one secret.
 *
 * **This is custodial, and that is a real limitation, not a technicality.**
 * Whoever holds the master seed can sign for any user, which means the on-chain
 * guarantee against *us* is weaker than the guarantee against everyone else.
 * What the anchor still provides is worth having — an append-only public
 * timeline nobody can rewrite, a record that outlives the company, and a
 * pointer the user can take elsewhere — but "we cannot write your record" is
 * not among it, and no documentation should say otherwise.
 *
 * The relayed path exists partly to make the fix cheap later: moving the key
 * into the user's own device changes who calls `signAnchor` and nothing else.
 */
export function deriveOwnerAccount(masterSeed: string, userId: string): ethers.Wallet {
  if (masterSeed.length < 32) {
    throw new Error('The anchor master seed must be at least 32 characters')
  }

  // keccak over seed and id gives a uniformly distributed key without an HD
  // path, whose 31-bit indices would collide across a large user base.
  const key = ethers.keccak256(ethers.toUtf8Bytes(`${masterSeed}:${userId}`))
  return new ethers.Wallet(key)
}

/**
 * The public key a user's records are encrypted to.
 *
 * The same derived account serves both roles on purpose: it is the ECIES
 * recipient for the ciphertext in 0G Storage, and the owner of the record on
 * chain. One key per person is easier to reason about, easier to hand over if
 * custody ever moves to the user, and removes a whole class of bug where the
 * thing that can decrypt a record is not the thing that owns it.
 */
export function deriveRecordPublicKey(masterSeed: string, userId: string): string {
  return publicKeyFor(deriveOwnerAccount(masterSeed, userId).privateKey)
}

export interface AnchorRequest {
  rootHashes: readonly string[]
  schemaVersion: number
  /** Single-use. The snapshot's own id maps to one naturally. */
  nonce: bigint
}

/**
 * Recover the address that signed an anchor.
 *
 * Lives here, beside `signAnchor`, on purpose. The server verifies signatures
 * produced by a person's own device, and the moment verification keeps its own
 * copy of the domain and the type definition, the two drift — which is the
 * defect that has accounted for most of the bugs in this repository, and here
 * it would reject every honest signature while looking like a forgery.
 *
 * The type is `AnchorSnapshot`, not `Anchor`; writing it out by hand somewhere
 * else got that wrong immediately.
 */
export function recoverAnchorSigner(
  contractAddress: string,
  chainId: number,
  signed: Omit<SignedAnchor, 'owner'>,
): string {
  return ethers.verifyTypedData(
    {
      name: 'HealthRecordAnchor',
      version: '1',
      chainId,
      verifyingContract: contractAddress,
    },
    EIP712_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
    {
      rootHashesHash: ethers.keccak256(ethers.concat(signed.rootHashes as string[])),
      schemaVersion: signed.schemaVersion,
      nonce: signed.nonce,
      deadline: signed.deadline,
    },
    signed.signature,
  )
}

export interface SignedAnchor extends AnchorRequest {
  owner: string
  deadline: bigint
  signature: string
}

/**
 * Sign an anchor as the record's owner.
 *
 * Separated from submission on purpose: this is the step that must move to the
 * user's device to make the system non-custodial, and it is the only step that
 * needs the owner's key.
 */
export async function signAnchor(
  wallet: ethers.Wallet,
  contractAddress: string,
  chainId: number,
  request: AnchorRequest,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SignedAnchor> {
  const deadline = BigInt(nowSeconds + SIGNATURE_TTL_SECONDS)

  const signature = await wallet.signTypedData(
    {
      name: 'HealthRecordAnchor',
      version: '1',
      chainId,
      verifyingContract: contractAddress,
    },
    EIP712_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
    {
      // The contract hashes the array the same way; a mismatch here would look
      // exactly like a forged signature.
      rootHashesHash: ethers.keccak256(ethers.concat(request.rootHashes as string[])),
      schemaVersion: request.schemaVersion,
      nonce: request.nonce,
      deadline,
    },
  )

  return { ...request, owner: wallet.address, deadline, signature }
}

export interface AnchorResult {
  txHash: string
  index: number
  /** What the relayer paid, in wei. Worth recording; this is a running cost. */
  gasUsed: bigint
}

export interface AnchorClientConfig {
  rpcUrl: string
  contractAddress: string
  /** Pays gas. Holds no authority over any record. */
  relayerPrivateKey: string
  chainId: number
}

/**
 * Submits owner-signed anchors and pays for them.
 *
 * The relayer is deliberately powerless: it can decline to submit, and that is
 * the whole of its authority. It cannot author a signature, redirect one to
 * another account, alter what it says, replay it, or extend its deadline —
 * each of which is asserted by a test against the contract.
 */
export class AnchorClient {
  readonly relayerAddress: string
  private readonly contract: ethers.Contract
  private readonly provider: ethers.JsonRpcProvider
  private readonly chainId: number
  private readonly contractAddress: string

  constructor(config: AnchorClientConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId, {
      staticNetwork: true,
    })
    const relayer = new ethers.Wallet(config.relayerPrivateKey, this.provider)
    this.relayerAddress = relayer.address
    this.chainId = config.chainId
    this.contractAddress = config.contractAddress
    this.contract = new ethers.Contract(config.contractAddress, ANCHOR_ABI, relayer)
  }

  /**
   * Read one anchored snapshot back off the chain.
   *
   * This is the half that makes anchoring mean anything. Writing a root hash to
   * a public chain proves nothing on its own — somebody has to compare it
   * against what is being served, and until this existed nobody did. Our own
   * restore path read root hashes out of our own database and verified the
   * downloaded bytes against those, which catches a storage node returning
   * altered ciphertext and catches nothing at all about the row itself.
   */
  async snapshotAt(
    owner: string,
    index: number,
  ): Promise<{ rootHashes: string[]; schemaVersion: number; createdAt: number }> {
    const result = (await this.contract['snapshotAt']!(owner, index)) as [
      string[],
      bigint,
      bigint,
    ]

    return {
      rootHashes: [...result[0]],
      schemaVersion: Number(result[1]),
      createdAt: Number(result[2]),
    }
  }

  /** Has this nonce already been spent? Cheaper than a reverted transaction. */
  async nonceUsed(owner: string, nonce: bigint): Promise<boolean> {
    return (await this.contract['nonceUsed']!(owner, nonce)) as boolean
  }

  async snapshotCount(owner: string): Promise<number> {
    return Number((await this.contract['snapshotCount']!(owner)) as bigint)
  }

  /** Sign as the owner and submit as the relayer. */
  async anchor(owner: ethers.Wallet, request: AnchorRequest): Promise<AnchorResult> {
    const signed = await signAnchor(owner, this.contractAddress, this.chainId, request)
    return this.submit(signed)
  }

  /** Submit an anchor somebody else signed. The only step that costs money. */
  async submit(signed: SignedAnchor): Promise<AnchorResult> {
    const tx = (await this.contract['anchorSnapshotFor']!(
      signed.owner,
      signed.rootHashes,
      signed.schemaVersion,
      signed.nonce,
      signed.deadline,
      signed.signature,
    )) as ethers.ContractTransactionResponse

    const receipt = await tx.wait()
    if (!receipt) throw new Error('anchor transaction produced no receipt')

    // The index comes from the event rather than the return value, because a
    // transaction's return value is not available to a caller once mined.
    let index = -1
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log)
        if (parsed?.name === 'SnapshotAnchored') {
          index = Number(parsed.args['index'] as bigint)
          break
        }
      } catch {
        // A log from another contract in the same transaction. Not ours.
      }
    }

    if (index < 0) throw new Error('anchor mined without a SnapshotAnchored event')

    return { txHash: receipt.hash, index, gasUsed: receipt.gasUsed }
  }

  /** What the relayer has left to spend. Zero means anchoring has stopped. */
  async relayerBalance(): Promise<bigint> {
    return this.provider.getBalance(this.relayerAddress)
  }
}
