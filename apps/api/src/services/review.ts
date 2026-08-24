/**
 * Reviews and questions about your own data — features 11, 12, 14.
 *
 * The complaint these answer was said, near-verbatim, in three separate
 * subreddits:
 *
 *   "Apple Health works well as a central hub, but once the data is there, it
 *    mostly stops at charts."
 *   "whoop, oura, garmin... tons of metrics, zero actual coaching."
 *
 * So the output here is never a chart and never a score. It is one sentence
 * about what happened and one thing to change — and the numbers behind it are
 * computed in code, not by the model, so the model can only phrase a fact it
 * was handed.
 */

import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { computeTargets, type Targets } from '@ogt/core'
import type OpenAI from 'openai'
import { complete } from '@ogt/og'
import type { Database } from '../db/index.ts'
import { healthMarkers, lifeFacts, meals, users, weightLogs } from '../db/schema.ts'
import { dayBounds } from './day.ts'

// ------------------------------------------------------------- computed facts

export interface DayFacts {
  date: string
  kcal: number
  proteinG: number
  mealCount: number
  proteinTargetG: number | null
  proteinHit: boolean
  questionsAsked: number
}

export interface WeekFacts {
  from: string
  to: string
  days: DayFacts[]
  daysLogged: number
  meanProteinG: number
  meanKcal: number
  proteinHitDays: number
  /** Mean questions per meal — the thesis metric, over a week. */
  questionsPerMeal: number
  weightChangeKg: number | null
  sleepMeanHours: number | null
  lowEnergyDays: number
}

/**
 * Aggregate a window in SQL and arithmetic only.
 *
 * Everything the model later says has to be traceable to a number in here.
 * That constraint is what keeps a "review" from drifting into invention.
 */
export async function computeWeekFacts(
  db: Database,
  userId: string,
  now: Date,
  offsetMinutes = 330,
): Promise<WeekFacts> {
  const { from: todayStart, to: todayEnd } = dayBounds(now, offsetMinutes)
  const weekStart = new Date(todayStart.getTime() - 6 * 86_400_000)

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)

  const weights = await db
    .select()
    .from(weightLogs)
    .where(and(eq(weightLogs.userId, userId), gte(weightLogs.recordedAt, weekStart)))
    .orderBy(asc(weightLogs.recordedAt))

  const latestWeight = weights.at(-1)?.weightKg ?? null

  let targets: Targets | null = null
  if (user?.sex && user.ageYears && user.heightCm && user.activity && user.goal && latestWeight) {
    targets = computeTargets({
      sex: user.sex,
      ageYears: user.ageYears,
      heightCm: user.heightCm,
      weightKg: latestWeight,
      activity: user.activity,
      goal: user.goal,
      ...(user.paceKgPerWeek ? { paceKgPerWeek: user.paceKgPerWeek } : {}),
    })
  }

  const rows = await db
    .select()
    .from(meals)
    .where(and(eq(meals.userId, userId), gte(meals.eatenAt, weekStart), lt(meals.eatenAt, todayEnd)))
    .orderBy(asc(meals.eatenAt))

  const byDate = new Map<string, DayFacts>()
  for (let offset = 0; offset < 7; offset += 1) {
    const dayStart = new Date(weekStart.getTime() + offset * 86_400_000)
    const key = new Date(dayStart.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10)
    byDate.set(key, {
      date: key,
      kcal: 0,
      proteinG: 0,
      mealCount: 0,
      proteinTargetG: targets?.proteinG ?? null,
      proteinHit: false,
      questionsAsked: 0,
    })
  }

  for (const meal of rows) {
    const key = new Date(meal.eatenAt.getTime() + offsetMinutes * 60_000)
      .toISOString()
      .slice(0, 10)
    const day = byDate.get(key)
    if (!day) continue
    day.kcal += meal.kcal
    day.proteinG += meal.proteinG
    day.mealCount += 1
    day.questionsAsked += meal.questionsAsked
  }

  for (const day of byDate.values()) {
    day.proteinHit = targets ? day.proteinG >= targets.proteinG * 0.9 : false
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  const logged = days.filter((day) => day.mealCount > 0)

  const sleep = await db
    .select({ avg: sql<number>`avg(${lifeFacts.value})` })
    .from(lifeFacts)
    .where(
      and(
        eq(lifeFacts.userId, userId),
        eq(lifeFacts.kind, 'sleep'),
        gte(lifeFacts.occurredAt, weekStart),
      ),
    )

  const lowEnergy = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(lifeFacts)
    .where(
      and(
        eq(lifeFacts.userId, userId),
        eq(lifeFacts.kind, 'energy'),
        gte(lifeFacts.occurredAt, weekStart),
      ),
    )

  const totalMeals = rows.length
  const totalQuestions = rows.reduce((sum, meal) => sum + meal.questionsAsked, 0)

  const firstWeight = weights[0]?.weightKg
  const lastWeight = weights.at(-1)?.weightKg

  return {
    from: days[0]?.date ?? '',
    to: days.at(-1)?.date ?? '',
    days,
    daysLogged: logged.length,
    meanProteinG: mean(logged.map((day) => day.proteinG)),
    meanKcal: mean(logged.map((day) => day.kcal)),
    proteinHitDays: days.filter((day) => day.proteinHit).length,
    questionsPerMeal: totalMeals === 0 ? 0 : totalQuestions / totalMeals,
    weightChangeKg:
      firstWeight !== undefined && lastWeight !== undefined && weights.length > 1
        ? Number((lastWeight - firstWeight).toFixed(2))
        : null,
    sleepMeanHours: sleep[0]?.avg ? Number(Number(sleep[0].avg).toFixed(1)) : null,
    lowEnergyDays: lowEnergy[0]?.count ?? 0,
  }
}

