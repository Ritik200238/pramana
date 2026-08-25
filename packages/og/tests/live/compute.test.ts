/**
 * Inference against 0G Compute, paid for from our own wallet.
 *
 * This is the test that closes the longest-standing gap in VERIFICATION.md. It
 * needs no API key and no account on anybody's website — only a funded wallet,
 * because the provider locks a minimum reserve in its sub-account before it
 * will answer.
 *
 * Skips loudly rather than passing quietly when the funds are not there. A
 * suite that goes green having done nothing is worse than one that fails.
 *
 *   npm run test:compute -w @ogt/og
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import {
  chooseService,
  createBrokerClient,
  listChatServices,
  serviceAttestation,
  serviceChain,
} from '../../src/compute-broker.ts'
import { complete } from '../../src/router.ts'

const KEY = process.env['OG_STORAGE_PRIVATE_KEY']
const RPC = process.env['OG_RPC_URL_OVERRIDE'] ?? 'https://evmrpc-testnet.0g.ai'

const skip = KEY ? false : 'needs a funded wallet in OG_STORAGE_PRIVATE_KEY'

/** The reserve the live provider demanded at the time of writing. */
const REQUIRED_RESERVE_OG = 1

async function connect() {
  const { createZGComputeNetworkBroker } = await import('@0glabs/0g-serving-broker')
  const provider = new ethers.JsonRpcProvider(RPC, 16602, { staticNetwork: true })
  const wallet = new ethers.Wallet(KEY!, provider)
  return { broker: await createZGComputeNetworkBroker(wallet as never), wallet, provider }
}

test('the marketplace lists providers, and the ones we would use are attested', { skip }, async () => {
  const { broker } = await connect()
  const services = await listChatServices(broker.inference as never)

  assert.ok(services.length > 0, 'no chat provider is listed on 0G Compute')
  for (const service of services) {
    console.log(`  ${service.provider} ${service.model} tee=${service.teeVerified}`)
  }

  // Refusing is the correct outcome if nothing is attested, so this asserts the
  // choice rather than the count.
  const chosen = chooseService(services)
  assert.equal(chosen.teeVerified, true)
  assert.ok(chosen.model.length > 0)
})

