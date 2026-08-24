/**
 * What we ask 0G Storage for, and why the options matter.
 *
 * Snapshots were downloaded with Merkle proof verification off. The SDK exposes
 * it as `proof` on the download options, and the documentation names the exact
 * case: "Enable proof verification for sensitive files."
 *
 * It matters more than an unchecked checksum usually would, because of how the
 * payload is encrypted. Counter mode is malleable and carries no authentication
 * tag, so a storage node returning altered ciphertext does not cause a
 * decryption failure — it produces altered plaintext. A flipped bit becomes a
 * flipped bit in somebody's medical history, and every layer downstream accepts
 * it happily. The Merkle proof is the only thing in the path that would notice.
 *
 * These tests assert the request we make rather than the network's answer, so
 * they need no credentials. The first one fails if `proof` is dropped.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'storage.ts'), 'utf8')

/** Strip comments, so prose about an option does not count as using it. */
const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('downloads ask for Merkle proof verification', () => {
  assert.match(
    code,
    /proof:\s*true/,
    'a health record must not be accepted from storage unverified',
  )
})

test('the proof option is on the call that actually downloads', () => {
  // Declaring it somewhere unrelated would pass a naive check while the request
  // still went out without it.
  const downloadAt = code.indexOf('downloadToBlob')
  assert.ok(downloadAt > -1)

  const region = code.slice(Math.max(0, downloadAt - 600), downloadAt + 400)
  assert.match(region, /proof:\s*true/, 'the download call must carry it')
})

test('both the single and fragmented paths use the same options', () => {
  // A large record is split, and it would be easy to verify one shape and not
  // the other. Losing verification only on large records is worse than losing
  // it everywhere, because it would look like it worked.
  const single = /downloadToBlob\(rootHashes\[0\]!,\s*options\)/
  const many = /downloadToBlob\(\[\.\.\.rootHashes\],\s*options\)/

  assert.match(code, single, 'the single-hash path must use the shared options')
  assert.match(code, many, 'and so must the fragmented path')
})

test('uploads still require finality before reporting success', () => {
  // A root hash returned before the write is final is a pointer to something
  // that may not be there. The database row is written from it.
  assert.match(code, /finalityRequired:\s*true/)
})

test('the payload is encrypted to the user, never stored in the clear', () => {
  assert.match(code, /type:\s*'ecies'/)
  assert.match(code, /recipientPubKey/)
})

test('a download failure is raised, never silently returned as empty', () => {
  // An empty record that looks like "no data yet" rather than "we could not
  // read your data" is the difference between a visible outage and a user
  // believing their history is gone.
  assert.match(code, /if \(err !== null\)/)
  assert.match(SOURCE, /0G Storage download failed/)
})
