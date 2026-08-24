/**
 * TEE attestation receipts — the binding that cannot be swapped out.
 *
 * Everything else in this package is, honestly, replaceable. The Router is
 * OpenAI-compatible: change a base URL and a key and inference keeps working.
 * That is a real property of the design and pretending otherwise would be
 * dishonest.
 *
 * This file is the exception, and it is the reason 0G is load-bearing here
 * rather than decorative.
 *
 * Passing `verify_tee: true` makes the Router synchronously verify the
 * provider's hardware signature and return the verdict in `x_0g_trace`:
 *
 *   {
 *     "request_id": "0852f405-…",
 *     "provider": "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C",
 *     "tee_verified": true
 *   }
 *
 * That is a **receipt**: a specific provider, running a specific model inside
 * an Intel TDX enclave, cryptographically signed that it produced this output.
 * We keep it next to the health insight it produced.
 *
 * There is no equivalent from any hosted API. OpenAI can promise it did not
 * read your data; it cannot hand you an artefact proving the hardware would not
 * let it. So "we cannot read your health data" is either a receipt you can
 * check, or it is marketing — and which of those it is depends entirely on 0G.
 */

import { z } from 'zod'

/** The Router's per-response trace block. Present on every Router response. */
export const TraceSchema = z.object({
  request_id: z.string().optional(),
  provider: z.string().optional(),
  billing: z
    .object({
      input_cost: z.string().optional(),
      output_cost: z.string().optional(),
      total_cost: z.string().optional(),
    })
    .optional(),
  /**
   * true  — the provider's TEE signature validated
   * false — a signature was present and did NOT verify. Treat as untrusted.
   * null/absent — verification was not requested
   */
  tee_verified: z.boolean().nullable().optional(),
})

export type Trace = z.infer<typeof TraceSchema>

export interface AttestationReceipt {
  /** Router request id, for reconciling against their side. */
  requestId: string | null
  /** On-chain address of the provider that served this inference. */
  provider: string | null
  /** The model that produced the output. */
  model: string
  /**
   * The verdict.
   *   'verified'  — hardware signature checked out
   *   'failed'    — a signature was present and did not verify
   *   'unrequested' — we did not ask (non-health paths)
   *   'unavailable' — we asked and the Router returned nothing
   */
  status: 'verified' | 'failed' | 'unrequested' | 'unavailable'
  verifiedAt: string
}

/**
 * Extract a receipt from a Router response.
 *
 * `x_0g_trace` is a Router extension, so it is not in the OpenAI types. That is
 * precisely the point — this is the field that does not exist anywhere else.
 */
export function readReceipt(response: unknown, model: string): AttestationReceipt {
  const now = new Date().toISOString()

  const trace = extractTrace(response)
  if (!trace) {
    return { requestId: null, provider: null, model, status: 'unavailable', verifiedAt: now }
  }

  const status: AttestationReceipt['status'] =
    trace.tee_verified === true
      ? 'verified'
      : trace.tee_verified === false
        ? 'failed'
        : 'unrequested'

  return {
    requestId: trace.request_id ?? null,
    provider: trace.provider ?? null,
    model,
    status,
    verifiedAt: now,
  }
}

function extractTrace(response: unknown): Trace | null {
  if (typeof response !== 'object' || response === null) return null
  const raw = (response as Record<string, unknown>)['x_0g_trace']
  if (raw === undefined) return null
  const parsed = TraceSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * A receipt that failed verification is a security event, not a warning.
 *
 * `tee_verified: false` means a signature was present and did not check out.
 * The honest reading is that we do not know what produced that output, so it
 * must not be presented to a user as health guidance — the whole privacy claim
 * rests on the enclave being real.
 */
export function isTrustworthy(receipt: AttestationReceipt): boolean {
  return receipt.status !== 'failed'
}

/**
 * Whether this receipt can back the privacy claim to a third party.
 *
 * Only 'verified' does. 'unrequested' and 'unavailable' are honest states we
 * record rather than hide, but neither is evidence, and neither should be shown
 * to a user as though it were.
 */
export function isProvable(receipt: AttestationReceipt): boolean {
  return receipt.status === 'verified'
}

/** One-line human summary, for the receipt a user can actually look at. */
export function describeReceipt(receipt: AttestationReceipt): string {
  switch (receipt.status) {
    case 'verified':
      return `Computed inside a hardware-sealed enclave by provider ${short(receipt.provider)}, verified by 0G. Nobody — including us — could read it.`
    case 'failed':
      return 'This response could not be verified as coming from a sealed enclave, so it was not used.'
    case 'unavailable':
      return 'Verification was requested but the network did not return a result.'
    case 'unrequested':
      return 'Verification was not requested for this request.'
  }
}

function short(address: string | null): string {
  if (!address) return 'unknown'
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}
