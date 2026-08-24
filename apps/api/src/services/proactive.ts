/**
 * The AI asks you — feature 03.
 *
 * The easiest feature on the whole list to ruin, so every limit here is enforced
 * in code and none of it is left to a prompt. A model asked politely to "not be
 * annoying" will be annoying eventually; a function that returns null cannot be.
 *
 * The hard limits, and the reason for each:
 *
 *   - **One message per 24 hours. Absolute.** Notification opt-out predicts 3-4x
 *     churn, so the way to keep notifications on is to make them rare and right.
 *   - **Never between 22:00 and 07:00.** Nobody wants a nutrition question at 2am.
 *   - **Only on a specific, personal trigger.** Never "Don't forget to log!".
 *     Generic nudges are the thing users describe as spam.
 *   - **Opt-out is permanent and never re-prompted.**
 *   - **A resolved topic is never raised again.** This one exists because of a
 *     documented harm: a coach that kept surfacing a healed injury for three
 *     months and then argued with the user about it.
 *       "I told it to stop... it said it would erase that info, and it's there
 *        again... it began to gaslight me."
 */

import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { chatMessages, lifeFacts, meals, users } from '../db/schema.ts'
import { dayBounds } from './day.ts'

export const MIN_HOURS_BETWEEN = 24
export const QUIET_START_HOUR = 22
export const QUIET_END_HOUR = 7

export type TriggerKind =
  | 'missed_meal'
  | 'pattern'
  | 'follow_up'
  | 'calibrate'
  | 'context_seek'

export interface ProactiveMessage {
  kind: TriggerKind
  text: string
  /** Fact this refers to, so answering it can resolve the thread. */
  factId?: string
}

export interface ConsiderInput {
  db: Database
  userId: string
  now?: Date
  utcOffsetMinutes?: number
}

/**
 * Decide whether to say anything at all.
 *
 * Returns null far more often than not, and that is the intended behaviour —
 * silence is the default state of this feature.
 */
export async function considerProactive(input: ConsiderInput): Promise<ProactiveMessage | null> {
  const now = input.now ?? new Date()
  const offset = input.utcOffsetMinutes ?? 330

  const [user] = await input.db.select().from(users).where(eq(users.id, input.userId)).limit(1)
  if (!user) return null

  // Opt-out is permanent. There is deliberately no re-prompt path anywhere.
  if (user.proactiveOptOut) return null

  if (isQuietHours(now, offset)) return null

  if (user.lastProactiveAt) {
    const hoursSince = (now.getTime() - user.lastProactiveAt.getTime()) / 3_600_000
    if (hoursSince < MIN_HOURS_BETWEEN) return null
  }

  // Triggers are ordered by how much the person is likely to care, not by how
  // easy they are to detect. The first that fires wins; there is only one
  // message available, so it should be the one that matters most.
  return (
    (await followUpOnOpenSymptom(input.db, input.userId, now)) ??
    (await noticeEnergyPattern(input.db, input.userId, now)) ??
    (await noticeMissedMeal(input.db, input.userId, now, offset)) ??
    null
  )
}

export function isQuietHours(now: Date, offsetMinutes: number): boolean {
  const local = new Date(now.getTime() + offsetMinutes * 60_000)
  const hour = local.getUTCHours()
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR
}

/**
 * A symptom mentioned a few days ago and never closed.
 *
 * Bounded to a 2-7 day window: sooner is nagging, later is the healed-injury
 * failure. Asking once, in that window, is what a person who was listening
 * would do.
 */
async function followUpOnOpenSymptom(
  db: Database,
  userId: string,
  now: Date,
): Promise<ProactiveMessage | null> {
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 3_600_000)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3_600_000)

  const [fact] = await db
    .select()
    .from(lifeFacts)
    .where(
      and(
        eq(lifeFacts.userId, userId),
        eq(lifeFacts.kind, 'symptom'),
        isNull(lifeFacts.resolvedAt),
        lt(lifeFacts.occurredAt, twoDaysAgo),
        gte(lifeFacts.occurredAt, sevenDaysAgo),
      ),
    )
    .orderBy(desc(lifeFacts.occurredAt))
    .limit(1)

  if (!fact) return null

  return {
    kind: 'follow_up',
    // Their words, not our paraphrase. Telling someone their experience was
    // something other than what they said is its own small betrayal.
    text: `Still going on — "${fact.verbatim}"? You mentioned it a few days ago.`,
    factId: fact.id,
  }
}

/** Three or more low-energy days in a week, with something in the log to point at. */
async function noticeEnergyPattern(
  db: Database,
  userId: string,
  now: Date,
): Promise<ProactiveMessage | null> {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000)

  const lowEnergy = await db
    .select({ id: lifeFacts.id })
    .from(lifeFacts)
    .where(
      and(
        eq(lifeFacts.userId, userId),
        eq(lifeFacts.kind, 'energy'),
        isNull(lifeFacts.resolvedAt),
        gte(lifeFacts.occurredAt, weekAgo),
      ),
    )

  if (lowEnergy.length < 3) return null

  const [sleep] = await db
    .select({ average: sql<number>`avg(${lifeFacts.value})` })
    .from(lifeFacts)
    .where(
      and(
        eq(lifeFacts.userId, userId),
        eq(lifeFacts.kind, 'sleep'),
        gte(lifeFacts.occurredAt, weekAgo),
      ),
    )

  const averageSleep = sleep?.average

  // Observation, never causation, and never a diagnosis.
  const text =
    averageSleep && averageSleep < 6.5
      ? `Third low-energy day this week, and your sleep is averaging about ${averageSleep.toFixed(1)} hours. Those might be connected — what does tonight look like?`
      : 'Third low-energy day this week. Anything changed — sleep, work, training?'

  return { kind: 'pattern', text }
}

/** Nothing logged all day, well into the evening. */
async function noticeMissedMeal(
  db: Database,
  userId: string,
  now: Date,
  offset: number,
): Promise<ProactiveMessage | null> {
  const local = new Date(now.getTime() + offset * 60_000)
  const hour = local.getUTCHours()
  if (hour < 20) return null // too early to call it a missed day

  const { from, to } = dayBounds(now, offset)

  const logged = await db
    .select({ id: meals.id })
    .from(meals)
    .where(and(eq(meals.userId, userId), gte(meals.eatenAt, from), lt(meals.eatenAt, to)))
    .limit(1)

  if (logged.length > 0) return null

  // Only worth saying to someone who has a habit to break. A brand-new user
  // who has not logged today is not lapsing, they are new.
  const [history] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(meals)
    .where(eq(meals.userId, userId))

  if (!history || history.count < 5) return null

  return {
    kind: 'missed_meal',
    text: 'Nothing logged today. Mess food, or just a busy one?',
  }
}

/** Record that we spoke, so the 24-hour limit is enforced by state, not intent. */
export async function recordProactive(
  db: Database,
  userId: string,
  message: ProactiveMessage,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(chatMessages).values({
      userId,
      role: 'assistant',
      content: message.text,
      proactive: true,
    })

    await tx
      .update(users)
      .set({ lastProactiveAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId))
  })
}

/**
 * Close a topic so it is never raised again.
 *
 * Called when the user answers a follow-up, or taps "this is sorted". The
 * absence of this function is what produced the gaslighting failure.
 */
export async function resolveFact(db: Database, userId: string, factId: string): Promise<void> {
  await db
    .update(lifeFacts)
    .set({ resolvedAt: new Date() })
    .where(and(eq(lifeFacts.id, factId), eq(lifeFacts.userId, userId)))
}
