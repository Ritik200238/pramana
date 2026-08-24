/**
 * Code delivery.
 *
 * The failure this file guards against is the one that was actually present:
 * a server that answers 200 to every code request, delivers nothing, and locks
 * every user out permanently while looking healthy.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  ConsoleSmsSender,
  HttpSmsSender,
  SmsDeliveryError,
  createSmsSender,
} from '../src/services/sms.ts'

// ------------------------------------------------------------ choosing one

test('production refuses to start without a provider', () => {
  assert.throws(
    () => createSmsSender({ isProduction: true, log: () => {} }),
    /No SMS provider configured/,
    'booting without a sender means nobody can ever sign in',
  )
})

test('development falls back to the console sender', () => {
  const sender = createSmsSender({ isProduction: false, log: () => {} })
  assert.equal(sender.name, 'console')
})

test('the console sender cannot be constructed in production', () => {
  // A sender that logs instead of sending is the exact failure being removed.
  assert.throws(() => new ConsoleSmsSender(() => {}, true), /never be used in production/)
})

test('a body template without the code placeholder is refused at boot', () => {
  assert.throws(
    () =>
      createSmsSender({
        isProduction: true,
        url: 'https://example.test/send',
        body: '{"mobile":"{{to}}"}',
        log: () => {},
      }),
    /\{\{code\}\}/,
    'otherwise users receive a blank message and we hear about it from them',
  )
})

test('malformed provider configuration fails loudly rather than silently', () => {
  assert.throws(
    () =>
      createSmsSender({
        isProduction: true,
        url: 'https://example.test/send',
        headers: 'not json',
        body: '{"otp":"{{code}}"}',
        log: () => {},
      }),
    /SMS_PROVIDER_HEADERS/,
  )

  assert.throws(
    () =>
      createSmsSender({
        isProduction: true,
        url: 'https://example.test/send',
        body: 'not json',
        log: () => {},
      }),
    /SMS_PROVIDER_BODY/,
  )
})

test('a configured provider is used in production', () => {
  const sender = createSmsSender({
    isProduction: true,
    url: 'https://api.example.test/v5/otp',
    headers: '{"authkey":"secret"}',
    body: '{"template_id":"t1","mobile":"{{to}}","otp":"{{code}}"}',
    log: () => {},
  })
  assert.equal(sender.name, 'api.example.test')
})

// -------------------------------------------------------------- sending

test('placeholders are filled structurally, not by string splicing', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response('{"type":"success"}', { status: 200 })
  })

  try {
    const sender = new HttpSmsSender({
      url: 'https://api.example.test/send',
      headers: { authkey: 'secret' },
      body: { template_id: 't1', mobile: '{{to}}', otp: '{{code}}', ttl: '{{expiry}}' },
    })

    await sender.send({ to: '+919876543210', code: '123456', expiresInMinutes: 10 })

    const body = JSON.parse(calls[0]!.init.body as string)
    assert.deepEqual(body, {
      template_id: 't1',
      mobile: '+919876543210',
      otp: '123456',
      ttl: '10',
    })

    const headers = calls[0]!.init.headers as Record<string, string>
    assert.equal(headers['authkey'], 'secret')
    assert.equal(headers['Content-Type'], 'application/json')
  } finally {
    fetchMock.mock.restore()
  }
})

test('a value containing quotes cannot reshape the request', async () => {
  const calls: Array<{ init: RequestInit }> = []
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls.push({ init })
    return new Response('{}', { status: 200 })
  })

  try {
    const sender = new HttpSmsSender({
      url: 'https://api.example.test/send',
      headers: {},
      body: { mobile: '{{to}}', otp: '{{code}}', role: 'user' },
    })

    // Substituting into raw JSON text would let this close the string and add
    // a field. Substituting into the parsed structure cannot.
    await sender.send({
      to: '","role":"admin","x":"',
      code: '123456',
      expiresInMinutes: 10,
    })

    const body = JSON.parse(calls[0]!.init.body as string)
    assert.equal(body.role, 'user', 'the injected field must not have taken effect')
    assert.equal(body.mobile, '","role":"admin","x":"', 'it stays a value')
  } finally {
    fetchMock.mock.restore()
  }
})

test('a provider rejection is an error, not a shrug', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    // Providers routinely echo the message back, which contains the code.
    new Response('{"message":"invalid template, otp was 123456"}', { status: 400 }),
  )

  try {
    const sender = new HttpSmsSender({
      url: 'https://api.example.test/send',
      headers: {},
      body: { otp: '{{code}}' },
    })

    await assert.rejects(
      () => sender.send({ to: '+919876543210', code: '123456', expiresInMinutes: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof SmsDeliveryError)
        assert.equal(error.status, 400)
        // The code must not travel into our logs by way of an error message.
        assert.doesNotMatch(error.message, /123456/, 'the code must never be in the error')
        return true
      },
    )
  } finally {
    fetchMock.mock.restore()
  }
})

test('an unreachable provider fails rather than hanging', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('network unreachable')
  })

  try {
    const sender = new HttpSmsSender({
      url: 'https://api.example.test/send',
      headers: {},
      body: { otp: '{{code}}' },
    })

    await assert.rejects(
      () => sender.send({ to: '+919876543210', code: '123456', expiresInMinutes: 10 }),
      /unreachable/,
    )
  } finally {
    fetchMock.mock.restore()
  }
})
