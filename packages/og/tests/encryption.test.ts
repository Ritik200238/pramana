/**
 * Can a record we store actually be read back?
 *
 * This is the quietest way this product could fail. Snapshots are ECIES
 * encrypted to a key derived per user and written to 0G Storage; if that key is
 * the wrong shape, or derived differently on the way in than on the way out,
 * every upload still succeeds. Storage reports success, the anchor records a
 * root hash, the dashboard looks healthy — and the ciphertext is permanently
 * unreadable. Nobody finds out until somebody asks for their data back, by
 * which time months of records are gone.
 *
 * Nothing about that needs a funded key or a live indexer to check. The SDK
 * exposes the same ECIES primitives its upload path uses, so the whole round
 * trip can be proved here with real cryptography: derive as production derives,
 * encrypt as the SDK encrypts, decrypt with the matching private key, and
 * compare bytes.
 *
 * What this does not prove is that a live indexer stores and returns those
 * bytes unchanged. That still needs credentials. It does prove that when the
 * bytes come back, they will decrypt.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ECIES_VERSION,
  cryptAt,
  deriveEciesDecryptKey,
  newEciesHeader,
  normalizePrivKey,
  normalizePubKey,
  parseEncryptionHeader,
} from '@0gfoundation/0g-storage-ts-sdk'
import { deriveOwnerAccount, deriveRecordPublicKey } from '../src/anchor.ts'
import { publicKeyFor } from '../src/storage.ts'

const SEED = 'a-master-seed-long-enough-to-be-accepted-by-derivation'

/** A snapshot shaped like a real one, including characters that break naive encoders. */
const PAYLOAD = JSON.stringify({
  schemaVersion: 1,
  userId: '9f1c2b4e-0000-4000-8000-000000000001',
  meals: [
    { name: 'दाल चावल', kcal: 420, proteinG: 14 },
    { name: 'roti with ghee', kcal: 180, proteinG: 5 },
  ],
  facts: ['lactose intolerant', 'fasts on Tuesdays'],
})

/** Encrypt exactly the way the SDK's upload path does. */
function encryptFor(recipientPub: string, plaintext: string) {
  const { header, key } = newEciesHeader(recipientPub)
  const bytes = new TextEncoder().encode(plaintext)
  const ciphertext = new Uint8Array(bytes)
  cryptAt(key, header.nonce, 0, ciphertext)
  return { header, ciphertext }
}

test('our derived public key is the shape the SDK expects', () => {
  const wallet = deriveOwnerAccount(SEED, 'user-1')
  const pub = publicKeyFor(wallet.privateKey)

  // Compressed secp256k1: 33 bytes, leading 0x02 or 0x03. A mismatch here is
  // the failure that would encrypt every record to something unrecoverable.
  assert.match(pub, /^0x0[23][0-9a-f]{64}$/)

  const normalised = normalizePubKey(pub)
  assert.equal(normalised.length, 33, 'the SDK must accept it without reinterpretation')

  // And the key the rest of the system stores is the same one.
  assert.equal(deriveRecordPublicKey(SEED, 'user-1'), pub)
})

test('a record encrypted to a user decrypts back, byte for byte', () => {
  const wallet = deriveOwnerAccount(SEED, 'user-1')
  const pub = deriveRecordPublicKey(SEED, 'user-1')

  const { header, ciphertext } = encryptFor(pub, PAYLOAD)

  // Encryption must actually have happened.
  assert.notEqual(new TextDecoder().decode(ciphertext), PAYLOAD)
  assert.equal(header.version, ECIES_VERSION)

  // The reader's half: the private key plus the ephemeral public key carried
  // in the header. This is what a user holding their own key would do.
  const key = deriveEciesDecryptKey(normalizePrivKey(wallet.privateKey), header.ephemeralPub)
  const recovered = new Uint8Array(ciphertext)
  cryptAt(key, header.nonce, 0, recovered)

  assert.equal(new TextDecoder().decode(recovered), PAYLOAD)
})

test('one person cannot decrypt another person’s record', () => {
  const pub = deriveRecordPublicKey(SEED, 'user-1')
  const intruder = deriveOwnerAccount(SEED, 'user-2')

  const { header, ciphertext } = encryptFor(pub, PAYLOAD)

  const wrongKey = deriveEciesDecryptKey(normalizePrivKey(intruder.privateKey), header.ephemeralPub)
  const attempt = new Uint8Array(ciphertext)
  cryptAt(wrongKey, header.nonce, 0, attempt)

  // Per-user keys are the whole reason a storage breach is not a data breach.
  assert.notEqual(new TextDecoder().decode(attempt), PAYLOAD)
})

test('a different master seed cannot read what the original wrote', () => {
  const pub = deriveRecordPublicKey(SEED, 'user-1')
  const { header, ciphertext } = encryptFor(pub, PAYLOAD)

  const rotated = deriveOwnerAccount('an-entirely-different-seed-of-sufficient-length', 'user-1')
  const key = deriveEciesDecryptKey(normalizePrivKey(rotated.privateKey), header.ephemeralPub)
  const attempt = new Uint8Array(ciphertext)
  cryptAt(key, header.nonce, 0, attempt)

  // This is the concrete harm behind SeedDriftError: same user, same id, new
  // seed, and the old record is simply gone.
  assert.notEqual(new TextDecoder().decode(attempt), PAYLOAD)
})

test('the header survives a round trip through bytes', () => {
  const pub = deriveRecordPublicKey(SEED, 'user-1')
  const { header } = encryptFor(pub, PAYLOAD)

  // The header travels with the ciphertext, so a reader parses it from bytes
  // rather than receiving the object. If that parse disagreed, decryption would
  // fail for every record while every upload still succeeded.
  const parsed = parseEncryptionHeader(header.toBytes())

  assert.equal(parsed.version, header.version)
  assert.deepEqual(parsed.nonce, header.nonce)
  assert.deepEqual(parsed.ephemeralPub, header.ephemeralPub)
})

test('every encryption uses a fresh ephemeral key', () => {
  const pub = deriveRecordPublicKey(SEED, 'user-1')

  const first = encryptFor(pub, PAYLOAD)
  const second = encryptFor(pub, PAYLOAD)

  // Reusing an ephemeral key across snapshots would leak the relationship
  // between two records of the same person to anyone holding the ciphertext.
  assert.notDeepEqual(first.header.ephemeralPub, second.header.ephemeralPub)
  assert.notDeepEqual(first.ciphertext, second.ciphertext)
})

test('a large fragmented payload decrypts from a non-zero offset', () => {
  const pub = deriveRecordPublicKey(SEED, 'user-1')
  const wallet = deriveOwnerAccount(SEED, 'user-1')

  // Records past the segment size are uploaded in fragments, and each fragment
  // decrypts at its own offset in the stream. Getting that arithmetic wrong
  // corrupts everything after the first fragment — which looks like a partial
  // record rather than an error.
  const large = PAYLOAD.repeat(200)
  const { header, ciphertext } = encryptFor(pub, large)

  const key = deriveEciesDecryptKey(normalizePrivKey(wallet.privateKey), header.ephemeralPub)

  const split = 1024
  const head = ciphertext.slice(0, split)
  const tail = ciphertext.slice(split)
  cryptAt(key, header.nonce, 0, head)
  cryptAt(key, header.nonce, split, tail)

  const rejoined = new Uint8Array(head.length + tail.length)
  rejoined.set(head, 0)
  rejoined.set(tail, head.length)

  assert.equal(new TextDecoder().decode(rejoined), large)
})