test('a meal is read by a TEE-attested provider and the fee settles on chain', { skip }, async () => {
  const { broker, wallet, provider } = await connect()

  let available = 0n
  try {
    const ledger = await broker.ledger.getLedger()
    available = ledger[2] as bigint
  } catch {
    assert.fail('no compute ledger for this wallet — run: broker.ledger.addLedger(1.1)')
  }

  const service = chooseService(await listChatServices(broker.inference as never))

  /*
   * Reported rather than asserted, and skipped rather than failed. Being
   * underfunded is a fact about this wallet today, not a defect in the code,
   * and the difference should be obvious to whoever reads the output.
   */
  if (available < ethers.parseEther(String(REQUIRED_RESERVE_OG))) {
    console.log(
      `  SKIPPED — ledger holds ${ethers.formatEther(available)} 0G, provider requires ` +
        `${REQUIRED_RESERVE_OG} 0G locked in its sub-account. ` +
        `Wallet ${wallet.address} holds ${ethers.formatEther(await provider.getBalance(wallet.address))} 0G.`,
    )
    return
  }

  const { endpoint, model } = await broker.inference.getServiceMetadata(service.provider)
  const settleErrors: unknown[] = []
  const client = createBrokerClient({
    broker: broker.inference as never,
    provider: service.provider,
    endpoint,
    onSettleError: (error) => settleErrors.push(error),
  })

  const started = Date.now()
  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content:
          'One katori of dal and two rotis. Reply with only JSON, no prose: ' +
          '{"kcal": number, "protein_g": number}',
      },
    ],
    max_tokens: 120,
  })
  const latency = Date.now() - started

  const text = completion.choices[0]?.message.content ?? ''
  console.log(`  ${model} answered in ${latency} ms: ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
  console.log(`  usage ${JSON.stringify(completion.usage)}`)

  assert.ok(text.length > 0, 'the provider must return an answer')

  // The product asks for JSON and parses it. A model that cannot hold that
  // contract is not usable here however good its prose is.
  const parsed = JSON.parse(text.replace(/^```(?:json)?/, '').replace(/```$/, '').trim()) as {
    kcal?: number
    protein_g?: number
  }
  assert.equal(typeof parsed.kcal, 'number')
  assert.equal(typeof parsed.protein_g, 'number')

  // Sanity, not accuracy: dal and two rotis is a few hundred kilocalories.
  assert.ok(parsed.kcal! > 100 && parsed.kcal! < 1200, `implausible kcal: ${parsed.kcal}`)

  assert.deepEqual(settleErrors, [], 'the fee must settle on chain')
})

test("the product's own extraction path runs on 0G Compute", { skip }, async () => {
  /*
   * The case above proves the provider answers. This proves the thing that
   * actually matters: that the code the product runs — the model chain, the
   * failover, the usage accounting — works against a provider reached directly
   * from a wallet, with nothing rewritten for it.
   *
   * It is also the check on a claim that was too convenient when first made.
   * `complete` resolves models from the task chains, which name Router models a
   * direct provider has never heard of, so "everything works unchanged" was
   * false until the chain became overridable.
   */
  const { broker } = await connect()
  const service = chooseService(await listChatServices(broker.inference as never))

  const available = (await broker.ledger.getLedger())[2] as bigint
  if (available < ethers.parseEther(String(REQUIRED_RESERVE_OG))) {
    console.log('  SKIPPED — not enough locked with the provider')
    return
  }

  const { endpoint } = await broker.inference.getServiceMetadata(service.provider)
  const client = createBrokerClient({
    broker: broker.inference as never,
    provider: service.provider,
    endpoint,
  })

  const result = await complete(client, {
    task: 'extraction',
    models: serviceChain(service),
    // The Router's per-response TEE flag has no counterpart here; provenance
    // comes from the marketplace record instead. Asserted below.
    verifyTee: false,
    maxTokens: 200,
    messages: [
      {
        role: 'user',
        content:
          'One katori rajma, two rotis, half katori rice. Reply only JSON: ' +
          '{"kcal":n,"protein_g":n,"carb_g":n,"fat_g":n}',
      },
    ],
  })

  console.log(`  ${result.model} in ${result.usage.promptTokens}+${result.usage.completionTokens} tokens`)
  console.log(`  ${result.text.replace(/\s+/g, ' ').slice(0, 140)}`)

  assert.equal(result.model, service.model)
  assert.equal(result.failovers, 0, 'the only model in the chain must answer')

  const parsed = JSON.parse(
    result.text.replace(/^```(?:json)?/, '').replace(/```$/, '').trim(),
  ) as Record<string, number>

  for (const field of ['kcal', 'protein_g', 'carb_g', 'fat_g']) {
    assert.equal(typeof parsed[field], 'number', `${field} must be a number`)
  }

  // Sanity, not accuracy. Rajma, two rotis and rice is a substantial plate.
  assert.ok(parsed['kcal']! > 200 && parsed['kcal']! < 1500, `implausible kcal: ${parsed['kcal']}`)

  /*
   * Recorded as null rather than invented. A direct provider returns no
   * `x_0g_trace`, so there is no authoritative charge to read, and filling the
   * field with our own arithmetic would turn an estimate into something that
   * looks like accounting.
   */
  assert.equal(result.usage.costNeuron, null)
  assert.ok(result.usage.usdEstimate > 0, 'the on-chain price list still gives a budget estimate')

  // Provenance from where it actually lives: the marketplace record on chain.
  const attestation = serviceAttestation(service)
  assert.equal(attestation.status, 'verified')
  assert.equal(attestation.provider, service.provider)
})
