/**
 * The opt-in that takes us out of the middle.
 *
 * The property being tested is a negative one, and negatives are where security
 * claims usually turn out to be decoration: that holding the master seed — the
 * one secret that derives every custodial key — gets you nowhere near a key
 * somebody has taken custody of.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import {
  InvalidPhraseError,
  createSelfCustodyKey,
  fromPhrase,
  normalisePhrase,
  phraseMatchesAddress,
} from '../src/custody.ts'
import { deriveOwnerAccount, deriveRecordPublicKey } from '../src/anchor.ts'
import { publicKeyFor } from '../src/storage.ts'

const SEED = 'a-master-seed-long-enough-to-be-accepted'

test('a generated key is twelve standard words that any wallet can import', () => {
  const key = createSelfCustodyKey()

  assert.equal(key.phrase.split(' ').length, 12)
  assert.ok(ethers.Mnemonic.isValidMnemonic(key.phrase), 'must be a valid BIP-39 mnemonic')

  // The account is the one any other wallet reaches from the same words, on the
  // path every mainstream wallet uses. A cleverer path would mean the phrase
  // only works here, which would defeat using a standard at all.
  const elsewhere = ethers.HDNodeWallet.fromPhrase(key.phrase)
  assert.equal(elsewhere.address, key.address)
  assert.equal(elsewhere.privateKey, key.privateKey)
  assert.equal(key.publicKey, publicKeyFor(key.privateKey))
})

test('two generated keys are different', () => {
  // Cheap, and it is the failure that would silently hand everybody the same
  // key if the entropy source were ever stubbed out.
  const a = createSelfCustodyKey()
  const b = createSelfCustodyKey()
  assert.notEqual(a.phrase, b.phrase)
  assert.notEqual(a.address, b.address)
})

test('the master seed does not reach a key the user has taken custody of', () => {
  const userId = 'a3f1c2d4-0000-4000-8000-000000000001'
  const mine = createSelfCustodyKey()

  // Everything the server holds, used against the user's key.
  const custodial = deriveOwnerAccount(SEED, userId)
  const custodialRecord = deriveRecordPublicKey(SEED, userId)

  assert.notEqual(custodial.address, mine.address)
  assert.notEqual(custodialRecord, mine.publicKey)

  // And not by combining them either — the phrase is not a function of anything
  // we know, which is the whole point.
  for (const attempt of [
    `${SEED}:${userId}`,
    `${SEED}:${userId}:${mine.address}`,
    mine.address,
  ]) {
    const guess = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(attempt)))
    assert.notEqual(guess.address, mine.address)
  }
})

test('the phrase reproduces the key exactly, on any device', () => {
  const original = createSelfCustodyKey()
  const recovered = fromPhrase(original.phrase)

  assert.deepEqual(recovered, original)
})

test('a phrase written down by hand still works', () => {
  const key = createSelfCustodyKey()

  // Capitals, ragged spacing, a trailing newline. People write these on paper
  // and type them back; none of that should be an error.
  const messy = `  ${key.phrase.toUpperCase().split(' ').join('   ')}\n`
  assert.equal(normalisePhrase(messy), key.phrase)
  assert.equal(fromPhrase(messy).address, key.address)
})

test('a phrase that is not a phrase is refused, and says so usefully', () => {
  for (const bad of ['', 'not a real phrase at all', 'abandon abandon abandon']) {
    assert.throws(() => fromPhrase(bad), InvalidPhraseError)
  }

  // A valid wordlist with a broken checksum must fail too: BIP-39's checksum is
  // what catches a single mistyped word, and accepting it would send somebody
  // to a silently empty account.
  const key = createSelfCustodyKey()
  const words = key.phrase.split(' ')
  words[0] = words[0] === 'abandon' ? 'ability' : 'abandon'
  assert.throws(() => fromPhrase(words.join(' ')), InvalidPhraseError)
})

test('a stored address verifies a phrase without the server ever holding one', () => {
  const key = createSelfCustodyKey()
  const other = createSelfCustodyKey()

  assert.equal(phraseMatchesAddress(key.phrase, key.address), true)
  assert.equal(phraseMatchesAddress(other.phrase, key.address), false)
  assert.equal(phraseMatchesAddress('nonsense', key.address), false)

  // Case is not a difference: addresses arrive checksummed from some sources
  // and lowercased from others.
  assert.equal(phraseMatchesAddress(key.phrase, key.address.toLowerCase()), true)
})
