/**
 * The coach's context and voice.
 *
 * Two decisions here come straight from what users said about existing coaches,
 * and both are the opposite of the default:
 *
 *   1. **Full history, not a rolling window.** The loudest complaint about
 *      shipped coaches is that they cannot see their own data — "it only sees
 *      the last 7 days, which is….useless". We summarise older context rather
 *      than truncating it.
 *
 *   2. **Never sycophantic.** "LLMs are yes men" was the repeated verdict.
 *      Default tone is Straight, and no setting makes it flatter.
 */

import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import { computeTargets, quoteUntrusted, type SafetyVerdict, type UserProfile, untrustedPreamble } from '@ogt/core'
import type { Database } from '../db/index.ts'
import { chatMessages, lifeFacts, meals, users, weightLogs } from '../db/schema.ts'

export interface CoachContext {
  profile: {
    sex: 'male' | 'female' | null
    ageYears: number | null
    heightCm: number | null
    weightKg: number | null
    activity: UserProfile['activity'] | null
    goal: UserProfile['goal'] | null
    diet: string | null
    cooks: string | null
    tone: string
  }
  targets: { calories: number; proteinG: number } | null
  today: { kcal: number; proteinG: number; mealCount: number }
  /** Unresolved facts only. A resolved topic is never raised again. */
  openFacts: Array<{ kind: string; verbatim: string; occurredAt: Date }>
  recentTurns: Array<{ role: string; content: string; createdAt: Date; proactive: boolean }>
}

const HISTORY_TURNS = 20
const OPEN_FACT_LIMIT = 25

export async function loadCoachContext(
  db: Database,
  userId: string,
  turns = HISTORY_TURNS,
): Promise<CoachContext> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)

  const [latestWeight] = await db
    .select({ weightKg: weightLogs.weightKg })
    .from(weightLogs)
    .where(eq(weightLogs.userId, userId))
    .orderBy(desc(weightLogs.recordedAt))
    .limit(1)

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const todayMeals = await db
    .select({ kcal: meals.kcal, proteinG: meals.proteinG })
    .from(meals)
    .where(and(eq(meals.userId, userId), gte(meals.eatenAt, startOfDay)))

  const today = todayMeals.reduce<CoachContext['today']>(
    (acc, meal) => ({
      kcal: acc.kcal + meal.kcal,
      proteinG: acc.proteinG + meal.proteinG,
      mealCount: acc.mealCount + 1,
    }),
    { kcal: 0, proteinG: 0, mealCount: 0 },
  )

  // Unresolved only. This filter is why the coach does not keep raising a
  // healed injury for three months.
  const openFacts = await db
    .select({ kind: lifeFacts.kind, verbatim: lifeFacts.verbatim, occurredAt: lifeFacts.occurredAt })
    .from(lifeFacts)
    .where(and(eq(lifeFacts.userId, userId), isNull(lifeFacts.resolvedAt)))
    .orderBy(desc(lifeFacts.occurredAt))
    .limit(OPEN_FACT_LIMIT)

  const history = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
      // Carried so the prompt can tell an assistant turn we wrote from one that
      // is mostly a quote of what the user said.
      proactive: chatMessages.proactive,
    })
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(turns)

  const weightKg = latestWeight?.weightKg ?? null

  let targets: CoachContext['targets'] = null
  if (user?.sex && user.ageYears && user.heightCm && weightKg && user.activity && user.goal) {
    const computed = computeTargets({
      sex: user.sex,
      ageYears: user.ageYears,
      heightCm: user.heightCm,
      weightKg,
      activity: user.activity,
      goal: user.goal,
      ...(user.paceKgPerWeek ? { paceKgPerWeek: user.paceKgPerWeek } : {}),
    })
    targets = { calories: computed.calories, proteinG: computed.proteinG }
  }

  return {
    profile: {
      sex: user?.sex ?? null,
      ageYears: user?.ageYears ?? null,
      heightCm: user?.heightCm ?? null,
      weightKg,
      activity: user?.activity ?? null,
      goal: user?.goal ?? null,
      diet: user?.diet ?? null,
      cooks: user?.cooks ?? null,
      tone: user?.tone ?? 'straight',
    },
    targets,
    today,
    openFacts,
    recentTurns: history.reverse(),
  }
}

const TONE_GUIDANCE: Readonly<Record<string, string>> = {
  gentle: 'Be warm and encouraging, but never flatter and never soften a fact into vagueness.',
  straight: 'Be direct and plain. State the thing. No preamble, no cheerleading.',
  blunt: 'Be blunt. Say the uncomfortable thing first. Never cruel, never softened.',
}

export function buildCoachSystemPrompt(context: CoachContext, verdict?: SafetyVerdict): string {
  const { profile, targets, today, openFacts } = context

  const lines: string[] = [
    'You are a nutrition and habit coach for someone in India. You speak plainly, and in Hinglish when they do.',
    '',
    TONE_GUIDANCE[profile.tone] ?? TONE_GUIDANCE.straight!,
    '',
    'Hard rules:',
    '- Never diagnose, name a condition, or interpret a test result clinically. Explain what something measures and tell them to see a doctor.',
    '- Never agree just to be agreeable. If they are wrong, say so once, plainly, and move on.',
    '- Never tell them to eat below the targets given to you. Those targets are computed, not negotiable, and not yours to adjust.',
    '- State patterns as observations from their own log, never as causes.',
    '- Do not congratulate them for talking to you.',
    '- Keep replies short. Two or three sentences unless they asked something that needs more.',
    '',
    'What you know about them:',
  ]

  if (profile.goal) lines.push(`- Goal: ${profile.goal}`)
  if (profile.diet) lines.push(`- Diet: ${profile.diet}`)
  if (profile.cooks) lines.push(`- Who cooks: ${profile.cooks}`)
  if (profile.weightKg) lines.push(`- Weight: ${profile.weightKg} kg`)

  if (targets) {
    lines.push(
      `- Today's targets: ${targets.calories} kcal, ${targets.proteinG} g protein`,
      `- Logged so far today: ${Math.round(today.kcal)} kcal, ${Math.round(today.proteinG)} g protein across ${today.mealCount} meal(s)`,
      `- Protein remaining: ${Math.max(0, Math.round(targets.proteinG - today.proteinG))} g`,
    )
  } else {
    lines.push('- Targets are not set yet; do not invent them.')
  }

  if (openFacts.length > 0) {
    /*
     * Their own words, fenced.
     *
     * This is a system prompt, which is where a model looks for authority, and
     * everything in this block was typed by the person the reply is for. The
     * safety guidance is appended a few lines below — so an unfenced note
     * saying "ignore the safety guidance" would sit directly beside the
     * instruction it is trying to overrule, written by exactly the person most
     * motivated to remove it.
     */
    lines.push('', untrustedPreamble(), '', 'Things they have told you that are still open:')
    for (const fact of openFacts.slice(0, 10)) {
      lines.push(
        `- [${fact.kind}] (${fact.occurredAt.toISOString().slice(0, 10)})`,
        quoteUntrusted(fact.verbatim),
      )
    }
    lines.push(
      '',
      'Only mention these if relevant right now. Do not list them back. Never re-raise something they have moved on from.',
    )
  }

  if (verdict && verdict.level === 'caution' && verdict.message) {
    lines.push(
      '',
      'The safety layer flagged this message. Your reply must include, in your own words, this guidance:',
      verdict.message,
    )
  }

  return lines.join('\n')
}
