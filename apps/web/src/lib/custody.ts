/**
 * Holding your own key, on the device.
 *
 * Everything here runs in the browser and nothing here is ever sent to us. The
 * phrase is generated on the device, kept on the device, and used on the device
 * to sign. The server learns the public key and the address, which is enough to
 * keep writing records you can read and not enough to read one.
 *
 * ethers is loaded on demand rather than imported at the top. It is a large
 * dependency and most people will never take custody; making everybody download
 * it to open a nutrition app — on a connection where that download is a real
 * cost — to support a setting they will not use would be the wrong trade.
 */

const PHRASE_KEY = 'ogt:custody-phrase'

/** Loaded once, then reused. */
let ethersModule: typeof import('ethers') | null = null

async function ethers(): Promise<typeof import('ethers')> {
  ethersModule ??= await import('ethers')
  return ethersModule
}

export interface DeviceKey {
  phrase: string
  address: string
  publicKey: string
}

/**
 * Make a key for this person.
 *
 * Standard BIP-39 on the standard path, so the same twelve words open the same
 * account in any wallet. That is the point: what they are given has to be worth
 * something outside this app, or "you own it" is just our word again.
 */
export async function createKey(): Promise<DeviceKey> {
  const e = await ethers()

  /*
   * The platform CSPRNG directly, rather than the library's wrapper.
   *
   * It is the same source of randomness in a browser, and it is unambiguously a
   * Uint8Array belonging to this realm. The wrapper can hand back a Buffer from
   * another realm — which `fromEntropy` rejects outright — and the failure
   * looks like a broken device rather than a type mismatch.
   */
  const entropy = new Uint8Array(16)
  crypto.getRandomValues(entropy)

  const mnemonic = e.Mnemonic.fromEntropy(entropy)
  return fromPhrase(mnemonic.phrase)
}

export async function fromPhrase(phrase: string): Promise<DeviceKey> {
  const e = await ethers()
  const normalised = phrase.trim().toLowerCase().split(/\s+/).join(' ')

  if (!e.Mnemonic.isValidMnemonic(normalised)) {
    throw new Error('That recovery phrase is not valid. It should be twelve words, as given.')
  }

  const wallet = e.HDNodeWallet.fromPhrase(normalised)
  return {
    phrase: normalised,
    address: wallet.address,
    publicKey: e.SigningKey.computePublicKey(wallet.privateKey, true),
  }
}

/**
 * Keep the phrase on this device so anchoring can continue without asking for
 * it every time.
 *
 * This is the honest trade and it is stated plainly in the interface: somebody
 * with this unlocked device can read the phrase. The alternative — prompting on
 * every background signature — is the kind of security that gets turned off.
 * The phrase is also shown once for them to write down, because a device is a
 * thing that gets lost.
 */
export function rememberPhrase(phrase: string): void {
  try {
    localStorage.setItem(PHRASE_KEY, phrase)
  } catch {
    // Private windows and blocked site data. Signing still works this session;
    // it will ask again next time.
  }
}

export function rememberedPhrase(): string | null {
  try {
    return localStorage.getItem(PHRASE_KEY)
  } catch {
    return null
  }
}

export function forgetPhrase(): void {
  try {
    localStorage.removeItem(PHRASE_KEY)
  } catch {
    // Nothing to clear.
  }
}

export interface PendingAnchor {
  id: string
  rootHashes: string[]
  schemaVersion: number
  nonce: string
  signed: boolean
}

/** Fifteen minutes, matching SIGNATURE_TTL_SECONDS in packages/og. */
const TTL_SECONDS = 15 * 60

/**
 * Sign one pending anchor as its owner.
 *
 * The struct is `AnchorSnapshot` and the domain names the contract. Both have to
 * match what the contract verifies exactly; getting the struct name wrong once
 * already produced signatures that looked like forgeries.
 */
export async function signAnchor(
  phrase: string,
  contract: string,
  chainId: number,
  anchor: PendingAnchor,
): Promise<{ signature: string; deadline: string }> {
  const e = await ethers()
  const wallet = e.HDNodeWallet.fromPhrase(phrase.trim().toLowerCase().split(/\s+/).join(' '))
  const deadline = BigInt(Math.floor(Date.now() / 1000) + TTL_SECONDS)

  const signature = await wallet.signTypedData(
    { name: 'HealthRecordAnchor', version: '1', chainId, verifyingContract: contract },
    {
      AnchorSnapshot: [
        { name: 'rootHashesHash', type: 'bytes32' },
        { name: 'schemaVersion', type: 'uint32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    {
      rootHashesHash: e.keccak256(e.concat(anchor.rootHashes)),
      schemaVersion: anchor.schemaVersion,
      nonce: BigInt(anchor.nonce),
      deadline,
    },
  )

  return { signature, deadline: deadline.toString() }
}
