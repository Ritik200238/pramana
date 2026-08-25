/**
 * 0G Compute, paid for directly from a wallet instead of through the Router.
 *
 * The Router (`router-api.0g.ai`) is a hosted convenience layer: you create an
 * `sk-` key on a website, it picks providers for you, and it bills you. It is a
 * good default and the product uses it.
 *
 * This is the other path 0G documents, and it is the one that makes the
 * integration self-contained: the broker discovers providers from the on-chain
 * marketplace, signs each request with the wallet's own key, and settles the
 * fee on 0G Chain afterwards. No account on anybody's website, no API key to
 * issue or revoke, and the TEE attestation comes from the provider record
 * rather than from a service telling us it checked.
 *
 * The provider endpoints are OpenAI-compatible, so this deliberately produces
 * an `OpenAI` client rather than a parallel API. Everything already built on
 * top — the model chain, JSON-schema decoding, cost accounting, failover —
 * works against it unchanged, which is the whole reason to shape it this way.
 *
 * Docs: `oglabs resources/0g-agent-skills`, examples/ai-chatbot.
 * Provider requirements are the provider's, not ours: at the time of writing
 * the live chatbot provider demands a 1 0G minimum reserve locked in its
 * sub-account before it will answer at all.
 */

import OpenAI from 'openai'
import type { AttestationReceipt } from './attestation.ts'
import type { ModelSpec } from './models.ts'

/** The subset of the broker this module needs, so it can be faked in a test. */
export interface InferenceBroker {
  listService(): Promise<unknown[]>
  getServiceMetadata(provider: string): Promise<{ endpoint: string; model: string }>
  getRequestHeaders(provider: string, content?: string): Promise<Record<string, string>>
  processResponse(provider: string, chatId?: string, usage?: string): Promise<unknown>
}

/**
 * A provider as the marketplace describes it.
 *
 * `listService` returns positional tuples rather than objects, so the indices
 * are named here once instead of at every call site.
 */
export interface ComputeService {
  provider: string
  serviceType: string
  url: string
  inputPriceNeuron: bigint
  outputPriceNeuron: bigint
  model: string
  verifiability: string
  teeVerified: boolean
}

const FIELD = {
  provider: 0,
  serviceType: 1,
  url: 2,
  inputPrice: 3,
  outputPrice: 4,
  model: 6,
  verifiability: 7,
  teeVerified: 10,
} as const

export function readService(tuple: readonly unknown[]): ComputeService {
  return {
    provider: String(tuple[FIELD.provider]),
    serviceType: String(tuple[FIELD.serviceType]),
    url: String(tuple[FIELD.url]),
    inputPriceNeuron: BigInt(tuple[FIELD.inputPrice] as bigint),
    outputPriceNeuron: BigInt(tuple[FIELD.outputPrice] as bigint),
    model: String(tuple[FIELD.model]),
    verifiability: String(tuple[FIELD.verifiability]),
    teeVerified: tuple[FIELD.teeVerified] === true,
  }
}

/** Every chatbot provider currently on the marketplace. */
export async function listChatServices(broker: InferenceBroker): Promise<ComputeService[]> {
  const services = await broker.listService()
  return services
    .map((s) => readService(s as readonly unknown[]))
    .filter((s) => s.serviceType === 'chatbot' || s.serviceType === 'chat')
}

/**
 * Pick a provider to serve health data.
 *
 * Unverified providers are refused rather than ranked last. A plate photograph
 * with a face in it, or somebody's blood work, is not something to hand to an
 * unattested machine because it happened to be cheaper.
 */
export function chooseService(services: ComputeService[]): ComputeService {
  const verified = services.filter((s) => s.teeVerified)
  if (verified.length === 0) {
    throw new Error(
      'No TEE-verified chatbot provider is available on 0G Compute. Refusing to send health ' +
        'data to an unattested provider.',
    )
  }
  // Cheapest output, since output dominates: a meal breakdown is a short prompt
  // and a long structured answer.
  return verified.sort((a, b) => (a.outputPriceNeuron < b.outputPriceNeuron ? -1 : 1))[0]!
}

export interface BrokerClientOptions {
  broker: InferenceBroker
  /** The provider to talk to. Discover one with `listChatServices`/`chooseService`. */
  provider: string
  endpoint: string
  timeoutMs?: number
  /**
   * Settlement is what actually pays the provider. It is awaited by default so
   * that a failure to settle is visible; a caller that would rather not block
   * the response on a chain write can turn it off and settle on its own.
   */
  settle?: boolean
  onSettleError?: (error: unknown) => void
}

/**
 * An OpenAI client whose requests are signed by the wallet and settled on chain.
 *
 * The signature covers the request body, so headers cannot be made once and
 * reused — they are produced per call, inside `fetch`, where the body is
 * finally known.
 */
