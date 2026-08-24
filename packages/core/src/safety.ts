/**
 * Deterministic safety gate.
 *
 * Runs on every inbound user message BEFORE any model call, and on every
 * profile change. Two properties matter more here than coverage does:
 *
 *   1. It is not persuadable. There is no prompt, so there is nothing to argue
 *      around. A user insisting does not change the outcome.
 *   2. It is auditable. Every decision is a pattern we can point at. That is
 *      what makes it safe to use cheap open models elsewhere in the system:
 *      those models score 32-47% on triage and 56-80% on clinical safety, so
 *      they are never allowed near these decisions.
 */

import { bmi, type UserProfile } from './targets.ts'

export type RiskLevel = 'none' | 'caution' | 'block'

export interface SafetyVerdict {
  level: RiskLevel
  /** Stable codes. These get logged for rate analysis; message text never does. */
  reasons: string[]
  /** Shown verbatim when level is not 'none'. Never model-generated. */
  message?: string
}

/** India. Free, 24x7, multilingual. */
const HELPLINE = 'Tele-MANAS (India) 14416 — free, 24x7, many languages.'

/**
 * Disordered-eating signals.
 *
 * Deliberately wide. A false positive costs one gentle message; a false
 * negative means coaching someone toward harm. An earlier draft required a
 * bare noun after the verb and let "i throw up after my meals" through as
 * clean - the worst miss this gate can make - hence the optional objects here.
 */
const ED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(purge|purging|purged)\b/i, 'ed_purging'],
  [/\b(throw(ing|s)?|threw)\s+up\b/i, 'ed_purging'],
  [/\b(vomit(ing|ed|s)?|puk(e|ing|ed))\b[^.!?]{0,30}\b(after|post)\b/i, 'ed_purging'],
  [/\bmake (myself|my self) (sick|throw up|vomit)\b/i, 'ed_purging'],
  [/\b(laxative|diuretic|water pill)s?\b/i, 'ed_laxatives'],
  [/\b(starv(e|ing)|not eat(ing)?)\s+(myself|my self)\b/i, 'ed_starvation'],
  [/\bstarv(e|ing)\b[^.!?]{0,25}\b(lose|weight|thin|skinny)\b/i, 'ed_starvation'],
  [
    /\b(not|don'?t|won'?t|wont|skip(ping)?)\s+(eat|eating|food|meals?)\b[^.!?]{0,25}\b\d*\s*(day|days|week)s?\b/i,
    'ed_fasting_extreme',
  ],
  [/\b(anorexi|bulimi|orthorexi)\w*/i, 'ed_named'],
  [/\bhow (few|little|low)\b[^.!?]{0,25}\b(calorie|cal|kcal)s?\b/i, 'ed_min_calories'],
  [/\b[2-9]\d{2}\s*(kcal|calorie|cal)s?\b[^.!?]{0,15}\b(a|per)\s*day\b/i, 'ed_vlcd'],
  [/\b(hate|disgust\w*|repuls\w*)\b[^.!?]{0,20}\bmy (body|self|thighs|stomach|face)\b/i, 'ed_body_hate'],
]

/**
 * Codes above that are only suspicious absent an ordinary explanation.
 * "threw up" means something very different beside "fever" than beside "after
 * every meal", and the illness word usually PRECEDES the verb - so this is
 * matched against the whole message rather than as a forward lookahead.
 */
const CONTEXT_SUPPRESSIBLE: ReadonlySet<string> = new Set(['ed_purging'])

const ILLNESS_CONTEXT =
  /\b(sick|ill|illness|flu|fever|viral|food.?poison\w*|hangover|drunk|infection|migraine|motion sickness|chemo\w*)\b/i

/** Explicit intent overrides any illness explanation. */
const PURGING_EXPLICIT =
  /\b(purge|purging|purged|make (myself|my self) (sick|throw up|vomit)|after (every|each|my) meals?)\b/i

const SELF_HARM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(kill myself|end my life|suicid\w*|self.?harm|want to die)\b/i, 'self_harm'],
]

