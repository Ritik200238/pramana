/**
 * Preflight.
 *
 * Answers one question, against live systems rather than against a test double:
 * would this deployment work right now?
 *
 * It exists because "production-ready" is otherwise a claim somebody makes in a
 * pull request. Every check below either passes against the real dependency or
 * says exactly what is missing and how to supply it. A required check that
 * fails exits non-zero, so this can gate a deploy.
 *
 *   npm run preflight -w @ogt/api
 *
 * Checks marked optional describe capability rather than health: the server
 * runs without on-chain anchoring, but it is not the product that was designed.
 */

import { ethers } from 'ethers'
import { CHAINS, MODELS, NETWORKS, ROUTER_BASE_URL } from '@ogt/og'
import { loadConfig } from './config.ts'
import { createDb } from './db/index.ts'
import { createSmsSender } from './services/sms.ts'

type State = 'ok' | 'warn' | 'fail'

interface Result {
  name: string
  state: State
  detail: string
  /** A failure here means the deployment does not work. */
  required: boolean
}

const results: Result[] = []

function record(name: string, state: State, detail: string, required = true): void {
  results.push({ name, state, detail, required })
}

async function check(
  name: string,
  required: boolean,
  body: () => Promise<{ state: State; detail: string }>,
): Promise<void> {
  try {
    const { state, detail } = await body()
    record(name, state, detail, required)
  } catch (error) {
    // Driver errors arrive with the whole failed query attached. The first line
    // is the part a person reading a deploy log needs.
    const message = error instanceof Error ? error.message : String(error)
    record(name, 'fail', message.split('\n')[0]!.slice(0, 160), required)
  }
}