export function createBrokerClient(options: BrokerClientOptions): OpenAI {
  const { broker, provider, endpoint } = options
  const settle = options.settle ?? true

  const brokerFetch: typeof fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : undefined
    const headers = await broker.getRequestHeaders(provider, body)

    const merged = new Headers(init?.headers)
    for (const [key, value] of Object.entries(headers)) merged.set(key, value)

    const response = await fetch(input, { ...init, headers: merged })
    if (!response.ok || !settle) return response

    /*
     * Read the settlement details from a copy. The SDK still has to consume the
     * original, and a body can only be read once.
     */
    let chatId: string | undefined
    let usage: string | undefined
    try {
      const copy = response.clone()
      const data = (await copy.json()) as { id?: string; usage?: unknown }
      chatId =
        response.headers.get('ZG-Res-Key') ??
        response.headers.get('zg-res-key') ??
        data.id ??
        undefined
      usage = data.usage === undefined ? undefined : JSON.stringify(data.usage)
    } catch {
      // A response we cannot parse is still the caller's to handle. Settlement
      // is skipped rather than guessed at.
      return response
    }

    try {
      await broker.processResponse(provider, chatId, usage)
    } catch (error) {
      /*
       * The answer is already in hand and is not withheld over a failed
       * settlement — but unsettled fees accumulate against the sub-account and
       * eventually the provider stops answering, so this must be reported
       * rather than swallowed.
       */
      options.onSettleError?.(error)
    }

    return response
  }

  return new OpenAI({
    // The broker signs requests; there is no API key in this path. The SDK
    // requires the field to be present.
    apiKey: 'unused-broker-auth',
    baseURL: endpoint,
    timeout: options.timeoutMs ?? 30_000,
    maxRetries: 0,
    fetch: brokerFetch,
  })
}

/**
 * The model chain for a directly-reached provider.
 *
 * One entry, because there is no failover to arrange: the provider was chosen
 * from the marketplace and its sub-account is funded. Losing it means choosing
 * again from the marketplace, which is a different operation than trying the
 * next model in a list.
 */
export function serviceChain(service: ComputeService): readonly ModelSpec[] {
  /*
   * Pricing comes straight from the on-chain marketplace record, in neuron per
   * token. Unlike the Router catalogue — a hand-maintained mirror that had
   * drifted on three of six models, one by 135% — this cannot go stale: it is
   * the number the contract will charge.
   *
   * Converted to USD-per-token only because ModelSpec is shaped that way for
   * budgeting. The exact charge is still whatever settles on chain.
   */
  const neuronToUsd = (neuron: bigint): number => Number(neuron) / 1e18

  return [
    {
      id: service.model,
      // Read from the record rather than assumed. `chooseService` has already
      // refused anything unattested, so in practice this is always true.
      tee: service.teeVerified,
      // qwen2.5-omni takes images as well as text, which is what a plate photo
      // needs. Claimed only for models whose name says so, because guessing
      // wrong here means sending a photograph to something that cannot read it.
      vision: service.model.includes('omni') || service.model.includes('vl'),
      usdPerPromptToken: neuronToUsd(service.inputPriceNeuron),
      usdPerCompletionToken: neuronToUsd(service.outputPriceNeuron),
      /*
       * Conservative on purpose. The marketplace record does not carry a
       * `supported_parameters` list the way the Router catalogue does, and
       * there is no upside to sending an option a provider might reject — that
       * lesson already cost this codebase once, when `temperature` was sent
       * unconditionally to a model that does not advertise it.
       */
      supports: { temperature: false, responseFormat: false },
    },
  ]
}

/**
 * Where an answer from this provider ran, and on what evidence.
 *
 * The Router returns `x_0g_trace` per response and we check that. A provider
 * reached directly returns no such thing, and pretending otherwise would be the
 * worst kind of security theatre — so provenance here comes from the place it
 * actually lives: the marketplace record on 0G Chain, which carries the
 * provider's attestation flag, the verifier it attests through, and the address
 * that signed for it.
 *
 * That is established when the provider is chosen, not per request, and this
 * says so rather than implying a per-response signature we never saw.
 */
export function serviceAttestation(service: ComputeService, requestId?: string): AttestationReceipt {
  return {
    requestId: requestId ?? null,
    provider: service.provider,
    model: service.model,
    // `chooseService` refuses an unattested provider outright, so anything that
    // reaches here is attested — but this reads the record rather than trusting
    // that, because the two could drift apart and this is the honest one.
    status: service.teeVerified ? 'verified' : 'unavailable',
    verifiedAt: new Date().toISOString(),
  }
}