/**
 * Symptoms that are a doctor's job. We surface and route out - we never assess
 * urgency ourselves, because triage is the least-solved capability of every
 * model measured.
 */
const MEDICAL_RED_FLAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bchest (pain|tightness|pressure)\b/i, 'med_chest_pain'],
  [/\b(fainted|fainting|passed out|blacked out)\b/i, 'med_syncope'],
  [/\bblood in (my )?(stool|urine|vomit|phlegm)\b/i, 'med_bleeding'],
  [/\b(can'?t|cannot|couldn'?t) (breathe|stop vomiting)\b/i, 'med_acute'],
  [/\bunexplained weight loss\b/i, 'med_unexplained_loss'],
  [/\b(numbness|weakness) (on |in )?one side\b/i, 'med_stroke'],
  [/\bslurred speech\b/i, 'med_stroke'],
  [/\bsevere (abdominal|stomach) pain\b/i, 'med_acute_abdomen'],
]

const PREGNANCY = /\b(pregnan\w*|expecting|breastfeed\w*|lactating|postpartum)\b/i

function match(text: string, patterns: ReadonlyArray<readonly [RegExp, string]>): string[] {
  const hits: string[] = []
  for (const [re, code] of patterns) {
    if (re.test(text) && !hits.includes(code)) hits.push(code)
  }
  return hits
}

/**
 * Screen a user message. Call before every model invocation, without exception.
 *
 * Order is deliberate: self-harm outranks eating-disorder signals, which
 * outrank medical red flags, because each response supersedes the next.
 */
export function screenMessage(text: string): SafetyVerdict {
  const selfHarm = match(text, SELF_HARM_PATTERNS)
  if (selfHarm.length > 0) {
    return {
      level: 'block',
      reasons: selfHarm,
      message:
        "I'm not the right kind of help for this, and I don't want to hand you a meal plan " +
        `instead of what actually matters. Please talk to someone. ${HELPLINE}`,
    }
  }

  let ed = match(text, ED_PATTERNS)
  if (ILLNESS_CONTEXT.test(text) && !PURGING_EXPLICIT.test(text)) {
    ed = ed.filter((code) => !CONTEXT_SUPPRESSIBLE.has(code))
  }
  if (ed.length > 0) {
    return {
      level: 'block',
      reasons: ed,
      message:
        "I'm going to stop here rather than help with this. What you're describing can do real " +
        'damage, and a food plan from me would make it worse, not better. A doctor or a ' +
        `counsellor is the useful next step. ${HELPLINE}`,
    }
  }

  const medical = match(text, MEDICAL_RED_FLAGS)
  if (medical.length > 0) {
    return {
      level: 'caution',
      reasons: medical,
      message:
        'That is a symptom to get checked by a doctor rather than something to fix with food. ' +
        'Please see one soon. I can keep helping with meals in the meantime.',
    }
  }

  if (PREGNANCY.test(text)) {
    return {
      level: 'caution',
      reasons: ['pregnancy'],
      message:
        'Nutrition during pregnancy and breastfeeding needs a doctor or dietitian who knows ' +
        'your case — I would be guessing. I can still help with everyday cooking ideas.',
    }
  }

  return { level: 'none', reasons: [] }
}

/** Profile gate. Runs at onboarding and on every profile edit. */
export function screenProfile(p: UserProfile): SafetyVerdict {
  if (p.ageYears < 18) {
    return {
      level: 'block',
      reasons: ['minor'],
      message:
        'This app is built for adults. Growing bodies need different guidance than anything I ' +
        'can safely give — please talk to a doctor or a paediatric dietitian.',
    }
  }

  const index = bmi(p.weightKg, p.heightCm)

  if (index < 17.5 && (p.goal === 'lose' || p.goal === 'recomp')) {
    return {
      level: 'block',
      reasons: ['underweight_cut'],
      message:
        'At your current height and weight, losing more is not something I will plan for. If ' +
        'you want to feel stronger or fitter I can help you eat more, not less — or you can ' +
        'talk to a doctor first.',
    }
  }

  if (index < 18.5) return { level: 'caution', reasons: ['underweight'] }
  return { level: 'none', reasons: [] }
}