// ------------------------------------------------------------- the one line

const DAY_LINE_PROMPT = `You write one short line about someone's day, then one thing to change tomorrow.

Rules:
- Two sentences maximum. No preamble, no greeting, no encouragement.
- Use only the numbers given to you. Never invent one, never estimate.
- State what happened, then the single most useful change. One change, not a list.
- If they hit their protein, say so plainly and pick something else to nudge.
- If they logged nothing, do not scold. Say one useful thing and stop.
- Never mention a score. There is no score.
- Plain English or Hinglish, matching how they write.`

export interface DayLineInput {
  client: OpenAI
  facts: DayFacts
  streakDays: number
  tone: string
}

export async function writeDayLine(input: DayLineInput): Promise<{ text: string; model: string }> {
  const { facts } = input

  const summary = [
    `Date: ${facts.date}`,
    `Meals logged: ${facts.mealCount}`,
    `Protein: ${Math.round(facts.proteinG)}g${facts.proteinTargetG ? ` of ${facts.proteinTargetG}g target` : ''}`,
    `Calories: ${Math.round(facts.kcal)}`,
    `Protein target met: ${facts.proteinHit ? 'yes' : 'no'}`,
    `Current streak: ${input.streakDays} days`,
    `Tone: ${input.tone}`,
  ].join('\n')

  const result = await complete(input.client, {
    task: 'coach',
    messages: [
      { role: 'system', content: DAY_LINE_PROMPT },
      { role: 'user', content: summary },
    ],
    maxTokens: 120,
    temperature: 0.4,
  })

  return { text: result.text.trim(), model: result.model }
}

// ------------------------------------------------------------ weekly review

const WEEK_PROMPT = `You write a short weekly review of someone's eating.

Rules:
- Three sentences maximum, then exactly one adjustment for next week.
- Use only the numbers given. Never invent one.
- State patterns as observations from their own log, never as causes and never as diagnosis. "Your protein was lower on the days you skipped breakfast" is fine. "Skipping breakfast caused it" is not.
- One adjustment. Specific and small enough to do tomorrow.
- No score, no grade, no praise for using the app.`

export interface WeekReviewInput {
  client: OpenAI
  facts: WeekFacts
  tone: string
}

export async function writeWeekReview(
  input: WeekReviewInput,
): Promise<{ text: string; model: string }> {
  const { facts } = input

  const summary = [
    `Window: ${facts.from} to ${facts.to}`,
    `Days logged: ${facts.daysLogged} of 7`,
    `Mean protein on logged days: ${Math.round(facts.meanProteinG)}g`,
    `Mean calories on logged days: ${Math.round(facts.meanKcal)}`,
    `Days protein target met: ${facts.proteinHitDays} of 7`,
    facts.weightChangeKg !== null ? `Weight change: ${facts.weightChangeKg}kg` : 'Weight change: not enough readings',
    facts.sleepMeanHours !== null ? `Mean sleep: ${facts.sleepMeanHours}h` : 'Sleep: not reported',
    `Low-energy mentions: ${facts.lowEnergyDays}`,
    `Tone: ${input.tone}`,
    '',
    'Per-day protein:',
    ...facts.days.map((day) => `  ${day.date}: ${Math.round(day.proteinG)}g across ${day.mealCount} meal(s)`),
  ].join('\n')

  const result = await complete(input.client, {
    task: 'coach',
    messages: [
      { role: 'system', content: WEEK_PROMPT },
      { role: 'user', content: summary },
    ],
    maxTokens: 320,
    temperature: 0.4,
  })

  return { text: result.text.trim(), model: result.model }
}

