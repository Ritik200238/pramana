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
  /**
   * USD per token, from the Router catalogue — an estimate, not accounting.
   *
   * Every response reports its exact charge in neuron, and that is what gets
   * recorded. These are for budgeting before a call is made, and they drift:
   * three of six were wrong when last checked against the live catalogue, one
   * by 135% on the highest-volume call in the product, and speech was carried
   * as free when it is billed. `npm run test:live` fails when they drift again.
   *
   * Audio is not billed per token; the catalogue reports its rate in the same
   * field, so treat whisper's figure as the Router's own unit rather than a
   * per-token price.
   */
  readonly usdPerPromptToken: number
  readonly usdPerCompletionToken: number
  /**
   * Optional parameters this model advertises, from the catalogue's
   * `supported_parameters`.
   *
   * Only the ones we actually send are tracked. The Router does not silently
   * drop a parameter a model does not support — the documentation says it
   * answers 400 instead, using `tools` as the example — so sending one that is
   * not advertised is a risk with no upside.
   *
   * It mattered here: `temperature` was sent to every model unconditionally,
   * and kimi-k3 does not list it. kimi-k3 is the last entry in two chains, so
   * the failure would have arrived precisely when the earlier models were
   * already failing and the fallback was the only thing left.
   *
   * `npm run test:live` compares these against the catalogue.
   */
  readonly supports: { readonly temperature: boolean; readonly responseFormat: boolean }
}

export const MODELS = {
  qwen3vl30b: {
    id: 'qwen3-vl-30b',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.0000000359,
    usdPerCompletionToken: 0.0000003587,
    supports: { temperature: true, responseFormat: true },
  },
  ogm35b: {
    id: '0gm-1.0-35b-a3b',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.00000008,
    usdPerCompletionToken: 0.00000048,
    supports: { temperature: true, responseFormat: true },
  },
  qwen37plus: {
    id: 'qwen3.7-plus',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.00000052,
    usdPerCompletionToken: 0.00000208,
    supports: { temperature: true, responseFormat: true },
  },
  qwen38max: {
    id: 'qwen3.8-max',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.00000165,
    usdPerCompletionToken: 0.000004951,
    supports: { temperature: true, responseFormat: true },
  },
  kimik3: {
    id: 'kimi-k3',
    tee: true,
    vision: true,
    usdPerPromptToken: 0.000003,
    usdPerCompletionToken: 0.000015,
    supports: { temperature: false, responseFormat: true },
  },
  whisper: {
    id: 'whisper-large-v3',
    tee: true,
    vision: false,
    usdPerPromptToken: 0.00013,
    usdPerCompletionToken: 0,
    supports: { temperature: false, responseFormat: true },
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
