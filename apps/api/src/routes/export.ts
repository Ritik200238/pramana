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
import { desc, eq } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { currentUserId } from '../plugins/auth.ts'
import {
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
import { inArray } from 'drizzle-orm'

export interface ExportRouteDeps {
  db: Database
}

export async function registerExportRoutes(
  app: FastifyInstance,
  deps: ExportRouteDeps,
): Promise<void> {
  app.get('/users/me/export', async (request, reply) => {
    const userId = currentUserId(request)

    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!user) return reply.status(404).send({ error: 'not_found' })

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
    const [weights, facts, chat, foods, known, snaps, markers, reports, streak] =
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
      ])

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
        recordPubKey: user.recordPubKey,
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
       * The retrieval keys for the encrypted copies on 0G Storage. Combined
       * with the user's own private key, these are sufficient to reconstruct
       * the record without this API existing at all.
       */
      ogStorage: snaps.map((snap) => ({
        rootHashes: snap.rootHashes,
        txHashes: snap.txHashes,
        schemaVersion: snap.schemaVersion,
        anchorTxHash: snap.anchorTxHash,
        createdAt: snap.createdAt,
      })),
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
