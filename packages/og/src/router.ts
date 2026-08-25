/**
 * 0G Compute Router client.
 *
 * The Router is OpenAI-compatible, so this wraps the official openai SDK rather
 * than hand-rolling HTTP. What it adds on top is the part the Router does not
 * do for us: failover *across* models, because failing over within a
 * single-provider model achieves nothing.
 *
 * Key facts, from the 0G docs (`0g-doc/docs/developer-hub/.../router/`):
 *   - Base URL: https://router-api.0g.ai/v1
 *   - `sk-` keys call inference and are billed.
 *   - `mk-` keys administer the account; `sk-` keys cannot read /v1/account/*.
 *   - Keys are created at pc.0g.ai after depositing 0G tokens.
 *
 * Note: `processResponse()` and the `ZG-Res-Key` header belong to Direct SDK
 * mode (`@0gfoundation/0g-compute-ts-sdk`). We use Router mode, which settles
 * billing against the deposited balance. Do not mix the two models.
 */

import OpenAI from 'openai'
import { CHAINS, type ModelSpec, type TaskName } from './models.ts'
import { readTrace, readReceipt, type AttestationReceipt } from './attestation.ts'

export const ROUTER_BASE_URL = 'https://router-api.0g.ai/v1'

export class OGRouterError extends Error {
  // Written as an explicit field rather than a constructor parameter property:
  // we run TypeScript through Node's type-stripping, which does not support
  // parameter properties because they emit runtime code.
  readonly attempts: ReadonlyArray<{ model: string; error: string }>
  /**
   * Seconds the Router asked us to wait, on a rate limit.
   *
   * Null for every other failure. Carried so a caller can say "try again in a
   * minute" instead of inventing a number, and so a retry loop can honour the
   * interval rather than guessing at one.
   */
  readonly retryAfterSeconds: number | null

  constructor(
    message: string,
    attempts: ReadonlyArray<{ model: string; error: string }>,
    options?: { retryAfterSeconds?: number | null },
  ) {
    super(message)
    this.name = 'OGRouterError'
    this.attempts = attempts
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null
  }
}

export interface RouterConfig {
  /** Inference key. Starts with `sk-`. */
  apiKey: string
  baseURL?: string
  /** Per-request timeout in ms. */
  timeoutMs?: number
}

export function createClient(config: RouterConfig): OpenAI {
  if (!config.apiKey) {
    throw new Error('0G Router API key is required. Create one at https://pc.0g.ai.')
  }
  if (!config.apiKey.startsWith('sk-')) {
    throw new Error(
      'Expected an inference key beginning with "sk-". Management keys ("mk-") cannot call ' +
        'inference endpoints.',
    )
  }
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? ROUTER_BASE_URL,
    timeout: config.timeoutMs ?? 30_000,
    maxRetries: 0, // failover is handled here, across models, not inside the SDK
  })
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  /**
   * What the Router actually charged, in neuron (1e18 = 1 0G).
   *
   * This is the authoritative number and it arrives with every response. The
   * documentation is explicit: "you don't need to compute costs yourself — the
   * Router tells you exactly what was charged."
   *
   * Null only when the Router returned no billing block, which should not
   * happen and is recorded honestly rather than filled in with a guess.
   */
  costNeuron: bigint | null
  /**
   * A local estimate in USD, from the catalogue's published per-token pricing.
   *
   * Kept for budgeting before a call is made, and deliberately not used for
   * accounting after one. These constants drift — three of six were wrong when
   * last checked against the live catalogue, one of them by 135% on the
   * highest-volume call in the product, and speech was recorded as free when it
   * is billed. `costNeuron` is what actually happened.
   */
  usdEstimate: number
}

export interface CompleteOptions {
  task: TaskName
  /**
   * Override the chain of models to try.
   *
   * The task chains name Router models. A provider reached directly through the
   * compute broker serves its own model and has never heard of those names, so
   * that path supplies its own chain. Without this the Router's model ids would
   * be sent to a provider that cannot serve them, and every attempt would fail
   * for a reason that looks like an outage.
   */
  models?: readonly ModelSpec[]
  messages: OpenAI.ChatCompletionMessageParam[]
  /** Ask for strict JSON matching a schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /**
   * Ask the Router to verify the provider's TEE signature before returning.
   *
   * Defaults to true, and every caller handling identified health data leaves
   * it that way. The result is a receipt the user can check — the one thing in
   * this system that no hosted API can supply.
   */
  verifyTee?: boolean
}

export interface CompleteResult {
  text: string
  model: string
  /** How many models in the chain failed before this one answered. */
  failovers: number
  usage: Usage
  /** Proof of where this ran. Stored alongside whatever it produced. */
  attestation: AttestationReceipt
}

/**
 * Run a task against its model chain, advancing on failure.
 *
 * Client errors that would fail identically on every model - a malformed
 * request, a bad key, an exhausted balance - short-circuit rather than burning
 * the whole chain and three times the latency.
 */
