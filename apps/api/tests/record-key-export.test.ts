/**
 * Handing somebody the key to their own record.
 *
 * The export has always listed the 0G Storage root hashes with a comment saying
 * they were "sufficient to reconstruct the record without this API existing at
 * all". They were not. Those hashes point at ciphertext, reading it needs the
 * record key, and the record key is derived from a seed we hold. In practice
 * that section of the export was a list of pointers to data the person it was
 * given to could not open.
 *
 * They can ask for the key now, and then the sentence is true.
 *
 * It is deliberately not in the default export. A health record is something
 * somebody might reasonably hand to a doctor; the same file plus the key is a
 * credential that can read every future snapshot and act as them on chain.
 * Those are different objects and should not come out of the same click.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signIn, startHarness, VALID_PROFILE, type Harness } from './helpers/e2e.ts'

async function withUser(
  body: (h: Harness, headers: Record<string, string>) => Promise<void>,
): Promise<void> {
  const harness = await startHarness()
  try {
    const { token } = await signIn(harness, '9400000001')
    const headers = { authorization: `Bearer ${token}` }
    await harness.app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers,
      payload: VALID_PROFILE,
    })
    await body(harness, headers)
  } finally {
    await harness.close()
  }
}

test('the plain export carries no key', async () => {
  await withUser(async (h, headers) => {
    const response = await h.app.inject({ method: 'GET', url: '/users/me/export', headers })
    assert.equal(response.statusCode, 200)

    const body = response.json()
    // This is the file somebody might forward to a doctor.
    assert.equal(body.recordKey, undefined)
    assert.doesNotMatch(response.body, /privateKey/)
  })
})

test('asking for the key returns it, with what it can do stated plainly', async () => {
  await withUser(async (h, headers) => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/users/me/export?includeRecordKey=true',
      headers,
    })
    assert.equal(response.statusCode, 200, response.body)

    const key = response.json().recordKey
    assert.ok(key, 'the key must be included when asked for')
    assert.match(key.privateKey, /^0x[0-9a-f]{64}$/)

    // A warning that does not say what the thing can do is decoration.
    assert.match(key.warning, /read/i)
    assert.match(key.warning, /act as you/i)
    assert.ok(key.howToUse.includes('ECIES'), 'it must say how to actually use it')
  })
})

test('the key matches the one the records are encrypted to', async () => {
  await withUser(async (h, headers) => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/users/me/export?includeRecordKey=true',
      headers,
    })

    const body = response.json()
    const { publicKeyFor } = await import('@ogt/og')

    // A key that does not open the records would be worse than none: it looks
    // like ownership and delivers nothing.
    assert.equal(publicKeyFor(body.recordKey.privateKey), body.recordKey.publicKey)
    assert.equal(body.profile.recordPubKey, body.recordKey.publicKey)
  })
})

test('one person cannot ask for another person’s key', async () => {
  const harness = await startHarness()
  try {
    const alice = await signIn(harness, '9400000002')
    const bob = await signIn(harness, '9400000003')

    const keys: string[] = []
    for (const person of [alice, bob]) {
      const headers = { authorization: `Bearer ${person.token}` }
      await harness.app.inject({
        method: 'POST',
        url: '/users/me/profile',
        headers,
        payload: VALID_PROFILE,
      })
      const response = await harness.app.inject({
        method: 'GET',
        url: '/users/me/export?includeRecordKey=true',
        headers,
      })
      keys.push(response.json().recordKey.privateKey)
    }

    // The route takes no user id — the key follows the session, like everything
    // else — and each person's key is their own.
    assert.notEqual(keys[0], keys[1])
  } finally {
    await harness.close()
  }
})

test('the CSV export never carries a key', async () => {
  await withUser(async (h, headers) => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/users/me/export.csv?includeRecordKey=true',
      headers,
    })

    // A spreadsheet of meals is the least likely place anybody would look for a
    // credential, which is exactly why one must never be there.
    assert.doesNotMatch(response.body, /0x[0-9a-f]{64}/)
    assert.doesNotMatch(response.body, /privateKey/)
  })
})