async function main(): Promise<void> {
  console.log('\nPreflight — checking this deployment against live systems\n')

  // ------------------------------------------------------------- configuration

  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
    record('config', 'ok', `NODE_ENV=${config.NODE_ENV}, network=${config.OG_NETWORK}`)
  } catch (error) {
    // Nothing below can be checked without it, so this is the one hard stop.
    console.error('  config  FAIL', error instanceof Error ? error.message : error)
    process.exit(1)
  }

  const network = NETWORKS[config.OG_NETWORK]
  const isProduction = config.NODE_ENV === 'production'

  // ---------------------------------------------------------------- database

  await check('database', true, async () => {
    const { db, close } = createDb(config.DATABASE_URL, { max: 1 })
    try {
      const rows = await db.execute(
        "select count(*)::int as count from information_schema.tables where table_schema = 'public'",
      )
      const list = (rows as unknown as { rows?: Array<{ count: number }> }).rows ?? rows
      const tables = (list as Array<{ count: number }>)[0]?.count ?? 0

      // A reachable database with no tables is a migration that never ran, and
      // it fails on the first request rather than at boot.
      if (tables === 0) {
        return { state: 'fail', detail: 'reachable, but no tables — run the migrations' }
      }
      return { state: 'ok', detail: `reachable, ${tables} tables` }
    } finally {
      await close()
    }
  })

  // ------------------------------------------------------------- sms delivery

  await check('sms delivery', true, async () => {
    const sender = createSmsSender({
      isProduction,
      url: config.SMS_PROVIDER_URL,
      headers: config.SMS_PROVIDER_HEADERS,
      body: config.SMS_PROVIDER_BODY,
      log: () => {},
    })

    if (sender.name === 'console') {
      return {
        state: 'warn',
        detail: 'console sender — fine for development, nobody can sign in in production',
      }
    }
    return { state: 'ok', detail: `configured: ${sender.name}` }
  })

  // ------------------------------------------------------------- 0G Compute

  await check('0G Router catalogue', true, async () => {
    const response = await fetch(`${ROUTER_BASE_URL}/models`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return { state: 'fail', detail: `catalogue returned ${response.status}` }

    const body = (await response.json()) as {
      data: Array<{ id: string; tee_attested?: boolean | null }>
    }
    const live = new Map(body.data.map((m) => [m.id, m]))

    const missing = Object.values(MODELS)
      .map((m) => m.id)
      .filter((id) => !live.has(id))
    if (missing.length > 0) {
      return { state: 'fail', detail: `configured models no longer offered: ${missing.join(', ')}` }
    }

    // The load-bearing check for the privacy claim on the sign-in screen.
    const unattested = Object.values(CHAINS)
      .flat()
      .filter((model) => live.get(model.id)?.tee_attested !== true)
      .map((model) => model.id)
    if (unattested.length > 0) {
      return { state: 'fail', detail: `routed but NOT TEE-attested: ${unattested.join(', ')}` }
    }

    return { state: 'ok', detail: `${live.size} models, every routed model TEE-attested` }
  })

  await check('0G Router inference', true, async () => {
    const response = await fetch(`${ROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.OG_ROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: CHAINS.coach[0]!.id,
        messages: [{ role: 'user', content: 'Reply with: ok' }],
        max_tokens: 8,
        verify_tee: true,
      }),
      signal: AbortSignal.timeout(60_000),
    })

    if (response.status === 401 || response.status === 403) {
      return { state: 'fail', detail: 'key rejected — create an sk- inference key at pc.0g.ai' }
    }
    if (response.status === 402) {
      return { state: 'fail', detail: 'key has no balance — deposit 0G at pc.0g.ai' }
    }
    if (!response.ok) {
      return { state: 'fail', detail: `inference returned ${response.status}` }
    }

    const body = (await response.json()) as {
      model?: string
      x_0g_trace?: { tee_verified?: boolean | null; provider?: string | null }
    }
    const trace = body.x_0g_trace

    if (!trace) {
      // The whole privacy claim rests on this field coming back.
      return { state: 'fail', detail: 'no x_0g_trace returned — verify_tee is not being honoured' }
    }
    if (trace.tee_verified !== true) {
      return { state: 'fail', detail: `TEE not verified (tee_verified=${trace.tee_verified})` }
    }

    return {
      state: 'ok',
      detail: `${body.model ?? 'model'} answered, TEE verified by ${trace.provider ?? 'provider'}`,
    }
  })

  // --------------------------------------------------------------- 0G Chain

  await check('0G Chain RPC', true, async () => {
    const rpc = config.OG_RPC_URL_OVERRIDE ?? network.rpcUrl
    const provider = new ethers.JsonRpcProvider(rpc)
    const [chainId, block] = await Promise.all([
      provider.getNetwork().then((n) => Number(n.chainId)),
      provider.getBlockNumber(),
    ])

    if (chainId !== network.chainId) {
      return { state: 'fail', detail: `expected chain ${network.chainId}, got ${chainId}` }
    }
    return { state: 'ok', detail: `chain ${chainId} at block ${block}` }
  })

  await check('storage signer balance', true, async () => {
    const rpc = config.OG_RPC_URL_OVERRIDE ?? network.rpcUrl
    const provider = new ethers.JsonRpcProvider(rpc)
    const wallet = new ethers.Wallet(config.OG_STORAGE_PRIVATE_KEY)
    const balance = await provider.getBalance(wallet.address)

    if (balance === 0n) {
      return {
        state: 'fail',
        detail: `${wallet.address} holds nothing — storage writes will fail`,
      }
    }
    return { state: 'ok', detail: `${wallet.address} holds ${ethers.formatEther(balance)} 0G` }
  })

  await check('on-chain anchoring', false, async () => {
    if (!config.OG_ANCHOR_ADDRESS || !config.OG_ANCHOR_MASTER_SEED) {
      const missing = [
        config.OG_ANCHOR_ADDRESS ? null : 'OG_ANCHOR_ADDRESS',
        config.OG_ANCHOR_MASTER_SEED ? null : 'OG_ANCHOR_MASTER_SEED',
      ].filter(Boolean)
      return {
        state: 'warn',
        detail: `${missing.join(' and ')} unset — snapshots stay off chain`,
      }
    }

    const rpc = config.OG_RPC_URL_OVERRIDE ?? network.rpcUrl
    const provider = new ethers.JsonRpcProvider(rpc)
    const code = await provider.getCode(config.OG_ANCHOR_ADDRESS)

    // An address with no code is a typo or a wrong-network address, and every
    // anchor would silently succeed while doing nothing.
    if (code === '0x') {
      return { state: 'fail', detail: `no contract at ${config.OG_ANCHOR_ADDRESS} on this network` }
    }
    // The relayer pays for every anchor, so an empty one stops anchoring
    // silently unless it is checked here.
    const relayer = new ethers.Wallet(config.OG_STORAGE_PRIVATE_KEY)
    const balance = await provider.getBalance(relayer.address)
    if (balance < ethers.parseEther('0.01')) {
      return {
        state: 'fail',
        detail: `contract is deployed, but relayer ${relayer.address} cannot pay for anchors`,
      }
    }

    return { state: 'ok', detail: `deployed at ${config.OG_ANCHOR_ADDRESS}, relayer funded` }
  })

  await check('coach ownership', false, async () => {
    if (!config.OG_COACH_ADDRESS || !config.OG_ANCHOR_MASTER_SEED) {
      return {
        state: 'warn',
        detail: 'OG_COACH_ADDRESS unset — coaches are never minted, so nobody owns one',
      }
    }

    const rpc = config.OG_RPC_URL_OVERRIDE ?? network.rpcUrl
    const provider = new ethers.JsonRpcProvider(rpc)
    const code = await provider.getCode(config.OG_COACH_ADDRESS)
    if (code === '0x') {
      return { state: 'fail', detail: `no contract at ${config.OG_COACH_ADDRESS} on this network` }
    }
    return { state: 'ok', detail: `CoachAgent deployed at ${config.OG_COACH_ADDRESS}` }
  })

  await check('0G Storage indexer', true, async () => {
    const response = await fetch(network.indexerUrl, { signal: AbortSignal.timeout(20_000) })
    // Any answer proves reachability; the endpoint is not a health check.
    return { state: 'ok', detail: `${network.indexerUrl} reachable (${response.status})` }
  })

  // ----------------------------------------------------------------- report

  const width = Math.max(...results.map((r) => r.name.length))
  const mark: Record<State, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

  console.log('')
  for (const result of results) {
    console.log(`  ${mark[result.state]}  ${result.name.padEnd(width)}  ${result.detail}`)
  }

  const failures = results.filter((r) => r.state === 'fail')
  const blocking = failures.filter((r) => r.required)
  const warnings = results.filter((r) => r.state === 'warn')

  console.log('')
  if (blocking.length > 0) {
    console.log(`NOT READY — ${blocking.length} required check(s) failed.\n`)
    process.exit(1)
  }
  if (failures.length > 0 || warnings.length > 0) {
    console.log(`Usable, with ${warnings.length + failures.length} caveat(s) above.\n`)
    process.exit(0)
  }
  console.log('Ready. Every dependency answered.\n')
}

await main()
