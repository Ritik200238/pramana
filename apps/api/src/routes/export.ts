/**
 * Export — feature 18.
 *
 * Everything, free, forever, paying or not. This is not a premium feature and
 * it is not gated, because the objection it answers is a deal-breaker:
 * "Once you stop your subscription you lose your data. Wow, that's an automatic
 * no from me."
 *
 * The export deliberately includes the 0G Storage root hashes. Without them the
 * encrypted record is unreachable, so an export that omitted them would hand
 * someone a copy while quietly keeping the original.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { desc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { currentUserId } from '../plugins/auth.ts'
import { deriveOwnerAccount, publicKeyFor, type AnchorClient } from '@ogt/og'
import { ensureRecordKey } from '../services/record-key.ts'
import { checkAnchor, type AnchorCheck } from '../services/anchor-check.ts'
import {
  households,
  safetyEvents,
  inferenceUsage,
  chatMessages,
  healthMarkers,
  knownAttributes,
  labReports,
  lifeFacts,
  mealItems,
  meals,
  snapshots,
  streaks,
  userFoods,
  users,
  weightLogs,
} from '../db/schema.ts'

export interface ExportRouteDeps {
  db: Database
  /**
   * Reads anchors back off the chain, so the export can say whether our rows
   * agree with what was anchored.
   *
   * Optional: a deployment without anchoring configured says "unavailable"
   * rather than pretending, which is the honest answer and not the same as
   * "verified".
   */
  anchorClient?: AnchorClient | undefined
  /**
   * Derives the key a person's records are encrypted to.
   *
   * Needed so somebody can be handed their own key and read their 0G Storage
   * copies without this API existing. Absent means that offer cannot be made.
   */
  masterSeed?: string | undefined
}

