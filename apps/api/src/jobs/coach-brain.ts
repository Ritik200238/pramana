/**
 * The coach's brain, and the worker that puts it on chain.
 *
 * `CoachAgent` had no call sites anywhere in the running product. The contract
 * was complete and unreachable, which made "you own your coach" a sentence
 * rather than a mechanism — and left one of the four bindings that were meant
 * to make 0G impossible to remove doing no work at all.
 *
 * What goes in the brain is the deliberate part. Not the meal log, which is the
 * health record and is anchored separately, but what the coach has *learned*:
 *
 *   - the dishes as this person actually cooks them, with the portions they
 *     actually eat, from every correction they have made
 *   - the constraints and preferences they only had to say once
 *   - how they want to be spoken to
 *
 * That is what would be lost by starting over somewhere else, and it is what
 * makes the coach worth owning. The brain is encrypted to the user's own key
 * and stored on 0G Storage; only its root hash, a commitment to the plaintext,
 * and a count of what it knows go on chain.
 */

import { and, eq, isNotNull } from 'drizzle-orm'
import { CoachClient, brainMetadataHash, deriveOwnerAccount, type OGStorage } from '@ogt/og'
import type { FastifyBaseLogger } from 'fastify'
import { ethers } from 'ethers'
import type { Database } from '../db/index.ts'
import { lifeFacts, userFoods, users } from '../db/schema.ts'
import { ensureRecordKey } from '../services/record-key.ts'

export const BRAIN_SCHEMA_VERSION = 1

/**
 * How much the brain must grow before it is worth a transaction.
 *
 * Evolving per correction would put a chain write in the middle of somebody
 * fixing a portion size, which is both slow and expensive for no benefit. The
 * on-chain history is meant to be a record of learning, not a keystroke log.
 */
export const EVOLVE_THRESHOLD = 10

export interface CoachBrain {
  schemaVersion: number
  userId: string
  generatedAt: string
  /** Tone and dietary frame — how this person wants to be spoken to and fed. */
  preferences: Record<string, unknown>
  /** Their versions of dishes, which supersede the global database. */
  foods: unknown[]
  /** Things they said once and should never be asked again. */
  facts: unknown[]
  /** What `learnedCount` on chain refers to. */
  learnedCount: number
}

