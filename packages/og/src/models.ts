/**
 * 0G Compute model registry and task chains.
 *
 * Two facts from the live Router catalogue drive everything here, and both were
 * verified against `GET https://router-api.0g.ai/v1/models` rather than assumed:
 *
 *   1. Most models are served by only one or two providers. The Router fails
 *      over *within* a model's provider set, so a single-provider model is a
 *      single point of failure for a consumer app. Every task therefore
 *      declares an ordered chain across different models.
 *
 *   2. Only some models are TEE-attested. The `claude-*` and `gpt-*` entries
 *      report `tee_attested: null` - they are proxied to the original provider.
 *      That is billing convenience, not a confidential-execution guarantee, so
 *      they are absent from every chain below. Identified health data must
 *      never reach them while we make the privacy claim.
 */

export interface ModelSpec {
  readonly id: string
  /** Hardware-attested confidential execution (Intel TDX via dstack). */
  readonly tee: boolean
  readonly vision: boolean
  /** USD per input token, from the Router catalogue. Used for cost accounting. */
  readonly usdPerPromptToken: number
  readonly usdPerCompletionToken: number
}

export const MODELS = {
  qwen3vl30b: {
    id: 'qwen3-vl-30b',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.00000001936,
    usdPerCompletionToken: 0.0000001892,
  },
  ogm35b: {
    id: '0gm-1.0-35b-a3b',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.00000008,
    usdPerCompletionToken: 0.00000048,
  },
  qwen37plus: {
    id: 'qwen3.7-plus',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.0000002208,
    usdPerCompletionToken: 0.0000008808,
  },
  qwen38max: {
    id: 'qwen3.8-max',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.00000165,
    usdPerCompletionToken: 0.000004951,
  },
  kimik3: {
    id: 'kimi-k3',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.000003,
    usdPerCompletionToken: 0.000015,
  },
  whisper: {
    id: 'whisper-large-v3',
    tee: true,
    vision: false,
    usdPerPromptToken: 0,
    usdPerCompletionToken: 0,
  },
} as const satisfies Record<string, ModelSpec>

/**
 * Ordered chains, most-preferred first.
 *
 * Meal vision leads with the cheapest capable model because photo logging is
 * the highest-volume call in the product and is what makes a free tier
 * affordable at Indian price points.
 */
export const CHAINS = {
  mealVision: [MODELS.qwen3vl30b, MODELS.ogm35b, MODELS.qwen37plus],
  extraction: [MODELS.qwen37plus, MODELS.qwen38max, MODELS.kimik3],
  coach: [MODELS.qwen37plus, MODELS.qwen38max, MODELS.kimik3],
  speech: [MODELS.whisper],
} as const satisfies Record<string, readonly ModelSpec[]>

export type TaskName = keyof typeof CHAINS

/** Invariant: nothing in any chain may lack TEE attestation. */
export function assertAllChainsAreTeeAttested(): void {
  for (const [task, chain] of Object.entries(CHAINS)) {
    for (const model of chain) {
      if (!model.tee) {
        throw new Error(
          `Model ${model.id} in chain "${task}" is not TEE-attested. Identified health data ` +
            'must only reach attested models.',
        )
      }
    }
  }
}
