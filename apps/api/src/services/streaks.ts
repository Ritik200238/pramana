/**
 * Streaks with forgiveness — feature 15.
 *
 * The streak is not the mechanic; the freeze is. Duolingo's most-copied
 * invention is the one that lets you fail without losing everything, because
 * guilt loses users and forgiveness keeps them. A streak that punishes one bad
 * Tuesday is how someone concludes the whole app is not for them.
 *
 * Freezes are granted silently and spent silently. Announcing "you used a
 * freeze!" turns a kindness into an accusation.
 */

import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { streaks } from '../db/schema.ts'

export const MAX_FREEZES = 2
export const FREEZE_GRANT_PER_WEEK = 1

export interface StreakState {
  currentDays: number
  longestDays: number
  freezesAvailable: number
  /** True when today already counts. Lets the UI avoid nagging. */
  loggedToday: boolean
}

/** `YYYY-MM-DD` in the user's local timezone. */
export function localDate(at: Date, offsetMinutes: number): string {
  return new Date(at.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10)
}

export function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`)
  const b = Date.parse(`${later}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/** ISO week key, so freezes replenish on a fixed cadence rather than a rolling one. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export interface AdvanceInput {
  previous: {
    currentDays: number
    longestDays: number
    lastLoggedDate: string | null
    freezesAvailable: number
    freezeRefreshedOn: string | null
  }
  today: string
}

export interface AdvanceResult {
  currentDays: number
  longestDays: number
  lastLoggedDate: string
  freezesAvailable: number
  freezeRefreshedOn: string
  /** Whether a gap was covered. Recorded, never announced. */
  freezeSpent: boolean
}

/**
 * Advance the streak for a day on which the user logged something.
 *
 * Pure, so the rules are testable without a database — and these rules are
 * exactly the kind that drift silently once they live inside a query.
 */
export function advanceStreak(input: AdvanceInput): AdvanceResult {
  const { previous, today } = input

  // Replenish first: a new week restores one freeze, capped.
  const currentWeek = isoWeek(today)
  const refreshed = previous.freezeRefreshedOn !== currentWeek
  let freezes = refreshed
    ? Math.min(MAX_FREEZES, previous.freezesAvailable + FREEZE_GRANT_PER_WEEK)
    : previous.freezesAvailable

  if (previous.lastLoggedDate === null) {
    return {
      currentDays: 1,
      longestDays: Math.max(1, previous.longestDays),
      lastLoggedDate: today,
      freezesAvailable: freezes,
      freezeRefreshedOn: currentWeek,
      freezeSpent: false,
    }
  }

  const gap = daysBetween(previous.lastLoggedDate, today)

  // Same day — already counted. Logging twice is not a longer streak.
  if (gap <= 0) {
    return {
      currentDays: previous.currentDays,
      longestDays: previous.longestDays,
      lastLoggedDate: previous.lastLoggedDate,
      freezesAvailable: freezes,
      freezeRefreshedOn: currentWeek,
      freezeSpent: false,
    }
  }

  let current: number
  let freezeSpent = false

  if (gap === 1) {
    current = previous.currentDays + 1
  } else {
    // A gap of n days needs n-1 freezes to bridge: missing yesterday only
    // costs one.
    const missed = gap - 1
    if (missed <= freezes) {
      freezes -= missed
      freezeSpent = true
      current = previous.currentDays + 1
    } else {
      current = 1
    }
  }

  return {
    currentDays: current,
    longestDays: Math.max(current, previous.longestDays),
    lastLoggedDate: today,
    freezesAvailable: freezes,
    freezeRefreshedOn: currentWeek,
    freezeSpent,
  }
}

/** Called after a meal is committed. Idempotent within a day. */
export async function recordLoggedDay(
  db: Database,
  userId: string,
  at: Date,
  offsetMinutes = 330,
): Promise<AdvanceResult> {
  const today = localDate(at, offsetMinutes)

  const [existing] = await db.select().from(streaks).where(eq(streaks.userId, userId)).limit(1)

  const next = advanceStreak({
    previous: existing
      ? {
          currentDays: existing.currentDays,
          longestDays: existing.longestDays,
          lastLoggedDate: existing.lastLoggedDate,
          freezesAvailable: existing.freezesAvailable,
          freezeRefreshedOn: existing.freezeRefreshedOn,
        }
      : {
          currentDays: 0,
          longestDays: 0,
          lastLoggedDate: null,
          freezesAvailable: FREEZE_GRANT_PER_WEEK,
          freezeRefreshedOn: null,
        },
    today,
  })

  await db
    .insert(streaks)
    .values({
      userId,
      currentDays: next.currentDays,
      longestDays: next.longestDays,
      lastLoggedDate: next.lastLoggedDate,
      freezesAvailable: next.freezesAvailable,
      freezeRefreshedOn: next.freezeRefreshedOn,
    })
    .onConflictDoUpdate({
      target: streaks.userId,
      set: {
        currentDays: next.currentDays,
        longestDays: next.longestDays,
        lastLoggedDate: next.lastLoggedDate,
        freezesAvailable: next.freezesAvailable,
        freezeRefreshedOn: next.freezeRefreshedOn,
        updatedAt: sql`now()`,
      },
    })

  return next
}

export async function getStreak(
  db: Database,
  userId: string,
  at = new Date(),
  offsetMinutes = 330,
): Promise<StreakState> {
  const [row] = await db.select().from(streaks).where(eq(streaks.userId, userId)).limit(1)
  const today = localDate(at, offsetMinutes)

  if (!row) {
    return { currentDays: 0, longestDays: 0, freezesAvailable: FREEZE_GRANT_PER_WEEK, loggedToday: false }
  }

  // A stored streak goes stale the moment the user stops logging, so report
  // what it is worth *now* rather than what it was when last written.
  const gap = row.lastLoggedDate === null ? Infinity : daysBetween(row.lastLoggedDate, today)
  const missed = Math.max(0, gap - 1)
  const survives = missed <= row.freezesAvailable

  return {
    currentDays: survives ? row.currentDays : 0,
    longestDays: row.longestDays,
    freezesAvailable: row.freezesAvailable,
    loggedToday: row.lastLoggedDate === today,
  }
}
