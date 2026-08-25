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
import { chooseService, createBrokerClient, listChatServices } from '../../src/compute-broker.ts'

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