export async function complete(
  client: OpenAI,
  opts: CompleteOptions,
): Promise<CompleteResult> {
  const chain: readonly ModelSpec[] = opts.models ?? CHAINS[opts.task]
  const attempts: Array<{ model: string; error: string }> = []

  for (const [index, model] of chain.entries()) {
    try {
      const verifyTee = opts.verifyTee !== false

      const response = await client.chat.completions.create(
        {
          model: model.id,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 800,
          // Only when the model advertises it. See ModelSpec.supports.
          ...(model.supports.temperature ? { temperature: opts.temperature ?? 0.2 } : {}),
          ...(opts.jsonSchema
            ? {
                response_format: {
                  type: 'json_schema' as const,
                  json_schema: { ...opts.jsonSchema, strict: true },
                },
              }
            : {}),
          // A 0G Router extension. It is stripped before the request reaches
          // the provider, so it does not disturb the OpenAI-compatible schema —
          // and it has no counterpart on any other provider.
          ...(verifyTee ? { verify_tee: true } : {}),
        } as OpenAI.ChatCompletionCreateParamsNonStreaming,
        opts.signal ? { signal: opts.signal } : {},
      )

      const attestation = readReceipt(response, model.id)

      // A present-but-invalid signature means we do not know what produced this
      // output. Failing over is the right move: another provider in the chain
      // may be healthy, and presenting unverifiable output as health guidance
      // would hollow out the entire privacy claim.
      if (verifyTee && attestation.status === 'failed') {
        attempts.push({ model: model.id, error: 'tee_verification_failed' })
        continue
      }

      const text = response.choices[0]?.message?.content
      if (!text) throw new Error('empty completion')

      const promptTokens = response.usage?.prompt_tokens ?? 0
      const completionTokens = response.usage?.completion_tokens ?? 0

      return {
        text,
        model: model.id,
        failovers: index,
        usage: {
          promptTokens,
          completionTokens,
          costNeuron: readCostNeuron(response),
          usdEstimate:
            promptTokens * model.usdPerPromptToken +
            completionTokens * model.usdPerCompletionToken,
        },
        attestation,
      }
    } catch (error) {
      if (isNonRetryable(error)) {
        const status = (error as { status?: number }).status
        if (status === 429) {
          // Named explicitly, because "rate limited" and "your key is wrong"
          // need completely different things from whoever is handling it.
          throw new OGRouterError(
            'The 0G Router rate limited this account.',
            [...attempts, { model: model.id, error: describe(error) }],
            { retryAfterSeconds: retryAfterSeconds(error) },
          )
        }
        throw error
      }
      attempts.push({ model: model.id, error: describe(error) })
    }
  }

  throw new OGRouterError(`All ${chain.length} models failed for task "${opts.task}".`, attempts)
}

/**
 * Whether trying the next model in the chain could possibly help.
 *
 * Read from the Router's documented error table rather than guessed at, because
 * the two kinds of 4xx here behave in opposite ways:
 *
 *   401, 402, 403  the account. Every model fails identically, so walking the
 *                  chain is three requests to learn one thing.
 *   400, 404       the request or the model. Also fatal as we build requests —
 *                  parameters are chosen from what each model advertises, so a
 *                  400 means the body itself is wrong.
 *   408            a timeout, which belongs to the provider that stalled. The
 *                  next model is a fresh set of providers and may well answer.
 *   429            rate limiting, and the important correction. The
 *                  documentation says the limit is **per account**, so failing
 *                  over does not route around it — it fires another request at
 *                  the same throttled account and burns the rest of the chain
 *                  making the throttling worse. The right response is to stop
 *                  and back off for the interval the Router names.
 *
 * Source: 0G docs, Router → Errors, and Router → Rate Limits.
 */
function isNonRetryable(error: unknown): boolean {
  const status = (error as { status?: number }).status
  if (typeof status !== 'number') return false

  // A stalled provider is worth escaping; a throttled account is not.
  if (status === 408) return false

  return status >= 400 && status < 500
}

/**
 * How long the Router asked us to wait, in seconds.
 *
 * Present on a 429. Surfaced so the caller can honour it rather than guess —
 * the rate-limit documentation is explicit that `Retry-After` is the number to
 * use.
 */
export function retryAfterSeconds(error: unknown): number | null {
  const headers = (error as { headers?: Record<string, string> }).headers
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (typeof raw !== 'string') return null

  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Strip markdown fences some models add despite json_schema mode. */
export function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  return (fenced?.[1] ?? text).trim()
}

/**
 * The exact charge for a request, as reported by the Router.
 *
 * Returned in neuron as a decimal string. Parsed with BigInt rather than
 * Number, because these values run to sixteen digits and would start losing
 * precision as doubles well before anybody noticed a rounding error in a bill.
 */
export function readCostNeuron(response: unknown): bigint | null {
  const trace = readTrace(response)
  const total = trace?.billing?.total_cost
  if (typeof total !== 'string' || !/^\d+$/.test(total)) return null

  try {
    return BigInt(total)
  } catch {
    return null
  }
}