// -------------------------------------------------------- ask your own data

const ASK_PROMPT = `You answer questions about a person's own logged health data.

Rules:
- Answer only from the records given to you. If the records do not support an answer, say exactly what is missing.
- Show your working: name the numbers you used.
- Patterns, never causes. "These three things line up" is honest; "this caused that" is not.
- Never diagnose. If a medical explanation is plausible, say the pattern and tell them to ask a doctor.
- Short. Three or four sentences, unless they asked for detail.`

export interface AskInput {
  client: OpenAI
  question: string
  /** Everything relevant, already filtered in code — the model does no retrieval. */
  records: string
  tone: string
}

export async function askOwnData(input: AskInput): Promise<{ text: string; model: string }> {
  const result = await complete(input.client, {
    task: 'coach',
    messages: [
      { role: 'system', content: ASK_PROMPT },
      { role: 'user', content: `Question: ${input.question}\n\nTheir records:\n${input.records}` },
    ],
    maxTokens: 500,
    temperature: 0.3,
  })

  return { text: result.text.trim(), model: result.model }
}

/**
 * Assemble the records a question needs.
 *
 * Deliberately not a vector search: the corpus is one person's own log over a
 * bounded window, so filtering it in SQL is both cheaper and auditable. We can
 * say exactly what the model was shown.
 *
 * Note on windows: daily totals are always the last seven days, because that is
 * what `computeWeekFacts` produces, while notes and markers honour `days`. The
 * labels below state which window each block covers — an earlier version said
 * "last 7 days" over a 30-day request, which would have had the model answering
 * a month-long question from a week of totals without either of us noticing.
 */
export async function gatherRecords(
  db: Database,
  userId: string,
  days: number,
  now: Date,
  offsetMinutes = 330,
): Promise<string> {
  const since = new Date(now.getTime() - days * 86_400_000)

  const facts = await computeWeekFacts(db, userId, now, offsetMinutes)

  const notes = await db
    .select({
      kind: lifeFacts.kind,
      verbatim: lifeFacts.verbatim,
      value: lifeFacts.value,
      unit: lifeFacts.unit,
      occurredAt: lifeFacts.occurredAt,
    })
    .from(lifeFacts)
    .where(and(eq(lifeFacts.userId, userId), gte(lifeFacts.occurredAt, since)))
    .orderBy(desc(lifeFacts.occurredAt))
    .limit(120)

  const markers = await db
    .select({
      name: healthMarkers.name,
      value: healthMarkers.value,
      unit: healthMarkers.unit,
      flag: healthMarkers.flag,
      measuredAt: healthMarkers.measuredAt,
    })
    .from(healthMarkers)
    .where(eq(healthMarkers.userId, userId))
    .orderBy(desc(healthMarkers.measuredAt))
    .limit(40)

  const lines = [
    `Daily totals (last 7 days — this block is always 7 days):`,
    ...facts.days.map(
      (day) =>
        `  ${day.date}: ${Math.round(day.proteinG)}g protein, ${Math.round(day.kcal)} kcal, ${day.mealCount} meal(s)`,
    ),
    '',
    `Mean protein: ${Math.round(facts.meanProteinG)}g. Days logged: ${facts.daysLogged}/7.`,
    facts.weightChangeKg !== null ? `Weight change this week: ${facts.weightChangeKg}kg` : '',
    facts.sleepMeanHours !== null ? `Mean sleep: ${facts.sleepMeanHours}h` : '',
    '',
    `What they told me (last ${days} days):`,
    ...notes.map(
      (note) =>
        `  [${note.occurredAt.toISOString().slice(0, 10)}] ${note.kind}: "${note.verbatim}"${note.value ? ` (${note.value}${note.unit ?? ''})` : ''}`,
    ),
  ]

  if (markers.length > 0) {
    lines.push('', 'Lab markers (most recent, all time):')
    for (const marker of markers) {
      lines.push(
        `  [${marker.measuredAt.toISOString().slice(0, 10)}] ${marker.name}: ${marker.value}${marker.unit} (${marker.flag})`,
      )
    }
  }

  return lines.filter(Boolean).join('\n')
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
