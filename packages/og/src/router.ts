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
import { readReceipt, type AttestationReceipt } from './attestation.ts'

export const ROUTER_BASE_URL = 'https://router-api.0g.ai/v1'

export class OGRouterError extends Error {
  // Written as an explicit field rather than a constructor parameter property:
  // we run TypeScript through Node's type-stripping, which does not support
  // parameter properties because they emit runtime code.
  readonly attempts: ReadonlyArray<{ model: string; error: string }>

  constructor(message: string, attempts: ReadonlyArray<{ model: string; error: string }>) {
    super(message)
    this.name = 'OGRouterError'
    this.attempts = attempts
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
  /** Cost in USD, computed from the Router's published per-token pricing. */
  usd: number
}

export interface CompleteOptions {
  task: TaskName
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
  const chain: readonly ModelSpec[] = CHAINS[opts.task]
  const attempts: Array<{ model: string; error: string }> = []

  for (const [index, model] of chain.entries()) {
    try {
      const verifyTee = opts.verifyTee !== false

      const response = await client.chat.completions.create(
        {
          model: model.id,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 800,
          temperature: opts.temperature ?? 0.2,
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
          usd:
            promptTokens * model.usdPerPromptToken +
            completionTokens * model.usdPerCompletionToken,
        },
        attestation,
      }
    } catch (error) {
      if (isNonRetryable(error)) throw error
      attempts.push({ model: model.id, error: describe(error) })
    }
  }

  throw new OGRouterError(`All ${chain.length} models failed for task "${opts.task}".`, attempts)
}

/** 4xx other than 408 and 429 means the next model would reject it identically. */
function isNonRetryable(error: unknown): boolean {
  const status = (error as { status?: number }).status
  if (typeof status !== 'number') return false
  if (status === 408 || status === 429) return false
  return status >= 400 && status < 500
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Strip markdown fences some models add despite json_schema mode. */
export function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  return (fenced?.[1] ?? text).trim()
}
