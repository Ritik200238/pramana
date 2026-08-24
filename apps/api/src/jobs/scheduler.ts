/**
 * The background scheduler.
 *
 * Without this, `runSnapshot` was dead code: 0G Storage was fully implemented,
 * fully typed, fully tested — and never once called. A feature that nothing
 * invokes is not a feature, and "the user owns their encrypted record" was a
 * claim with no mechanism behind it.
 *
 * Deliberately a simple interval rather than a queue. One process, idempotent
 * work, and a clear failure mode beats a job runner we would have to operate
 * before we have a single user. When there are enough users that this matters,
 * it should become a real queue — and the shape here does not fight that.
 */

import { and, gte, isNull, sql } from 'drizzle-orm'
import type { OGStorage } from '@ogt/og'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../db/index.ts'
import { snapshots, users } from '../db/schema.ts'
import { runSnapshot } from './snapshot.ts'

export interface SchedulerOptions {
  db: Database
  storage: OGStorage
  logger: FastifyBaseLogger
  /** How often to look for work. Default hourly. */
  intervalMs?: number
  /** Users per pass. Keeps a backlog from monopolising the process. */
  batchSize?: number
}

export interface Scheduler {
  stop: () => void
  /** Exposed so a deployment can trigger a pass without waiting for the timer. */
  runOnce: () => Promise<{ attempted: number; succeeded: number; failed: number }>
}

const DAY_MS = 24 * 60 * 60 * 1000

export function startScheduler(options: SchedulerOptions): Scheduler {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000
  const batchSize = options.batchSize ?? 25

  let running = false

  async function runOnce(): Promise<{ attempted: number; succeeded: number; failed: number }> {
    // Overlapping passes would double-write snapshots and race on the same
    // rows. A skipped tick is harmless; a concurrent one is not.
    if (running) return { attempted: 0, succeeded: 0, failed: 0 }
    running = true

    try {
      const due = await findUsersDueForSnapshot(options.db, batchSize)
      let succeeded = 0
      let failed = 0

      for (const user of due) {
        try {
          const to = new Date()
          const from = new Date(to.getTime() - 30 * DAY_MS)

          const result = await runSnapshot({
            db: options.db,
            storage: options.storage,
            userId: user.id,
            recordPubKey: user.recordPubKey,
            from,
            to,
          })

          options.logger.info(
            { userId: user.id, rootHashes: result.rootHashes.length, bytes: result.bytes },
            'snapshot written to 0G Storage',
          )
          succeeded += 1
        } catch (error) {
          // One user's failure must not stop the batch. A storage outage
          // should delay everyone's snapshot, not lose everyone's.
          options.logger.error({ err: error, userId: user.id }, 'snapshot failed')
          failed += 1
        }
      }

      return { attempted: due.length, succeeded, failed }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void runOnce().catch((error: unknown) => {
      options.logger.error({ err: error }, 'scheduler pass failed')
    })
  }, intervalMs)

  // Never hold the process open on our account.
  timer.unref?.()

  return {
    stop: () => clearInterval(timer),
    runOnce,
  }
}

/**
 * Users who have a record key and no snapshot in the last day.
 *
 * A missing `recordPubKey` is not an error — it means we have nowhere to
 * address the ciphertext, so there is nothing safe to write.
 */
async function findUsersDueForSnapshot(
  db: Database,
  limit: number,
): Promise<Array<{ id: string; recordPubKey: string }>> {
  const cutoff = new Date(Date.now() - DAY_MS)

  const rows = await db
    .select({ id: users.id, recordPubKey: users.recordPubKey })
    .from(users)
    .where(
      and(
        sql`${users.recordPubKey} IS NOT NULL`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${snapshots}
          WHERE ${snapshots.userId} = ${users.id}
            AND ${snapshots.createdAt} > ${cutoff}
        )`,
      ),
    )
    .limit(limit)

  return rows.flatMap((row) =>
    row.recordPubKey ? [{ id: row.id, recordPubKey: row.recordPubKey }] : [],
  )
}

/** Snapshots written but not yet anchored on chain. Read by the anchor worker. */
export async function findPendingAnchors(db: Database, limit = 25) {
  return db
    .select({
      id: snapshots.id,
      userId: snapshots.userId,
      rootHashes: snapshots.rootHashes,
      schemaVersion: snapshots.schemaVersion,
    })
    .from(snapshots)
    .where(and(isNull(snapshots.anchorTxHash), gte(snapshots.createdAt, new Date(0))))
    .orderBy(snapshots.createdAt)
    .limit(limit)
}

/** Exported for tests: the window a snapshot covers. */
export function snapshotWindow(now: Date, days = 30): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - days * DAY_MS), to: now }
}
