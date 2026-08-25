/**
 * Moving a person's records out of our custody and into theirs.
 *
 * What we do by default is custodial: every user's key is derived from one
 * master seed we hold, which is what lets somebody with no wallet own a record
 * on chain at all. It is honest, it is better than the category — mainstream
 * nutrition apps keep this data in plaintext — and it is standard. It is not
 * novel and it is not the strongest thing available.
 *
 * The strongest thing available needs hardware. Signal's Secure Value Recovery
 * and WhatsApp's encrypted backups escrow keys inside enclaves so that a PIN is
 * enough to recover and the operator still cannot read anything. 0G's own
 * ERC-7857 describes a TEE oracle that would let us do the same, and today the
 * documentation ships a `MockOracle` with "replace with real oracle in
 * production" and no deployed address. Building on that now would be a claim,
 * not a mechanism.
 *
 * So this follows what Apple and Google actually ship: recoverable by default,
 * real custody as an opt-in. Advanced Data Protection is exactly this shape.
 *
 * The opt-in invents nothing. A standard BIP-39 phrase is generated on the
 * person's device; the account it produces becomes both the ECIES recipient for
 * their records and the owner of those records on chain. They can type that
 * phrase into any wallet and hold the same account. We keep the public key and
 * the address — enough to keep writing records they can read, and not enough to
 * read one ourselves.
 *
 * The consequence is deliberate and must not be softened anywhere in the
 * product: after this, we cannot sign for them either. Anchoring becomes
 * something their device does, which is what the relayed design was built to
 * make cheap.
 */

import { ethers } from 'ethers'
import { publicKeyFor } from './storage.ts'

/**
 * A person's own key, and the words that reproduce it.
 *
 * The phrase is the only copy. It is generated on the device, shown once, and
 * never sent to us — a server that receives it has taken custody back.
 */
export interface SelfCustodyKey {
  /** BIP-39, twelve words. Importable into any wallet. */
  phrase: string
  address: string
  publicKey: string
  privateKey: string
}

/** 128 bits, the standard twelve words. */
const ENTROPY_BYTES = 16

/**
 * Generate a key the user owns.
 *
 * Randomness comes from the platform's CSPRNG through ethers, so this is the
 * same generation path as any wallet the phrase can later be imported into.
 */
export function createSelfCustodyKey(): SelfCustodyKey {
  const mnemonic = ethers.Mnemonic.fromEntropy(ethers.randomBytes(ENTROPY_BYTES))
  return fromPhrase(mnemonic.phrase)
}

/**
 * Recover the key from the words.
 *
 * The derivation path is ethers' default, which is BIP-44 `m/44'/60'/0'/0/0` —
 * the path every mainstream wallet uses for the first account. Choosing
 * anything cleverer here would mean the phrase only works in our app, which
 * would defeat the point of using a standard at all.
 */
export function fromPhrase(phrase: string): SelfCustodyKey {
  const normalised = normalisePhrase(phrase)

  if (!ethers.Mnemonic.isValidMnemonic(normalised)) {
    throw new InvalidPhraseError()
  }

  const wallet = ethers.HDNodeWallet.fromPhrase(normalised)
  return {
    phrase: normalised,
    address: wallet.address,
    publicKey: publicKeyFor(wallet.privateKey),
    privateKey: wallet.privateKey,
  }
}

/**
 * People write these down and type them back with capitals, double spaces and
 * a trailing newline. None of that should be an error message.
 */
export function normalisePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ')
}

export class InvalidPhraseError extends Error {
  constructor() {
    // Says what to check without hinting at which word is wrong, since the
    // checksum covers the whole phrase and a per-word hint would be a lie.
    super('That recovery phrase is not valid. It should be twelve words, spelled as given.')
    this.name = 'InvalidPhraseError'
  }
}

/**
 * Whether a phrase is the one a stored address was derived from.
 *
 * This is how the server checks a person typed their phrase correctly without
 * ever holding it: the address is public, and re-deriving it proves the phrase
 * without revealing anything. Nothing derived from the phrase is stored, so
 * there is nothing to brute-force offline.
 */
export function phraseMatchesAddress(phrase: string, address: string): boolean {
  try {
    return fromPhrase(phrase).address.toLowerCase() === address.toLowerCase()
  } catch {
    return false
  }
}
