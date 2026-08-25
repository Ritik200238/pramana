/**
 * The anchor worker.
 *
 * `findPendingAnchors` has existed since the schema did, along with the
 * `anchor_tx_hash` and `anchor_index` columns it fills. Nothing called it. The
 * contract was written, tested to full coverage and given a deploy script; the
 * running product had no path to it, so every snapshot sat in 0G Storage with
 * its pointer held only in our database — which is exactly the arrangement the
 * contract exists to replace.
 *
 * This closes that. It is deliberately conservative: anchoring is a cost, it is
 * permanent, and it is the one thing here that spends money on every pass.
 */

import { eq } from 'drizzle-orm'
import { AnchorClient, deriveOwnerAccount } from '@ogt/og'
import type { FastifyBaseLogger } from 'fastify'
import { ethers } from 'ethers'
import type { Database } from '../db/index.ts'
import type { PassLock } from './pass-lock.ts'
import { snapshots } from '../db/schema.ts'
import { findPendingAnchors } from './scheduler.ts'

export interface AnchorWorkerOptions {
  db: Database
  client: AnchorClient
  /** Derives each user's owning account. Held by us today; see the module docs. */
  masterSeed: string
  logger: FastifyBaseLogger
  intervalMs?: number
  batchSize?: number
  /**
   * Stop anchoring below this relayer balance, in wei.
   *
   * A relayer that runs dry fails every transaction it sends, which costs
   * nothing but produces an error per snapshot per pass forever. Stopping
   * early leaves the backlog intact and says so once.
   */
  minimumBalanceWei?: bigint
  /**
   * Excludes other instances from this pass. Absent means single-instance
   * behaviour, which is what the tests and a one-container deployment want.
   */
  lock?: PassLock | undefined
}

export interface AnchorWorker {
  stop: () => void
  runOnce: () => Promise<{ attempted: number; anchored: number; failed: number }>
}

const DEFAULT_MINIMUM_BALANCE = ethers.parseEther('0.01')

export function startAnchorWorker(options: AnchorWorkerOptions): AnchorWorker {
  const intervalMs = options.intervalMs ?? 15 * 60 * 1000
  const batchSize = options.batchSize ?? 20
  const minimumBalance = options.minimumBalanceWei ?? DEFAULT_MINIMUM_BALANCE

  let running = false

  async function runOnce(): Promise<{ attempted: number; anchored: number; failed: number }> {
    // Two passes at once would spend the same nonce twice and lose one of the
    // transactions to a revert.
    if (running) return { attempted: 0, anchored: 0, failed: 0 }
    running = true

    /*
     * The boolean above covers this process. Another instance has its own, so
     * the lock is what actually keeps two of them out of the same pass.
     */
    let release: (() => Promise<void>) | null = null

    try {
      if (options.lock) {
        release = await options.lock('anchor')
        if (release === null) {
          // Somebody else is mid-pass. Nothing is lost by standing down: the
          // work is still queued and they are doing it.
          return { attempted: 0, anchored: 0, failed: 0 }
        }
      }

      const pending = await findPendingAnchors(options.db, batchSize)
      if (pending.length === 0) return { attempted: 0, anchored: 0, failed: 0 }

      const balance = await options.client.relayerBalance()
      if (balance < minimumBalance) {
        // Said once per pass rather than once per snapshot, and the backlog is
        // left alone: these anchor fine as soon as somebody tops the relayer up.
        options.logger.error(
          {
            relayer: options.client.relayerAddress,
            balance: ethers.formatEther(balance),
            pending: pending.length,
          },
          'anchor relayer is out of funds; anchoring paused',
        )
        return { attempted: 0, anchored: 0, failed: 0 }
      }

      let anchored = 0
      let failed = 0

      for (const snapshot of pending) {
        try {
          const owner = deriveOwnerAccount(options.masterSeed, snapshot.userId)

          // The snapshot's own id is the nonce. It is unique per snapshot and
          // stable across retries, so a transaction that succeeded but whose
          // receipt we lost cannot be anchored a second time — the contract
          // rejects the reused nonce.
          const nonce = BigInt(`0x${snapshot.id.replaceAll('-', '')}`)

          if (await options.client.nonceUsed(owner.address, nonce)) {
            // Already on chain from an earlier pass whose write here failed.
            // Recording that is better than anchoring it twice.
            const index = (await options.client.snapshotCount(owner.address)) - 1
            await options.db
              .update(snapshots)
              .set({ anchorTxHash: 'recovered', anchorIndex: index })
              .where(eq(snapshots.id, snapshot.id))

            options.logger.warn(
              { snapshotId: snapshot.id },
              'snapshot was already anchored on chain; recorded without re-anchoring',
            )
            anchored += 1
            continue
          }

          const result = await options.client.anchor(owner, {
            rootHashes: snapshot.rootHashes,
            schemaVersion: snapshot.schemaVersion,
            nonce,
          })

          await options.db
            .update(snapshots)
            .set({ anchorTxHash: result.txHash, anchorIndex: result.index })
            .where(eq(snapshots.id, snapshot.id))

          options.logger.info(
            {
              snapshotId: snapshot.id,
              owner: owner.address,
              txHash: result.txHash,
              index: result.index,
              gasUsed: result.gasUsed.toString(),
            },
            'snapshot anchored on 0G Chain',
          )
          anchored += 1
        } catch (error) {
          // One snapshot's failure must not stop the batch, and an unanchored
          // snapshot is not lost — it is simply picked up next pass.
          options.logger.error(
            { err: error, snapshotId: snapshot.id },
            'anchoring failed; will retry next pass',
          )
          failed += 1
        }
      }

      return { attempted: pending.length, anchored, failed }
    } finally {
      if (release) {
        // Held to the end of the pass on purpose: releasing early would let a
        // second instance start while this one is still writing.
        await release()
      }
      running = false
    }
  }

  const timer = setInterval(() => {
    void runOnce().catch((error: unknown) => {
      options.logger.error({ err: error }, 'anchor pass failed')
    })
  }, intervalMs)

  timer.unref?.()

  return { stop: () => clearInterval(timer), runOnce }
}
