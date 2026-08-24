/**
 * Watching the balance that keeps the product alive.
 *
 * When the Router account reaches zero, every inference returns 402: photos,
 * chat, coaching, transcription. There is no degraded mode — the product simply
 * stops working for everybody at once.
 *
 * The code to see that coming already existed. `readBalance` was written,
 * correct, documented down to the reason inference keys are refused, and called
 * by nothing outside its own test. Preflight now checks it at deploy, but a
 * balance drains during operation rather than at boot, so it also needs
 * watching while the server runs.
 *
 * This warns rather than acts. Topping up is a decision with money attached and
 * belongs to a person; the job's only duty is to make sure that person is not
 * surprised.
 */

import { estimateDaysRemaining, formatOg, readBalance } from '@ogt/og'
import { and, gte, isNotNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../db/index.ts'
import { inferenceUsage } from '../db/schema.ts'

export interface BalanceWatchOptions {
  db: Database
  managementKey: string
  logger: FastifyBaseLogger
  intervalMs?: number
  /** Warn below this many days of runway. */
  warnBelowDays?: number
}

export interface BalanceWatch {
  stop: () => void
  runOnce: () => Promise<{ og: string; daysRemaining: number | null } | null>
}

const DAY_MS = 24 * 60 * 60 * 1000

export function startBalanceWatch(options: BalanceWatchOptions): BalanceWatch {
  const intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000
  const warnBelowDays = options.warnBelowDays ?? 7

  async function runOnce() {
    try {
      const balance = await readBalance(options.managementKey)

      // Spend over the last week, from what we recorded per request. This is
      // the Router's own reported charge, not an estimate — see the cost work
      // in @ogt/og.
      const spent = await recentSpendNeuron(options.db)
      const days = estimateDaysRemaining(balance.totalNeuron, spent)

      if (balance.totalNeuron === 0n) {
        options.logger.error(
          { balance: balance.og },
          'the 0G Router balance is empty; every inference will now fail with 402',
        )
      } else if (days !== null && days <= warnBelowDays) {
        options.logger.warn(
          { balance: balance.og, daysRemaining: days, spentLast7Days: formatOg(spent) },
          'the 0G Router balance is running low',
        )
      } else {
        options.logger.info({ balance: balance.og, daysRemaining: days }, 'router balance checked')
      }

      return { og: balance.og, daysRemaining: days }
    } catch (error) {
      // Never a reason to take the server down. Not knowing the balance is bad;
      // refusing to serve because we could not read it would be worse.
      options.logger.warn({ err: error }, 'could not read the 0G Router balance')
      return null
    }
  }

  const timer = setInterval(() => {
    void runOnce()
  }, intervalMs)
  timer.unref?.()

  return { stop: () => clearInterval(timer), runOnce }
}

/**
 * What we have actually been charged in the last seven days, in neuron.
 *
 * Summed from `cost_neuron`, which is what the Router reported per request.
 * Rows predating that column are simply absent from the sum rather than
 * estimated into it — an understated figure produces a longer runway estimate,
 * so this is checked against zero before it is trusted.
 */
export async function recentSpendNeuron(db: Database): Promise<bigint> {
  const since = new Date(Date.now() - 7 * DAY_MS)

  const rows = await db
    .select({ cost: inferenceUsage.costNeuron })
    .from(inferenceUsage)
    .where(and(gte(inferenceUsage.createdAt, since), isNotNull(inferenceUsage.costNeuron)))

  let total = 0n
  for (const row of rows) {
    if (!row.cost) continue
    try {
      total += BigInt(row.cost)
    } catch {
      // A malformed row must not stop the sum; it is one request's worth.
    }
  }
  return total
}

/** Exported so a test can pin the window the runway estimate uses. */
export const BALANCE_WINDOW_MS = 7 * DAY_MS
