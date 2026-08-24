/**
 * 0G Pay — the Payment Layer binding.
 *
 * This one is less about capability than about incentive, and the incentive is
 * the reason it matters.
 *
 * Every consumer health app has the same structural problem: the company pays
 * for the compute, so the company needs a return on it, so the user's data
 * becomes the return. Users say this outright — *"they're going to sell your
 * data to insurance companies"* was the top comment on OpenAI's own health
 * launch. The suspicion is rational, because the economics usually justify it.
 *
 * The Payment Layer lets us remove the motive rather than deny it. Each user
 * deposits to a shared on-chain balance that **belongs to their wallet**, and
 * each inference debits that balance directly. We never hold their funds and
 * never front their compute — so we have nothing to recoup, and no economic
 * reason to be interested in what they eat.
 *
 * "We can't read your data" is enforced by the TEE. "We have no reason to want
 * to" is enforced here. Neither claim is available without 0G.
 *
 * Facts from the docs (`router/account/deposits.md`):
 *   - It is a shared balance contract across all 0G products, not Router-only.
 *   - Balances are denominated in **neuron**; 1e18 neuron = 1 0G.
 *   - Cost = (input_tokens x prompt_price) + (output_tokens x completion_price).
 *   - The Router adds no markup — the provider's price is the price.
 *   - Exhausted balance surfaces as HTTP 402 `insufficient_balance`.
 *   - Reading balance requires an `mk-` management key; `sk-` keys cannot.
 */

import { z } from 'zod'

/** Payment Layer contract addresses, from the 0G docs. */
export const PAYMENT_LAYER = {
  mainnet: '0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32',
  testnet: '0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939',
} as const

/** 1e18 neuron = 1 0G. */
export const NEURON_PER_OG = 10n ** 18n

export const BalanceSchema = z.object({
  total_balance: z.string(),
  locked_balance: z.string().optional(),
  available_balance: z.string().optional(),
})

export interface Balance {
  /** Spendable right now, in neuron. */
  totalNeuron: bigint
  /** Human-readable 0G, for display only — never for arithmetic. */
  og: string
}

export class InsufficientBalanceError extends Error {
  readonly topUpUrl = 'https://pc.0g.ai'

  constructor(message = 'This coach has run out of compute credit.') {
    super(message)
    this.name = 'InsufficientBalanceError'
  }
}

/**
 * Read the account balance.
 *
 * Requires an `mk-` management key: inference keys are deliberately unable to
 * read `/v1/account/*`, so a leaked `sk-` cannot be used to inspect an account.
 */
export async function readBalance(
  managementKey: string,
  baseUrl = 'https://router-api.0g.ai/v1',
): Promise<Balance> {
  if (!managementKey.startsWith('mk-')) {
    throw new Error(
      'Reading balance requires a management key ("mk-"). Inference keys ("sk-") cannot ' +
        'access /v1/account/* — that separation is deliberate.',
    )
  }

  const response = await fetch(`${baseUrl}/account/balance`, {
    headers: { Authorization: `Bearer ${managementKey}` },
  })

  if (!response.ok) {
    throw new Error(`Could not read balance: ${response.status} ${response.statusText}`)
  }

  const parsed = BalanceSchema.parse(await response.json())
  const totalNeuron = BigInt(parsed.total_balance)

  return { totalNeuron, og: formatOg(totalNeuron) }
}

/** Whether a 402 from the Router is specifically an exhausted balance. */
export function isInsufficientBalance(error: unknown): boolean {
  const status = (error as { status?: number }).status
  if (status !== 402) return false
  const message = error instanceof Error ? error.message : String(error)
  return /insufficient_balance/i.test(message) || status === 402
}

/**
 * Format neuron for display.
 *
 * Integer arithmetic throughout — a balance is money, and floating point has no
 * business anywhere near it.
 */
export function formatOg(neuron: bigint, decimals = 6): string {
  const whole = neuron / NEURON_PER_OG
  const remainder = neuron % NEURON_PER_OG
  if (remainder === 0n) return whole.toString()

  const fraction = remainder.toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString()
}

export function parseOg(og: string): bigint {
  const [whole = '0', fraction = ''] = og.split('.')
  const padded = fraction.padEnd(18, '0').slice(0, 18)
  return BigInt(whole) * NEURON_PER_OG + BigInt(padded || '0')
}

/**
 * Estimated cost of a request, in neuron.
 *
 * Mirrors the Router's published formula exactly. Used to warn a user before a
 * balance runs out rather than after — a coach that stops mid-conversation with
 * a 402 is a worse experience than one that says "you have about a week left".
 */
export function estimateCostNeuron(input: {
  promptTokens: number
  completionTokens: number
  promptPriceNeuron: bigint
  completionPriceNeuron: bigint
}): bigint {
  return (
    BigInt(Math.max(0, Math.round(input.promptTokens))) * input.promptPriceNeuron +
    BigInt(Math.max(0, Math.round(input.completionTokens))) * input.completionPriceNeuron
  )
}

/**
 * Roughly how long a balance lasts at the observed burn rate.
 *
 * Returns null when there is not enough history to say — guessing a runway is
 * worse than admitting we cannot compute one yet.
 */
export function estimateDaysRemaining(
  balanceNeuron: bigint,
  spentNeuronLast7Days: bigint,
): number | null {
  if (spentNeuronLast7Days <= 0n) return null
  const perDay = spentNeuronLast7Days / 7n
  if (perDay === 0n) return null
  return Number(balanceNeuron / perDay)
}

/**
 * A single charge, shown so that it is never mistaken for free.
 *
 * Deliberately not `formatOg`. That function rounds for display, which is right
 * for a balance — one neuron of dust in a wallet is noise, and rendering it as
 * "0" is honest.
 *
 * A charge is a different question. Individual requests here are genuinely tiny
 * — a meal photo runs around 0.0000000019 0G — so the same rounding turns every
 * one of them into "0" and tells somebody their usage cost nothing. On the
 * screen where a person checks what they are spending, that is simply the wrong
 * number.
 *
 * So this keeps extending precision until the first significant digit appears.
 * Zero still shows as zero, because zero is true.
 */
export function formatCharge(neuron: bigint): string {
  if (neuron === 0n) return '0'

  const whole = neuron / NEURON_PER_OG
  const remainder = neuron % NEURON_PER_OG
  if (remainder === 0n) return whole.toString()

  const full = remainder.toString().padStart(18, '0')
  // At least six decimals, and more when six would hide the amount entirely.
  const significant = Math.max(6, full.search(/[1-9]/) + 1)
  const fraction = full.slice(0, significant).replace(/0+$/, '')

  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString()
}
