/**
 * Transcription, and the extension that has to travel out-of-band.
 *
 * `verify_tee` is a body field on the Router's JSON endpoints. The audio
 * endpoint is multipart, so the Router documents its extensions as passed
 * out-of-band: `verify_tee` becomes a query parameter. Sending it in the body
 * there is not rejected — it is ignored, and the call runs unattested while
 * looking exactly like every other call.
 *
 * That is what happened: transcription asked for no verification and recorded
 * no receipt, so voice notes about somebody's health ran without the guarantee
 * the sign-in screen makes, and never appeared in the receipts shown to back
 * it.
 *
 * These tests pin the wire format, because a stub cannot notice a parameter in
 * the wrong place.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TranscriptionError, transcribeAudio } from '../src/speech.ts'

const KEY = 'sk-test-not-a-real-key'
const AUDIO = new File([new Uint8Array([1, 2, 3])], 'note.m4a', { type: 'audio/m4a' })

interface Captured {
  url: string
  init: RequestInit
}

/** Replace fetch, capture the request, answer with a scripted body. */
function captureFetch(body: unknown, status = 200): Captured[] {
  const calls: Captured[] = []
  globalThis.fetch = (async (input: string | URL, init: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

const VERIFIED = {
  text: 'do roti aur dal',
  x_0g_trace: {
    request_id: '0852f405-6c56-40c2-a800-e6fd70785065',
    provider: '0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C',
    tee_verified: true,
  },
}

const original = globalThis.fetch

test('verify_tee travels as a query parameter, not in the body', async () => {
  const calls = captureFetch(VERIFIED)
  try {
    await transcribeAudio({ apiKey: KEY, audio: AUDIO })

    const url = new URL(calls[0]!.url)
    // The whole point. In the body it is silently ignored and the call runs
    // unattested.
    assert.equal(url.searchParams.get('verify_tee'), 'true')
    assert.equal(url.pathname, '/v1/audio/transcriptions')

    const form = calls[0]!.init.body as FormData
    assert.equal(form.get('verify_tee'), null, 'it must not be a form field')
    assert.equal(form.get('model'), 'whisper-large-v3')
    assert.ok(form.get('file'), 'the audio must actually be sent')
  } finally {
    globalThis.fetch = original
  }
})

test('the key is sent as a bearer token', async () => {
  const calls = captureFetch(VERIFIED)
  try {
    await transcribeAudio({ apiKey: KEY, audio: AUDIO })
    const headers = calls[0]!.init.headers as Record<string, string>
    assert.equal(headers.Authorization, `Bearer ${KEY}`)
  } finally {
    globalThis.fetch = original
  }
})

test('a language hint is passed through when given', async () => {
  const calls = captureFetch(VERIFIED)
  try {
    await transcribeAudio({ apiKey: KEY, audio: AUDIO, language: 'hi' })
    // Hindi transcribes noticeably better with the hint, and this product is
    // built for people who will use it.
    assert.equal((calls[0]!.init.body as FormData).get('language'), 'hi')
  } finally {
    globalThis.fetch = original
  }
})

test('the attestation receipt is read from the response', async () => {
  captureFetch(VERIFIED)
  try {
    const result = await transcribeAudio({ apiKey: KEY, audio: AUDIO })

    assert.equal(result.text, 'do roti aur dal')
    assert.equal(result.attestation.status, 'verified')
    assert.equal(result.attestation.provider, VERIFIED.x_0g_trace.provider)
    assert.equal(result.attestation.requestId, VERIFIED.x_0g_trace.request_id)
  } finally {
    globalThis.fetch = original
  }
})

test('an unverified transcription is refused, not returned', async () => {
  // The sentence on the sign-in screen has no exception for audio. Returning
  // the text anyway would put a transcript of somebody talking about their
  // health into the record with no evidence of where it was processed.
  captureFetch({ text: 'do roti aur dal', x_0g_trace: { tee_verified: false } })
  try {
    await assert.rejects(
      () => transcribeAudio({ apiKey: KEY, audio: AUDIO }),
      /without verified TEE attestation/,
    )
  } finally {
    globalThis.fetch = original
  }
})

test('a response with no trace at all is refused', async () => {
  // No trace means the Router did not honour the parameter. Silence here is
  // exactly the failure this module exists to make impossible.
  captureFetch({ text: 'do roti aur dal' })
  try {
    await assert.rejects(() => transcribeAudio({ apiKey: KEY, audio: AUDIO }), TranscriptionError)
  } finally {
    globalThis.fetch = original
  }
})

test('a provider error never carries the transcript into ours', async () => {
  // Providers sometimes echo the input back in an error, and the input here is
  // a recording of somebody speaking.
  captureFetch({ error: 'bad request', echo: 'do roti aur dal' }, 400)
  try {
    await assert.rejects(
      () => transcribeAudio({ apiKey: KEY, audio: AUDIO }),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptionError)
        assert.equal(error.status, 400)
        assert.doesNotMatch(error.message, /roti/, 'the speech must not reach our logs')
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

test('verification can be turned off only explicitly, and then omits the parameter', async () => {
  const calls = captureFetch({ text: 'hello' })
  try {
    await transcribeAudio({ apiKey: KEY, audio: AUDIO, verifyTee: false })
    assert.equal(new URL(calls[0]!.url).searchParams.get('verify_tee'), null)
  } finally {
    globalThis.fetch = original
  }
})
