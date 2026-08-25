/**
 * The key material itself, in a real JavaScript environment.
 *
 * Deliberately not under jsdom. ethers' Node build produces Buffers that fail
 * its own cross-realm `instanceof Uint8Array` checks once jsdom has replaced the
 * globals, so key generation throws there for reasons that have nothing to do
 * with this code — verified by running exactly this file's code both ways. The
 * component tests therefore work against a fixture, and the cryptography is
 * proved here, where it can be proved honestly.
 *
 * What matters is that the phrase this device generates is a real BIP-39 phrase
 * on the standard path — so it opens the same account in any wallet — and that
 * a signature it produces is one the contract will accept.
 */

import { describe, expect, test } from 'vitest'
import { HDNodeWallet, verifyTypedData } from 'ethers'
import { createKey, fromPhrase, signAnchor } from '../src/lib/custody.ts'

/** Publicly known, deliberately: it is the standard test mnemonic. */
const KNOWN_PHRASE = 'test test test test test test test test test test test junk'
const KNOWN_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('custody keys', () => {
  test('a generated key is twelve real words on the standard path', async () => {
    const key = await createKey()

    expect(key.phrase.split(' ')).toHaveLength(12)
    expect(key.publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/i)

    // The account any other wallet reaches from the same words. If this ever
    // stops being true, the phrase becomes worthless outside this app and the
    // promise it carries becomes our word again.
    expect(HDNodeWallet.fromPhrase(key.phrase).address).toBe(key.address)
  })

  test('two keys are never the same', async () => {
    const [a, b] = await Promise.all([createKey(), createKey()])
    expect(a.phrase).not.toBe(b.phrase)
  })

  test('the standard test phrase reaches the address every tool agrees on', async () => {
    // A fixed vector, so a change in derivation path shows up as a failing test
    // rather than as somebody's records becoming unreachable.
    const key = await fromPhrase(KNOWN_PHRASE)
    expect(key.address).toBe(KNOWN_ADDRESS)
  })

  test('a phrase typed back by hand still works', async () => {
    const key = await fromPhrase(`  ${KNOWN_PHRASE.toUpperCase()}  `)
    expect(key.address).toBe(KNOWN_ADDRESS)
  })

  test('a phrase with a mistyped word is refused rather than silently wrong', async () => {
    // BIP-39's checksum is what catches one wrong word. Accepting it would send
    // somebody to an account that is real, empty, and not theirs.
    await expect(fromPhrase('test test test test test test test test test test test test'))
      .rejects.toThrow(/not valid/)
  })

  test('a signature it produces is one the contract would accept', async () => {
    const contract = '0x75016F7ce345E0527d20B5E08f273E42886D35A5'
    const chainId = 16602
    const anchor = {
      id: 'x',
      rootHashes: ['0x' + '11'.repeat(32)],
      schemaVersion: 1,
      nonce: '42',
      signed: false,
    }

    const { signature, deadline } = await signAnchor(KNOWN_PHRASE, contract, chainId, anchor)

    /*
     * Verified with the same domain and struct the contract uses. The struct is
     * `AnchorSnapshot`; naming it `Anchor` in a second place already produced
     * signatures that verified as somebody else entirely, so this recomputes it
     * independently rather than trusting the signer.
     */
    const recovered = verifyTypedData(
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
        rootHashesHash: (await import('ethers')).keccak256(
          (await import('ethers')).concat(anchor.rootHashes),
        ),
        schemaVersion: anchor.schemaVersion,
        nonce: BigInt(anchor.nonce),
        deadline: BigInt(deadline),
      },
      signature,
    )

    expect(recovered).toBe(KNOWN_ADDRESS)
  })
})
