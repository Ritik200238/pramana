/**
 * The balance that keeps everything working.
 *
 * When the Router account reaches zero, every inference returns 402 — photos,
 * chat, coaching, transcription. There is no degraded mode; the product stops
 * for everybody at once.
 *
 * `readBalance` had existed the whole time, correct and documented, and was
 * called by nothing outside its own test. That is the same defect as the anchor
 * worker: the code to see the outage coming was written and never wired.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, type Harness } from './helpers/e2e.ts'
import { recentSpendNeuron, startBalanceWatch } from '../src/jobs/balance.ts'

async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  const harness = await startHarness()
  try {
    await body(harness)
  } finally {
    await harness.close()
  }
}

/** Insert usage rows with known charges, for a user that exists. */
async function seedSpend(h: Harness, charges: string[], daysAgo = 1): Promise<void> {
  const rows = await h.db.execute('select id from users limit 1')
  const list = (rows as unknown as { rows?: Array<{ id: string }> }).rows ?? rows
  const userId = (list as Array<{ id: string }>)[0]?.id
  assert.ok(userId, 'seed a user first')

  for (const cost of charges) {
    await h.db.execute(
      `insert into inference_usage
         (user_id, task, model, prompt_tokens, completion_tokens, usd, failovers,
          attestation, cost_neuron, created_at)
       values ('${userId}', 'coach', 'qwen3.7-plus', 10, 10, '0', 0,
               'verified', '${cost}', now() - interval '${daysAgo} days')`,
    )
  }
}

test('spend is summed exactly, with no floating point in the path', async () => {
  await withHarness(async (h) => {
    const { signIn } = await import('./helpers/e2e.ts')
    await signIn(h, '9500000001')

    // Sixteen-digit charges. As doubles these would start losing digits well
    // before the total looked wrong.
    await seedSpend(h, ['1935800000000000', '1935800000000001', '1935800000000002'])

    const total = await recentSpendNeuron(h.db)
    assert.equal(total, 5_807_400_000_000_003n)
  })
})

test('spend outside the window is not counted', async () => {
  await withHarness(async (h) => {
    const { signIn } = await import('./helpers/e2e.ts')
    await signIn(h, '9500000002')

    await seedSpend(h, ['1000000000000000'], 1)
    await seedSpend(h, ['9000000000000000'], 30)

    // A month-old month of spend would make the runway estimate meaningless.
    assert.equal(await recentSpendNeuron(h.db), 1_000_000_000_000_000n)
  })
})

test('rows with no recorded charge are skipped, not guessed at', async () => {
  await withHarness(async (h) => {
    const { signIn } = await import('./helpers/e2e.ts')
    await signIn(h, '9500000003')

    const rows = await h.db.execute('select id from users limit 1')
    const list = (rows as unknown as { rows?: Array<{ id: string }> }).rows ?? rows
    const userId = (list as Array<{ id: string }>)[0]!.id

    // A row from before cost_neuron existed.
    await h.db.execute(
      `insert into inference_usage
         (user_id, task, model, prompt_tokens, completion_tokens, usd, failovers, attestation)
       values ('${userId}', 'coach', 'qwen3.7-plus', 10, 10, '0.00000100', 0, 'verified')`,
    )

    // Estimating it in would inflate spend and shorten the runway on a guess.
    assert.equal(await recentSpendNeuron(h.db), 0n)
  })
})

test('an empty balance is reported as an outage, not a warning', async () => {
  await withHarness(async (h) => {
    const messages: Array<{ level: string; text: string }> = []
    const logger = {
      error: (_o: unknown, text: string) => messages.push({ level: 'error', text }),
      warn: (_o: unknown, text: string) => messages.push({ level: 'warn', text }),
      info: (_o: unknown, text: string) => messages.push({ level: 'info', text }),
    } as never

    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ total_balance: '0', deposit_balance: '0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    try {
      const watch = startBalanceWatch({ db: h.db, managementKey: 'mk-test', logger })
      watch.stop()
      await watch.runOnce()

      // Zero is not "running low". Every model call is already failing.
      assert.equal(messages[0]?.level, 'error')
      assert.match(messages[0]!.text, /402/)
    } finally {
      globalThis.fetch = original
    }
  })
})

test('a balance that cannot be read never takes the server down', async () => {
  await withHarness(async (h) => {
    const messages: string[] = []
    const logger = {
      error: () => undefined,
      warn: (_o: unknown, text: string) => messages.push(text),
      info: () => undefined,
    } as never

    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new TypeError('network down')
    }) as typeof fetch

    try {
      const watch = startBalanceWatch({ db: h.db, managementKey: 'mk-test', logger })
      watch.stop()

      // Not knowing the balance is bad. Refusing to serve because we could not
      // read it would be worse.
      assert.equal(await watch.runOnce(), null)
      assert.match(messages.join(' '), /could not read/i)
    } finally {
      globalThis.fetch = original
    }
  })
})
