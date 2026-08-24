/**
 * @ogt/core — the deterministic layer.
 *
 * Everything exported here runs without a model. That separation is the whole
 * safety argument of this product: cheap open models handle language and
 * vision, and never touch targets, triage, or which questions get asked.
 */

export {
  basalMetabolicRate,
  bmi,
  computeTargets,
  type ActivityLevel,
  type Goal,
  type Sex,
  type Targets,
  type UserProfile,
} from './targets.ts'

export {
  screenMessage,
  screenProfile,
  type RiskLevel,
  type SafetyVerdict,
} from './safety.ts'

export {
  IMPACT_THRESHOLD,
  MAX_QUESTIONS,
  impactOf,
  knownKey,
  planQuestions,
  type Plan,
  type PlanInput,
  type Question,
  type Unknown,
  type UnknownKind,
} from './questions.ts'

export {
  LABEL,
  ROUGH_CONFIDENCE_CEILING,
  classify,
  rollUp,
  type Confidence,
  type ConfidenceInput,
} from './confidence.ts'