export async function registerExportRoutes(
  app: FastifyInstance,
  deps: ExportRouteDeps,
): Promise<void> {
  app.get('/users/me/export', async (request, reply) => {
    const userId = currentUserId(request)

    /*
     * Whether to include the key that makes the rest portable.
     *
     * Opt-in rather than default, and the distinction is the point. A plain
     * export is a health record — sensitive, and something somebody might
     * reasonably hand to a doctor. Adding the private key makes it a
     * credential as well: whoever holds it can read every future snapshot and
     * anchor on chain as that person. Those are different objects and should
     * not be produced by the same click.
     */
    const { includeRecordKey } = z
      .object({ includeRecordKey: z.enum(['true', 'false']).optional() })
      .parse(request.query)

    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!user) return reply.status(404).send({ error: 'not_found' })

    /*
     * Derived once, and recorded.
     *
     * The public half was previously read from the user row, which is only
     * populated when a background worker first runs — so an export taken before
     * then handed somebody a private key alongside a null public key and a null
     * address. Deriving both here, and writing them through the same path the
     * workers use, means the set is always coherent and the seed-drift check
     * applies to it.
     */
    const recordAccount =
      includeRecordKey === 'true' && deps.masterSeed
        ? await (async () => {
            const recordPubKey = await ensureRecordKey(deps.db, deps.masterSeed!, userId)
            const wallet = deriveOwnerAccount(deps.masterSeed!, userId)
            // Built field by field: spreading a Wallet drops privateKey, which
            // is a getter rather than an own property.
            return { privateKey: wallet.privateKey, address: wallet.address, recordPubKey }
          })()
        : null

    const mealRows = await deps.db
      .select()
      .from(meals)
      .where(eq(meals.userId, userId))
      .orderBy(desc(meals.eatenAt))

    const mealIds = mealRows.map((meal) => meal.id)
    const itemRows =
      mealIds.length > 0
        ? await deps.db.select().from(mealItems).where(inArray(mealItems.mealId, mealIds))
        : []

    const itemsByMeal = new Map<string, typeof itemRows>()
    for (const item of itemRows) {
      const list = itemsByMeal.get(item.mealId) ?? []
      list.push(item)
      itemsByMeal.set(item.mealId, list)
    }

    // Everything means everything. Each table added to the product has to be
    // added here too, or "export everything, free, forever" quietly becomes
    // false — which is exactly the walled-garden behaviour users called out.
    /*
     * The account that owns these records on chain. Exported so the comparison
     * above can be repeated by anybody, against a public RPC, with no part of
     * this company involved.
     */
    const anchorOwner = deps.masterSeed ? deriveOwnerAccount(deps.masterSeed, userId).address : ''

    const [weights, facts, chat, foods, known, snaps, markers, reports, streak, receipts, safety, household] =
      await Promise.all([
        deps.db.select().from(weightLogs).where(eq(weightLogs.userId, userId)),
        deps.db.select().from(lifeFacts).where(eq(lifeFacts.userId, userId)),
        deps.db.select().from(chatMessages).where(eq(chatMessages.userId, userId)),
        deps.db.select().from(userFoods).where(eq(userFoods.userId, userId)),
        deps.db.select().from(knownAttributes).where(eq(knownAttributes.userId, userId)),
        deps.db.select().from(snapshots).where(eq(snapshots.userId, userId)),
        deps.db.select().from(healthMarkers).where(eq(healthMarkers.userId, userId)),
        deps.db.select().from(labReports).where(eq(labReports.userId, userId)),
        deps.db.select().from(streaks).where(eq(streaks.userId, userId)),
        deps.db.select().from(inferenceUsage).where(eq(inferenceUsage.userId, userId)),
        deps.db.select().from(safetyEvents).where(eq(safetyEvents.userId, userId)),
        user.householdId
          ? deps.db.select().from(households).where(eq(households.id, user.householdId))
          : Promise.resolve([]),
      ])

    /*
     * Compare our rows against the chain, before handing them over.
     *
     * A Merkle proof on download verifies the bytes against whichever root hash
     * it was given — ours. It says nothing about whether that row still says
     * what it said when it was anchored. This is the check that does, and an
     * export is where it matters most: it is the copy somebody keeps.
     */
    const anchorChecks: AnchorCheck[] = deps.anchorClient
      ? await Promise.all(
          snaps.map((snap) =>
            checkAnchor({
              client: deps.anchorClient!,
              owner: anchorOwner,
              anchorIndex: snap.anchorIndex,
              rootHashes: snap.rootHashes,
            }),
          ),
        )
      : snaps.map(() => ({ status: 'unavailable', reason: 'anchoring not configured' }) as const)

    const payload = {
      exportedAt: new Date().toISOString(),
      format: 'ogt-export-v1',
      profile: {
        id: user.id,
        displayName: user.displayName,
        sex: user.sex,
        ageYears: user.ageYears,
        heightCm: user.heightCm,
        activity: user.activity,
        goal: user.goal,
        diet: user.diet,
        cooks: user.cooks,
        tone: user.tone,
        // Taken from the derivation when one just happened, because the row
        // above was read before it was written.
        recordPubKey: recordAccount?.recordPubKey ?? user.recordPubKey,
      },
      meals: mealRows.map((meal) => ({ ...meal, items: itemsByMeal.get(meal.id) ?? [] })),
      weights,
      lifeFacts: facts,
      chat,
      myFoods: foods,
      settledAnswers: known,
      labReports: reports,
      healthMarkers: markers,
      streak: streak[0] ?? null,
      /**
       * Every computation performed on this person's data, and where it ran.
       *
       * The app shows these as receipts and makes a claim about them, so an
       * export that left them out would hand somebody their meals while
       * keeping the evidence about how those meals were read. They were
       * missing until a sweep compared the export against the schema.
       */
      computations: receipts.map((row) => ({
        task: row.task,
        model: row.model,
        attestation: row.attestation,
        provider: row.attestationProvider,
        requestId: row.attestationRequestId,
        costNeuron: row.costNeuron,
        createdAt: row.createdAt,
      })),
      /**
       * Times the safety gate stopped something, and why.
       *
       * Included because they are records about this person, made by us, and a
       * record somebody cannot see is one they cannot dispute.
       */
      safetyEvents: safety,
      /** The kitchen this person belongs to, if any. */
      household: household[0] ?? null,
      /**
       * The retrieval keys for the encrypted copies on 0G Storage.
       *
       * On their own these are pointers to ciphertext. Reading them needs the
       * record key, which is derived and held by us — so for a long time this
       * section was, in practice, useless to the person it was given to, while
       * a comment here claimed it was "sufficient to reconstruct the record
       * without this API existing at all". It was not.
       *
       * Ask for `?includeRecordKey=true` and it becomes true.
       */
      /** Who owns the anchors above, for anybody re-running the check. */
      anchorOwner,
      ogStorage: snaps.map((snap, position) => ({
        rootHashes: snap.rootHashes,
        txHashes: snap.txHashes,
        schemaVersion: snap.schemaVersion,
        anchorTxHash: snap.anchorTxHash,
        /*
         * The index, so this can be checked without us.
         *
         * `snapshotAt(owner, index)` on HealthRecordAnchor returns the root
         * hashes the chain holds. With the owner address below, anybody can
         * run that against a public RPC and compare it to the list above —
         * which is the whole point of anchoring and was not previously
         * possible from what the export contained.
         */
        anchorIndex: snap.anchorIndex,
        /** What that comparison says when we run it ourselves. */
        anchorVerification: anchorChecks[position] ?? { status: 'unavailable', reason: 'not checked' },
        createdAt: snap.createdAt,
      })),
      ...(recordAccount
        ? {
            /**
             * The key the records above are encrypted to.
             *
             * Handing it over is what turns "you own your record" from a
             * description of our intentions into something a person can act
             * on: with this and the root hashes, the 0G Storage copies are
             * readable forever, by them, with no part of this company
             * involved.
             *
             * It is also the account that owns their anchors on chain, so it
             * is a credential and is labelled as one. Given only when asked
             * for, never logged, and never in the CSV.
             */
            recordKey: {
              privateKey: recordAccount!.privateKey,
              publicKey: recordAccount!.recordPubKey,
              address: recordAccount!.address,
              warning:
                'This key can read every snapshot above and act as you on 0G Chain. ' +
                'Anyone who has it has that ability. Store it the way you would store ' +
                'the password to your bank, and do not send this file to anybody.',
              howToUse:
                'Each entry in ogStorage lists root hashes. Fetch them from a 0G Storage ' +
                'indexer and decrypt with this key using ECIES — the same scheme the 0G ' +
                'storage SDK uses on upload.',
            },
          }
        : {}),
    }

    reply.header('Content-Type', 'application/json; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="health-record-${userId}.json"`)
    return reply.status(200).send(payload)
  })

  /** CSV of meals, for a spreadsheet or a dietitian who does not want JSON. */
  app.get('/users/me/export.csv', async (request, reply) => {
    const userId = currentUserId(request)

    const rows = await deps.db
      .select()
      .from(meals)
      .where(eq(meals.userId, userId))
      .orderBy(desc(meals.eatenAt))

    const header = 'eaten_at,meal_type,kcal,protein_g,carb_g,fat_g,confidence,source,questions_asked'
    const body = rows
      .map((meal) =>
        [
          meal.eatenAt.toISOString(),
          meal.mealType ?? '',
          meal.kcal.toFixed(1),
          meal.proteinG.toFixed(1),
          meal.carbG.toFixed(1),
          meal.fatG.toFixed(1),
          meal.confidence,
          meal.source,
          String(meal.questionsAsked),
        ].join(','),
      )
      .join('\n')

    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="meals-${userId}.csv"`)
    return reply.status(200).send(`${header}\n${body}\n`)
  })
}
