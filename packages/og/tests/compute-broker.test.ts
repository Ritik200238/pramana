/**
 * The wallet-paid path to 0G Compute.
 *
 * Nothing here needs the network. What it pins down is the part that would be
 * expensive to get wrong once funded: that a request is signed over its own
 * body, that the answer is settled on chain afterwards, that a settlement
 * failure does not swallow the answer, and that health data is never sent to a
 * provider whose TEE attestation is absent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseService,
  createBrokerClient,
  listChatServices,
  readService,
  type ComputeService,
  type InferenceBroker,
} from '../src/compute-broker.ts'

/** Shaped exactly as `listService` returns it — positional, not named. */
function tuple(over: Partial<ComputeService> = {}): unknown[] {
  const s = {
    provider: '0xa48f01287233509FD694a22Bf840225062E67836',
    serviceType: 'chatbot',
    url: 'https://compute-network-6.example',
    inputPriceNeuron: 1_040_000_000_000n,
    outputPriceNeuron: 4_180_000_000_000n,
    model: 'qwen/qwen2.5-omni-7b',
    verifiability: 'TeeML',
    teeVerified: true,
    ...over,
  }
  return [
    s.provider, s.serviceType, s.url, s.inputPriceNeuron, s.outputPriceNeuron,
    1787619758n, s.model, s.verifiability, '{}', '0x0', s.teeVerified,
  ]
}

test('a marketplace tuple is read by name, not by index at the call site', () => {
  const service = readService(tuple())

  // These indices are the contract's, and getting one wrong would silently
  // read a price as a timestamp.
  assert.equal(service.provider, '0xa48f01287233509FD694a22Bf840225062E67836')
  assert.equal(service.serviceType, 'chatbot')
  assert.equal(service.model, 'qwen/qwen2.5-omni-7b')
  assert.equal(service.inputPriceNeuron, 1_040_000_000_000n)
  assert.equal(service.outputPriceNeuron, 4_180_000_000_000n)
  assert.equal(service.verifiability, 'TeeML')
  assert.equal(service.teeVerified, true)
})

test('only chat providers are considered', async () => {
  const broker = {
    listService: async () => [tuple(), tuple({ serviceType: 'image-editing' })],
  } as unknown as InferenceBroker

  const chat = await listChatServices(broker)
  assert.equal(chat.length, 1)
  assert.equal(chat[0]!.serviceType, 'chatbot')
})

test('an unattested provider is refused, not merely ranked last', () => {
  const unverified = [readService(tuple({ teeVerified: false, outputPriceNeuron: 1n }))]

  // Cheaper by a factor of four thousand, and still refused. A plate photograph
  // with a face in it is not something to hand to an unattested machine because
  // it happened to cost less.
  assert.throws(() => chooseService(unverified), /TEE-verified/)
})

test('among attested providers the cheaper output wins', () => {
  const services = [
    readService(tuple({ provider: '0xexpensive', outputPriceNeuron: 9n })),
    readService(tuple({ provider: '0xcheap', outputPriceNeuron: 2n })),
    readService(tuple({ provider: '0xcheapest-but-unattested', outputPriceNeuron: 1n, teeVerified: false })),
  ]
  assert.equal(chooseService(services).provider, '0xcheap')
})

test('each request is signed over its own body and settled afterwards', async () => {
  const signed: Array<string | undefined> = []
  const settled: Array<{ chatId: string | undefined; usage: string | undefined }> = []

  const broker = {
    getRequestHeaders: async (_provider: string, content?: string) => {
      signed.push(content)
      return { 'X-Phala-Signature-Type': 'StandaloneApi', Address: '0xcaller' }
    },
    processResponse: async (_p: string, chatId?: string, usage?: string) => {
      settled.push({ chatId, usage })
    },
  } as unknown as InferenceBroker

  const body = {
    id: 'chatcmpl-abc',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    model: 'qwen/qwen2.5-omni-7b',
    object: 'chat.completion',
    created: 0,
  }

  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'ZG-Res-Key': 'zg-key-1' },
    })) as typeof fetch

  try {
    const client = createBrokerClient({
      broker,
      provider: '0xprovider',
      endpoint: 'https://provider.example/v1/proxy',
    })

    const result = await client.chat.completions.create({
      model: 'qwen/qwen2.5-omni-7b',
      messages: [{ role: 'user', content: 'one katori of dal' }],
    })

    assert.equal(result.choices[0]!.message.content, 'ok')

    // Signed over the body: the signature is per request, so headers made once
    // and reused would be rejected by the provider.
    assert.equal(signed.length, 1)
    assert.match(signed[0] ?? '', /one katori of dal/)

    // Settled on chain, with the id the provider returned in its header rather
    // than the one in the body — the header is authoritative.
    assert.deepEqual(settled, [
      { chatId: 'zg-key-1', usage: JSON.stringify(body.usage) },
    ])
  } finally {
    globalThis.fetch = original
  }
})

test('a failed settlement is reported, and does not eat the answer', async () => {
  const failures: unknown[] = []
  const broker = {
    getRequestHeaders: async () => ({}),
    processResponse: async () => {
      throw new Error('chain write failed')
    },
  } as unknown as InferenceBroker

  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: 'x',
        choices: [{ message: { role: 'assistant', content: 'still here' }, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: 'm', object: 'chat.completion', created: 0,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch

  try {
    const client = createBrokerClient({
      broker,
      provider: '0xprovider',
      endpoint: 'https://provider.example/v1/proxy',
      onSettleError: (error) => failures.push(error),
    })

    const result = await client.chat.completions.create({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    })

    // The work is done and paid for from the user's point of view; withholding
    // it would lose the answer and the fee.
    assert.equal(result.choices[0]!.message.content, 'still here')

    // But unsettled fees accumulate against the sub-account until the provider
    // stops answering, so this must never be silent.
    assert.equal(failures.length, 1)
    assert.match(String((failures[0] as Error).message), /chain write failed/)
  } finally {
    globalThis.fetch = original
  }
})
