/**
 * Day, usuals, food search, and the proactive check.
 *
 * These are the endpoints the home screen depends on. Until they existed the
 * app showed a protein ring that was permanently zero — the hero screen of the
 * product was decorative.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/index.ts'
import { currentUserId } from '../plugins/auth.ts'
import { getDaySummary } from '../services/day.ts'
import { findUsuals, repeatMeal } from '../services/usuals.ts'
import { correctMealItem } from '../services/corrections.ts'
import { searchFoods } from '../services/food-library.ts'
import { considerProactive, recordProactive, resolveFact } from '../services/proactive.ts'

const OffsetQuery = z.object({
  utcOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(330),
})

export interface DayRouteDeps {
  db: Database
}

export async function registerDayRoutes(app: FastifyInstance, deps: DayRouteDeps): Promise<void> {
  /** Today: totals, protein remaining, meals, and the thesis metric. */
  app.get('/users/:userId/today', async (request, reply) => {
    const userId = currentUserId(request)
    const { utcOffsetMinutes } = OffsetQuery.parse(request.query)

    const summary = await getDaySummary({ db: deps.db, userId, utcOffsetMinutes })
    return reply.status(200).send(summary)
  })

  /** Meals eaten repeatedly — one tap, zero questions. */
  app.get('/users/:userId/usuals', async (request, reply) => {
    const userId = currentUserId(request)
    const usuals = await findUsuals({ db: deps.db, userId })
    return reply.status(200).send({ usuals })
  })

  /** Log a previous meal again. This is the payoff for every question answered. */
  app.post('/meals/repeat', async (request, reply) => {
    const userId = currentUserId(request)
    const body = z.object({ sourceMealId: z.string().uuid() }).parse(request.body)

    try {
      const result = await repeatMeal({
        db: deps.db,
        userId: userId,
        sourceMealId: body.sourceMealId,
      })
      return reply.status(201).send(result)
    } catch {
      // Deliberately indistinguishable from "does not exist": a meal id is
      // guessable, and confirming one belongs to someone else leaks what they ate.
      return reply.status(404).send({ error: 'not_found' })
    }
  })

  /**
   * Correct a logged meal — R5.
   *
   * Correcting is not editing a number; it is teaching. The corrected values
   * become this user's own version of the dish, so the same mistake is never
   * made again. Without this route the personal library could only ever be
   * built from first logs, and "a correction is permanent" was a promise with
   * no way to keep it.
   */
  app.patch('/meals/:mealId/items/:itemId', async (request, reply) => {
    const params = z
      .object({ mealId: z.string().uuid(), itemId: z.string().uuid() })
      .parse(request.params)
    const userId = currentUserId(request)
    const body = z
      .object({
        units: z.number().positive().max(50).optional(),
        cookingFat: z.enum(['none', 'oil', 'ghee', 'butter']).optional(),
        cookingFatTsp: z.number().nonnegative().max(20).optional(),
        name: z.string().min(1).max(80).optional(),
      })
      .parse(request.body)

    try {
      const result = await correctMealItem({
        db: deps.db,
        userId: userId,
        mealId: params.mealId,
        itemId: params.itemId,
        ...(body.units !== undefined ? { units: body.units } : {}),
        ...(body.cookingFat ? { cookingFat: body.cookingFat } : {}),
        ...(body.cookingFatTsp !== undefined ? { cookingFatTsp: body.cookingFatTsp } : {}),
        ...(body.name ? { name: body.name } : {}),
      })
      return reply.status(200).send(result)
    } catch {
      return reply.status(404).send({ error: 'not_found' })
    }
  })

  /** Search, with the user's own versions ranked above shared reference data. */
  app.get('/users/:userId/foods', async (request, reply) => {
    const userId = currentUserId(request)
    const { q, limit } = z
      .object({ q: z.string().min(1).max(80), limit: z.coerce.number().int().min(1).max(20).default(8) })
      .parse(request.query)

    const matches = await searchFoods({ db: deps.db, userId, query: q, limit })
    return reply.status(200).send({ matches })
  })

  /**
   * Is there anything worth saying, unprompted?
   *
   * Polled by the client. Returns null almost always — silence is this
   * feature's default state, and the limits live in the service, not here.
   */
  app.get('/users/:userId/proactive', async (request, reply) => {
    const userId = currentUserId(request)
    const { utcOffsetMinutes } = OffsetQuery.parse(request.query)

    const message = await considerProactive({ db: deps.db, userId, utcOffsetMinutes })
    if (!message) return reply.status(200).send({ message: null })

    await recordProactive(deps.db, userId, message)
    return reply.status(200).send({ message })
  })

  /** "This is sorted." Closes a topic permanently so it is never raised again. */
  app.post('/users/:userId/facts/:factId/resolve', async (request, reply) => {
    const { factId } = z.object({ factId: z.string().uuid() }).parse(request.params)
    const userId = currentUserId(request)

    await resolveFact(deps.db, userId, factId)
    return reply.status(200).send({ resolved: true })
  })
}
