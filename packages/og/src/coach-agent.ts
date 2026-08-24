/**
 * The coach, as a thing a person owns.
 *
 * `CoachAgent` was written, tested to full coverage, and referenced by nothing
 * outside its own test file. Zero call sites in the running product. So of the
 * four bindings that were meant to make 0G impossible to remove — compute,
 * storage, identity, payments — identity was a contract nobody could reach, and
 * "you own your coach" was a sentence rather than a mechanism.
 *
 * What is owned is the *brain*: the accumulated result of every correction and
 * every answered question — the dishes as this person actually cooks them, the
 * portions as they actually eat them, the constraints they only had to say
 * once. That is the thing worth owning, because it is the thing that would be
 * lost by starting over somewhere else, and it is what makes leaving expensive
 * in the only way that is fair to a user: the value stays theirs.
 *
 * The brain ciphertext lives in 0G Storage. Only its root hash and a commitment
 * to the plaintext go on chain — the same discipline as the health record. What
 * is public is that a coach exists, who owns it, and how much it has learned.
 */

import { ethers } from 'ethers'

export const COACH_ABI = [
  'function mintCoachFor(address owner, bytes32 rootHash, bytes32 metadataHash, uint32 schemaVersion, uint256 nonce, uint256 deadline, bytes signature) returns (uint256)',
  'function evolveFor(address owner, uint256 tokenId, bytes32 rootHash, bytes32 metadataHash, uint32 learnedCount, uint256 nonce, uint256 deadline, bytes signature) returns (uint256)',
  'function nonceUsed(address owner, uint256 nonce) view returns (bool)',
  'function versionCount(uint256 tokenId) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'event CoachMinted(address indexed owner, uint256 indexed tokenId, bytes32 indexed rootHash, uint32 schemaVersion)',
  'event BrainEvolved(uint256 indexed tokenId, uint256 indexed version, bytes32 indexed rootHash, uint32 learnedCount)',
] as const

const MINT_TYPES = {
  MintCoach: [
    { name: 'rootHash', type: 'bytes32' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'schemaVersion', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const EVOLVE_TYPES = {
  Evolve: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'rootHash', type: 'bytes32' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'learnedCount', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const COACH_SIGNATURE_TTL_SECONDS = 15 * 60

export interface CoachClientConfig {
  rpcUrl: string
  contractAddress: string
  /** Pays gas. Owns nothing and can author nothing. */
  relayerPrivateKey: string
  chainId: number
}

export interface MintResult {
  tokenId: number
  txHash: string
  gasUsed: bigint
}

export interface EvolveResult {
  version: number
  txHash: string
  gasUsed: bigint
}

export class CoachClient {
  readonly relayerAddress: string
  private readonly contract: ethers.Contract
  private readonly provider: ethers.JsonRpcProvider
  private readonly chainId: number
  private readonly contractAddress: string

  constructor(config: CoachClientConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId, {
      staticNetwork: true,
    })
    const relayer = new ethers.Wallet(config.relayerPrivateKey, this.provider)
    this.relayerAddress = relayer.address
    this.chainId = config.chainId
    this.contractAddress = config.contractAddress
    this.contract = new ethers.Contract(config.contractAddress, COACH_ABI, relayer)
  }

  private domain() {
    return {
      name: 'CoachAgent',
      version: '1',
      chainId: this.chainId,
      verifyingContract: this.contractAddress,
    }
  }

  async nonceUsed(owner: string, nonce: bigint): Promise<boolean> {
    return (await this.contract['nonceUsed']!(owner, nonce)) as boolean
  }

  /** How many coaches this account owns. Used to avoid minting a second one. */
  async coachCount(owner: string): Promise<number> {
    return Number((await this.contract['balanceOf']!(owner)) as bigint)
  }

  async versionCount(tokenId: number): Promise<number> {
    return Number((await this.contract['versionCount']!(tokenId)) as bigint)
  }

  /** Mint a coach the owner signed for, paid for by the relayer. */
  async mint(
    owner: ethers.Wallet,
    input: { rootHash: string; metadataHash: string; schemaVersion: number; nonce: bigint },
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): Promise<MintResult> {
    const deadline = BigInt(nowSeconds + COACH_SIGNATURE_TTL_SECONDS)

    const signature = await owner.signTypedData(
      this.domain(),
      MINT_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
      { ...input, deadline },
    )

    const tx = (await this.contract['mintCoachFor']!(
      owner.address,
      input.rootHash,
      input.metadataHash,
      input.schemaVersion,
      input.nonce,
      deadline,
      signature,
    )) as ethers.ContractTransactionResponse

    const receipt = await tx.wait()
    if (!receipt) throw new Error('mint produced no receipt')

    const tokenId = this.readEvent(receipt, 'CoachMinted', 'tokenId')
    return { tokenId, txHash: receipt.hash, gasUsed: receipt.gasUsed }
  }

  /** Record that the coach has learned more. */
  async evolve(
    owner: ethers.Wallet,
    input: {
      tokenId: number
      rootHash: string
      metadataHash: string
      learnedCount: number
      nonce: bigint
    },
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): Promise<EvolveResult> {
    const deadline = BigInt(nowSeconds + COACH_SIGNATURE_TTL_SECONDS)

    const signature = await owner.signTypedData(
      this.domain(),
      EVOLVE_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
      { ...input, deadline },
    )

    const tx = (await this.contract['evolveFor']!(
      owner.address,
      input.tokenId,
      input.rootHash,
      input.metadataHash,
      input.learnedCount,
      input.nonce,
      deadline,
      signature,
    )) as ethers.ContractTransactionResponse

    const receipt = await tx.wait()
    if (!receipt) throw new Error('evolve produced no receipt')

    const version = this.readEvent(receipt, 'BrainEvolved', 'version')
    return { version, txHash: receipt.hash, gasUsed: receipt.gasUsed }
  }

  async relayerBalance(): Promise<bigint> {
    return this.provider.getBalance(this.relayerAddress)
  }

  /**
   * Pull a number out of one of our own events.
   *
   * A transaction's return value is unavailable once mined, so the token id and
   * version have to come from the log.
   */
  private readEvent(receipt: ethers.ContractTransactionReceipt, name: string, field: string): number {
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log)
        if (parsed?.name === name) return Number(parsed.args[field] as bigint)
      } catch {
        // A log from a different contract in the same transaction.
      }
    }
    throw new Error(`transaction mined without a ${name} event`)
  }
}

/**
 * A commitment to the brain's plaintext.
 *
 * Kept separate from the storage root hash because they answer different
 * questions: the root hash says where the ciphertext is, and this says what it
 * should decrypt to. Without the second, a storage provider could hand back
 * different bytes at the same address and nothing on chain would notice.
 */
export function brainMetadataHash(plaintext: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(plaintext))
}
