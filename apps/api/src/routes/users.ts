/**
 * Onboarding and profile.
 *
 * The onboarding target is under 90 seconds to a first real number, so this
 * asks the fewest questions that produce a correct target — plus one nobody
 * else asks: who cooks. That single answer drives most later personalisation,
 * because a hostel mess and a home kitchen are different products.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { computeTargets } from '@ogt/core'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { currentUserId } from '../plugins/auth.ts'
import { households, users, weightLogs } from '../db/schema.ts'
import { blockedResponse, guardProfile } from '../services/safety-gate.ts'

const ProfileBody = z.object({
  sex: z.enum(['male', 'female']),
  ageYears: z.number().int().min(1).max(120),
  heightCm: z.number().min(80).max(250),
  weightKg: z.number().min(20).max(400),
  activity: z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active']),
  goal: z.enum(['lose', 'gain', 'maintain', 'recomp']),
  paceKgPerWeek: z.number().positive().max(5).optional(),
  diet: z.enum(['veg', 'nonveg', 'egg', 'vegan', 'jain']).default('veg'),
  cooks: z.enum(['self', 'family', 'mess', 'tiffin', 'mixed']).default('self'),
  displayName: z.string().max(100).optional(),
  householdId: z.string().uuid().optional(),
})

export interface UserRouteDeps {
  db: Database
}

export async function registerUserRoutes(app: FastifyInstance, deps: UserRouteDeps): Promise<void> {
  /** Create a user and return their targets. Refuses if the profile fails the gate. */
  app.post('/users', async (request, reply) => {
    const body = ProfileBody.parse(request.body)

    const profile = {
      sex: body.sex,
      ageYears: body.ageYears,
      heightCm: body.heightCm,
      weightKg: body.weightKg,
      activity: body.activity,
      goal: body.goal,
      ...(body.paceKgPerWeek ? { paceKgPerWeek: body.paceKgPerWeek } : {}),
    }

    // The profile gate runs before a user row exists. A minor or an underweight
    // cut request must be refused at the door, not after we have their data.
    const gate = await guardProfile(deps.db, null, profile, 'onboarding')
    if (gate.blocked) return reply.status(200).send(blockedResponse(gate.verdict))

    const targets = computeTargets(profile)

    const created = await deps.db.transaction(async (tx) => {
      let householdId = body.householdId
      if (!householdId) {
        const [household] = await tx.insert(households).values({}).returning({ id: households.id })
        householdId = household?.id
      }

      const [user] = await tx
        .insert(users)
        .values({
          ...(householdId ? { householdId } : {}),
          ...(body.displayName ? { displayName: body.displayName } : {}),
          sex: body.sex,
          ageYears: body.ageYears,
          heightCm: body.heightCm,
          activity: body.activity,
          goal: body.goal,
          ...(body.paceKgPerWeek ? { paceKgPerWeek: body.paceKgPerWeek } : {}),
          diet: body.diet,
          cooks: body.cooks,
        })
        .returning({ id: users.id, householdId: users.householdId })

      if (!user) throw new Error('Failed to create user')

      await tx.insert(weightLogs).values({ userId: user.id, weightKg: body.weightKg })
      return user
    })

    return reply.status(201).send({
      userId: created.id,
      householdId: created.householdId,
      targets,
      // Clamping is always disclosed. Silently lowering someone's requested
      // pace and not saying so is how an app loses the right to be trusted.
      notes: targets.safetyNotes,
    })
  })

  /** Current targets, recomputed from the latest weight. */
  app.get('/users/:userId/targets', async (request, reply) => {
    const userId = currentUserId(request)

    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!user) return reply.status(404).send({ error: 'not_found' })

    const [latest] = await deps.db
      .select({ weightKg: weightLogs.weightKg })
      .from(weightLogs)
      .where(eq(weightLogs.userId, userId))
      .orderBy(weightLogs.recordedAt)
      .limit(1)

    if (!user.sex || !user.ageYears || !user.heightCm || !user.activity || !user.goal || !latest) {
      return reply.status(409).send({ error: 'profile_incomplete' })
    }

    const targets = computeTargets({
      sex: user.sex,
      ageYears: user.ageYears,
      heightCm: user.heightCm,
      weightKg: latest.weightKg,
      activity: user.activity,
      goal: user.goal,
      ...(user.paceKgPerWeek ? { paceKgPerWeek: user.paceKgPerWeek } : {}),
    })

    return reply.status(200).send({ targets, notes: targets.safetyNotes })
  })

  app.post('/users/:userId/weight', async (request, reply) => {
    const userId = currentUserId(request)
    const { weightKg } = z.object({ weightKg: z.number().min(20).max(400) }).parse(request.body)

    await deps.db.insert(weightLogs).values({ userId, weightKg })
    return reply.status(201).send({ ok: true })
  })

  /** Tone. Never sycophantic at any setting — this only changes how blunt it is. */
  app.patch('/users/:userId/tone', async (request, reply) => {
    const userId = currentUserId(request)
    const { tone } = z.object({ tone: z.enum(['gentle', 'straight', 'blunt']) }).parse(request.body)

    await deps.db.update(users).set({ tone, updatedAt: new Date() }).where(eq(users.id, userId))
    return reply.status(200).send({ tone })
  })

  /** One tap, obeyed permanently. No re-prompt, ever. */
  app.post('/users/:userId/ask-me-less', async (request, reply) => {
    const userId = currentUserId(request)
    await deps.db
      .update(users)
      .set({ proactiveOptOut: true, updatedAt: new Date() })
      .where(eq(users.id, userId))
    return reply.status(200).send({ proactiveOptOut: true })
  })
}