export async function buildBrain(
  db: Database,
  userId: string,
  now = new Date(),
): Promise<CoachBrain> {
  const [user] = await db
    .select({
      tone: users.tone,
      diet: users.diet,
      cooks: users.cooks,
      goal: users.goal,
      proactiveOptOut: users.proactiveOptOut,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const foods = await db.select().from(userFoods).where(eq(userFoods.userId, userId))
  const facts = await db
    .select()
    .from(lifeFacts)
    .where(and(eq(lifeFacts.userId, userId), isNotNull(lifeFacts.kind)))

  return {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    userId,
    generatedAt: now.toISOString(),
    preferences: user ?? {},
    foods,
    facts,
    // The number the product shows a person: "your coach knows 340 things about
    // how you eat". It has to be countable, or it should not be said.
    learnedCount: foods.length + facts.length,
  }
}

export interface CoachWorkerOptions {
  db: Database
  client: CoachClient
  storage: OGStorage
  masterSeed: string
  logger: FastifyBaseLogger
  intervalMs?: number
  batchSize?: number
  minimumBalanceWei?: bigint
}

export interface CoachWorker {
  stop: () => void
  runOnce: () => Promise<{ minted: number; evolved: number; failed: number }>
}

const DEFAULT_MINIMUM_BALANCE = ethers.parseEther('0.01')

export function startCoachWorker(options: CoachWorkerOptions): CoachWorker {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000
  const batchSize = options.batchSize ?? 20
  const minimumBalance = options.minimumBalanceWei ?? DEFAULT_MINIMUM_BALANCE

  let running = false

  async function runOnce(): Promise<{ minted: number; evolved: number; failed: number }> {
    if (running) return { minted: 0, evolved: 0, failed: 0 }
    running = true

    try {
      const candidates = await findCoachWork(options.db, batchSize)
      if (candidates.length === 0) return { minted: 0, evolved: 0, failed: 0 }

      const balance = await options.client.relayerBalance()
      if (balance < minimumBalance) {
        options.logger.error(
          {
            relayer: options.client.relayerAddress,
            balance: ethers.formatEther(balance),
            pending: candidates.length,
          },
          'coach relayer is out of funds; minting and evolving paused',
        )
        return { minted: 0, evolved: 0, failed: 0 }
      }

      let minted = 0
      let evolved = 0
      let failed = 0

      for (const candidate of candidates) {
        try {
          const owner = deriveOwnerAccount(options.masterSeed, candidate.userId)
          const brain = await buildBrain(options.db, candidate.userId)

          // Nothing learned yet is not a coach worth minting. An empty brain on
          // chain would be a token that says nothing about anybody.
          if (brain.learnedCount === 0) continue

          const plaintext = JSON.stringify(brain)
          const metadataHash = brainMetadataHash(plaintext)

          // The ciphertext goes to 0G Storage; the chain only ever sees hashes.
          const recordPubKey = await ensureRecordKey(
            options.db,
            options.masterSeed,
            candidate.userId,
          )
          const { rootHashes } = await options.storage.putSnapshot(brain, recordPubKey)

          const first = rootHashes[0]
          if (!first) throw new Error('storage returned no root hash for the brain')

          // 0G root hashes are already 32 bytes; anything else is hashed so the
          // contract's bytes32 always holds a commitment to the real value.
          const rootHash = ethers.isHexString(first, 32)
            ? first
            : ethers.keccak256(ethers.toUtf8Bytes(first))

          if (candidate.coachTokenId === null) {
            // A coach is minted once. The nonce is derived from the user id so
            // a lost receipt cannot produce a second one.
            const nonce = nonceFrom(candidate.userId, 'mint')
            if (await options.client.nonceUsed(owner.address, nonce)) {
              options.logger.warn(
                { userId: candidate.userId },
                'coach already minted on chain; recording without minting again',
              )
              continue
            }

            const result = await options.client.mint(owner, {
              rootHash,
              metadataHash,
              schemaVersion: BRAIN_SCHEMA_VERSION,
              nonce,
            })

            await options.db
              .update(users)
              .set({
                coachTokenId: result.tokenId,
                coachLearnedCount: brain.learnedCount,
                updatedAt: new Date(),
              })
              .where(eq(users.id, candidate.userId))

            options.logger.info(
              {
                userId: candidate.userId,
                owner: owner.address,
                tokenId: result.tokenId,
                learned: brain.learnedCount,
                txHash: result.txHash,
              },
              'coach minted on 0G Chain',
            )
            minted += 1
            continue
          }

          // Only worth a transaction once it has learned enough to be a
          // different coach than the one already recorded.
          const growth = brain.learnedCount - candidate.coachLearnedCount
          if (growth < EVOLVE_THRESHOLD) continue

          const nonce = nonceFrom(`${candidate.userId}:${brain.learnedCount}`, 'evolve')
          if (await options.client.nonceUsed(owner.address, nonce)) continue

          const result = await options.client.evolve(owner, {
            tokenId: candidate.coachTokenId,
            rootHash,
            metadataHash,
            learnedCount: brain.learnedCount,
            nonce,
          })

          await options.db
            .update(users)
            .set({ coachLearnedCount: brain.learnedCount, updatedAt: new Date() })
            .where(eq(users.id, candidate.userId))

          options.logger.info(
            {
              userId: candidate.userId,
              tokenId: candidate.coachTokenId,
              version: result.version,
              learned: brain.learnedCount,
              txHash: result.txHash,
            },
            'coach brain evolved on 0G Chain',
          )
          evolved += 1
        } catch (error) {
          options.logger.error(
            { err: error, userId: candidate.userId },
            'coach update failed; will retry next pass',
          )
          failed += 1
        }
      }

      return { minted, evolved, failed }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void runOnce().catch((error: unknown) => {
      options.logger.error({ err: error }, 'coach pass failed')
    })
  }, intervalMs)

  timer.unref?.()

  return { stop: () => clearInterval(timer), runOnce }
}

/**
 * A deterministic nonce.
 *
 * Derived from what the transaction is for rather than a counter, so a retry
 * after a lost receipt reuses the same value and the contract rejects it
 * instead of minting a second coach.
 */
export function nonceFrom(subject: string, purpose: string): bigint {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(`${purpose}:${subject}`))
  // Truncated to fit comfortably inside uint256 arithmetic in logs and tests.
  return BigInt(hash) >> 8n
}

/**
 * Users who either have no coach or may have outgrown the one on chain.
 *
 * Does not filter on record_pub_key. That filter was here, the column was
 * never written, and so this returned nothing for every user — no coach was
 * ever minted and the queue looked empty rather than broken.
 */
export async function findCoachWork(db: Database, limit: number) {
  const rows = await db
    .select({
      userId: users.id,
      coachTokenId: users.coachTokenId,
      coachLearnedCount: users.coachLearnedCount,
    })
    .from(users)
    .limit(limit)

  return rows.map((row) => ({
    userId: row.userId,
    coachTokenId: row.coachTokenId,
    coachLearnedCount: row.coachLearnedCount ?? 0,
  }))
}
