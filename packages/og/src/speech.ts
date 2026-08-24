/**
 * Speech to text, with the attestation the rest of the product insists on.
 *
 * Transcription was the one model call that asked for no TEE verification and
 * recorded no receipt. Every other path sends `verify_tee` and stores what came
 * back; this one sent nothing, so voice notes — which are health data, and the
 * most identifying input this product takes — ran unattested and never appeared
 * in the receipts the app shows a person to back its privacy claim.
 *
 * The reason it was missed is worth writing down. `verify_tee` is a body field
 * on the JSON endpoints, and the OpenAI SDK carries it through happily. The
 * audio endpoint is `multipart/form-data`, so the Router documents its
 * extensions as out-of-band: `verify_tee` becomes a **query parameter**, and
 * provider routing moves to `X-0G-Provider-*` headers. Passing it in the body
 * there is not an error — it is simply ignored, which is the worst kind of
 * mistake to make about a security property.
 *
 * Source: 0G docs, Compute Network → Router → Features → Audio,
 * "0G Router Extensions".
 *
 * The SDK cannot add a query parameter to that call, so this issues the request
 * directly rather than pretending the option was honoured.
 */

import { readReceipt, type AttestationReceipt } from './attestation.ts'
import { ROUTER_BASE_URL } from './router.ts'
import { MODELS } from './models.ts'

export interface TranscriptionOptions {
  apiKey: string
  audio: File
  /** ISO-639-1. Hindi transcribes noticeably better when the hint is given. */
  language?: string
  /** Defaults to true. There is no reason for a caller to turn this off. */
  verifyTee?: boolean
  baseURL?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface TranscriptionResult {
  text: string
  model: string
  /** Proof of where this ran, stored beside whatever it produced. */
  attestation: AttestationReceipt
}

export class TranscriptionError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'TranscriptionError'
    this.status = status
  }
}

export async function transcribeAudio(
  options: TranscriptionOptions,
): Promise<TranscriptionResult> {
  const model = MODELS.whisper.id
  const verifyTee = options.verifyTee ?? true

  const base = options.baseURL ?? ROUTER_BASE_URL
  // A query parameter, not a body field. The documented contract for this
  // endpoint, and the whole point of this module.
  const url = new URL(`${base}/audio/transcriptions`)
  if (verifyTee) url.searchParams.set('verify_tee', 'true')

  const form = new FormData()
  form.set('file', options.audio)
  form.set('model', model)
  // Asked for explicitly so the trace is parseable; the default is already json.
  form.set('response_format', 'json')
  if (options.language) form.set('language', options.language)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body: form,
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000),
    })
  } catch (error) {
    throw new TranscriptionError(
      `Could not reach the Router: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }

  if (!response.ok) {
    // The body is read and discarded: provider errors sometimes echo the
    // transcript back, and that is the user's speech.
    await response.text().catch(() => '')
    throw new TranscriptionError(`Transcription failed`, response.status)
  }

  const body = (await response.json()) as { text?: string }
  const attestation = readReceipt(body, model)

  if (verifyTee && attestation.status !== 'verified') {
    /*
     * Refused rather than returned.
     *
     * Everywhere else in this product an unverified computation is a failure,
     * because the sentence on the sign-in screen does not have an exception for
     * audio. Returning the text with a shrug would put a transcript of somebody
     * speaking about their health into the record with no evidence of where it
     * was processed.
     */
    throw new TranscriptionError(
      `Transcription ran without verified TEE attestation (${attestation.status})`,
    )
  }

  return { text: body.text ?? '', model, attestation }
}
