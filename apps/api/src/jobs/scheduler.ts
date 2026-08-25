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

import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import type { OGStorage } from '@ogt/og'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../db/index.ts'
import type { PassLock } from './pass-lock.ts'
import { snapshots, users } from '../db/schema.ts'
import { runSnapshot } from './snapshot.ts'
import { ensureRecordKey } from '../services/record-key.ts'
import { purgeExpired } from '../services/auth.ts'

export interface SchedulerOptions {
  db: Database
  storage: OGStorage
  /**
   * Derives the key each record is encrypted to. Absent means no snapshot can
   * be addressed to anybody, which is reported rather than passed over.
   */
  masterSeed?: string | undefined
  logger: FastifyBaseLogger
  /** How often to look for work. Default hourly. */
  intervalMs?: number
  /** Users per pass. Keeps a backlog from monopolising the process. */
  batchSize?: number
  /**
   * Excludes other instances from this pass. Absent means single-instance
   * behaviour, which is what the tests and a one-container deployment want.
   */
  lock?: PassLock | undefined
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

    /*
     * The boolean above covers this process. Another instance has its own, so
     * the lock is what actually keeps two of them out of the same pass.
     */
    let release: (() => Promise<void>) | null = null

    try {
      if (options.lock) {
        release = await options.lock('scheduler')
        if (release === null) {
          // Somebody else is mid-pass. Nothing is lost by standing down: the
          // work is still queued and they are doing it.
          return { attempted: 0, succeeded: 0, failed: 0 }
        }
      }

      /*
       * Housekeeping first, before any early return.
       *
       * `purgeExpired` has existed since sessions did, with a comment saying
       * expired rows are liability rather than data, and nothing ever called
       * it — so every one-time code and every dead session was kept forever, on
       * the table each authenticated request reads.
       *
       * It runs ahead of the snapshot work deliberately. Placing it after cost
       * an outage in miniature: a deployment with no master seed returns early
       * below, and cleanup that lives past that line never happens on exactly
       * the deployments least likely to notice.
       */
      try {
        await purgeExpired(options.db)
      } catch (error) {
        // Never fail a pass over cleanup.
        options.logger.warn({ err: error }, 'purging expired auth rows failed')
      }

      const due = await findUsersDueForSnapshot(options.db, batchSize)
      let succeeded = 0
      let failed = 0

      if (due.length > 0 && !options.masterSeed) {
        // Said out loud. The previous behaviour was to filter these users out
        // of the query entirely, which made a total outage look like an empty
        // queue for as long as anybody cared to look.
        options.logger.error(
          { due: due.length },
          'no OG_ANCHOR_MASTER_SEED: records cannot be encrypted to anyone, so nothing is snapshotted',
        )
        return { attempted: 0, succeeded: 0, failed: 0 }
      }

      for (const user of due) {
        try {
          const to = new Date()
          const from = new Date(to.getTime() - 30 * DAY_MS)

          const recordPubKey = await ensureRecordKey(options.db, options.masterSeed!, user.id)

          const result = await runSnapshot({
            db: options.db,
            storage: options.storage,
            userId: user.id,
            recordPubKey,
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

/** Users with no snapshot in the last day. */
export async function findUsersDueForSnapshot(
  db: Database,
  limit: number,
): Promise<Array<{ id: string }>> {
  const cutoff = new Date(Date.now() - DAY_MS)

  // Deliberately does not filter on record_pub_key. That filter was here, the
  // column was never populated, and so this returned nothing for every user
  // while looking like a healthy empty queue. A key that does not exist yet is
  // created when it is needed, not used as a reason to skip somebody.
  return db
    .select({ id: users.id })
    .from(users)
    .where(
      sql`NOT EXISTS (
        SELECT 1 FROM ${snapshots}
        WHERE ${snapshots.userId} = ${users.id}
          AND ${snapshots.createdAt} > ${cutoff}
      )`,
    )
    .limit(limit)
}

/**
 * Snapshots written but not yet anchored on chain. Read by the anchor worker.
 *
 * Carries each snapshot's custody state, because the two cases are anchored
 * differently and confusing them is the one mistake here that would be worse
 * than not anchoring at all. For a user we hold the key for, the worker signs.
 * For a user who took custody, the worker must not — it waits for the
 * signature their device left, and signing with the master seed instead would
 * produce an anchor that verifies, looks correct, and means the opposite of
 * what the product promised them.
 */
export async function findPendingAnchors(db: Database, limit = 25) {
  return db
    .select({
      id: snapshots.id,
      userId: snapshots.userId,
      rootHashes: snapshots.rootHashes,
      schemaVersion: snapshots.schemaVersion,
      custodyTakenAt: users.custodyTakenAt,
      anchorAddress: users.anchorAddress,
      ownerSignature: snapshots.ownerSignature,
      signatureDeadline: snapshots.signatureDeadline,
    })
    .from(snapshots)
    .innerJoin(users, eq(users.id, snapshots.userId))
    .where(and(isNull(snapshots.anchorTxHash), gte(snapshots.createdAt, new Date(0))))
    .orderBy(snapshots.createdAt)
    .limit(limit)
}

/** Exported for tests: the window a snapshot covers. */
export function snapshotWindow(now: Date, days = 30): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - days * DAY_MS), to: now }
}
