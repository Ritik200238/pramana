/**
 * The SMS sender against a real HTTP server.
 *
 * "SMS delivery" was recorded as unverified, and part of that was fair — nobody
 * can verify a vendor account and a DLT-approved template without having one.
 * But part of it was not: the sender itself had never put a single request on a
 * wire. Every test around it stubbed or inspected configuration, so what a
 * provider would actually receive was unproven, and the first time anybody found
 * out would have been the first time a real person could not sign in.
 *
 * This starts an actual server, points the sender at it, and reads what arrives.
 * What remains genuinely unverifiable here is the vendor: their URL, their auth
 * header, their approved template. Those are operational, and the shape of what
 * we send to them is not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createSmsSender } from '../src/services/sms.ts'

interface Received {
  method: string
  path: string
  headers: NodeJS.Dict<string | string[]>
  body: string
}

/** A provider that records what it was sent, and answers how it is told to. */
async function provider(
  respond: { status: number; body?: string } = { status: 200, body: '{"ok":true}' },
): Promise<{ url: string; received: Received[]; close: () => Promise<void>; server: Server }> {
  const received: Received[] = []

  const server = createServer((request: IncomingMessage, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      received.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body,
      })
      response.writeHead(respond.status, { 'content-type': 'application/json' })
      response.end(respond.body ?? '')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')

  return {
    url: `http://127.0.0.1:${address.port}/v5/otp`,
    received,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function sender(url: string, log: (line: unknown) => void = () => {}) {
  return createSmsSender({
    isProduction: true,
    url,
    headers: '{"authkey":"secret-key","content-type":"application/json"}',
    body: '{"template_id":"t1","mobile":"{{to}}","otp":"{{code}}","expiry":"{{expiry}}"}',
    log,
  })
}

test('a provider receives exactly what the template describes', async () => {
  const fake = await provider()

  try {
    await sender(fake.url).send({ to: '+919876543210', code: '482915', expiresInMinutes: 5 })

    assert.equal(fake.received.length, 1, 'the message must actually be sent')
    const request = fake.received[0]!

    assert.equal(request.method, 'POST')
    assert.equal(request.path, '/v5/otp')

    // The configured headers arrive, including the vendor's auth. This is the
    // half that no amount of unit testing around a stub can establish.
    assert.equal(request.headers['authkey'], 'secret-key')

    const payload = JSON.parse(request.body) as Record<string, unknown>
    assert.equal(payload['template_id'], 't1')
    assert.equal(payload['mobile'], '+919876543210')
    assert.equal(payload['otp'], '482915')
    // Minutes, which is what the template placeholder means. A vendor told
    // "300" when we meant five minutes would set a five-hour expiry.
    assert.equal(payload['expiry'], '5')
  } finally {
    await fake.close()
  }
})

test('a value that looks like markup cannot reshape the request on the wire', async () => {
  const fake = await provider()

  try {
    // Placeholders are filled structurally rather than spliced into a string.
    // Proved here against a real parser rather than against our own assumption
    // about what the string would look like.
    await sender(fake.url).send({
      to: '+91","admin":true,"x":"',
      code: '000000',
      expiresInMinutes: 1,
    })

    const payload = JSON.parse(fake.received[0]!.body) as Record<string, unknown>

    assert.equal(payload['mobile'], '+91","admin":true,"x":"')
    assert.ok(!('admin' in payload), 'a value must never become a field')
    assert.equal(Object.keys(payload).length, 4)
  } finally {
    await fake.close()
  }
})

test('a provider that refuses is an error, not a silent success', async () => {
  const fake = await provider({ status: 401, body: '{"error":"bad key"}' })

  try {
    await assert.rejects(
      () => sender(fake.url).send({ to: '+919876543210', code: '111111', expiresInMinutes: 5 }),
      'a rejected send must not look like a delivered one',
    )
  } finally {
    await fake.close()
  }
})

test('the code never escapes in the error, however the provider echoes it back', async () => {
  /*
   * The realistic leak path, and the one the sender guards against explicitly:
   * providers routinely echo the request back in an error body, that body
   * contains the one-time code, and an error message carrying it ends up in a
   * log aggregator beside the phone number.
   *
   * An earlier version of this test asserted the code never reached a logger.
   * `HttpSmsConfig` has no logger, so it passed by having nothing to observe —
   * an inert guard, which is worse than no guard because it reads like one.
   */
  const code = '482915'
  const fake = await provider({
    status: 500,
    // The provider hands the code straight back, as several real ones do.
    body: JSON.stringify({ error: 'upstream failed', request: { otp: code, mobile: '+91987' } }),
  })

  try {
    const failure = await sender(fake.url)
      .send({ to: '+919876543210', code, expiresInMinutes: 5 })
      .then(() => null)
      .catch((error: unknown) => error)

    assert.ok(failure instanceof Error, 'a rejected send must throw')

    // Everything that would be written out if somebody logged this error.
    const surface = [failure.message, failure.stack ?? '', JSON.stringify(failure)].join(' ')
    assert.ok(!surface.includes(code), `the code leaked through the error: ${surface}`)
  } finally {
    await fake.close()
  }
})

test('an unreachable provider fails rather than hanging forever', async () => {
  // Bound and immediately closed, so the port refuses connections.
  const fake = await provider()
  const url = fake.url
  await fake.close()

  const started = Date.now()
  await assert.rejects(() =>
    sender(url).send({ to: '+919876543210', code: '222222', expiresInMinutes: 5 }),
  )

  // Somebody is holding a phone waiting for a code. A send that hangs is worse
  // than one that fails, because nothing else can happen while it does.
  assert.ok(Date.now() - started < 15_000, 'a dead provider must fail quickly')
})
