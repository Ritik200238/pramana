/**
 * Database schema — the hot path.
 *
 * Postgres holds everything live. 0G Storage holds the durable, encrypted,
 * user-owned copy. The UI never blocks on storage or chain, so this is the
 * source of truth for reads and the snapshot job is asynchronous.
 *
 * Three decisions here are the ones the PRD flagged as expensive to retrofit,
 * and they are made deliberately:
 *
 *   1. **Household is first-class**, not a user setting. One cook, several
 *      eaters, separate targets. Every Western app models a single tracked
 *      individual; Indian eating is a household activity.
 *
 *   2. **Cooking fat is a property of a dish**, not a note on it. Roti with
 *      ghee and roti without are different foods, because they differ by more
 *      calories than most people's daily deficit.
 *
 *   3. **A user's own food entry supersedes the global database.** Correcting
 *      a dish creates the user's version rather than editing a shared record.
 *      This is R5 in schema form and it is the compounding moat.
 */

import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const sexEnum = pgEnum('sex', ['male', 'female'])
export const goalEnum = pgEnum('goal', ['lose', 'gain', 'maintain', 'recomp'])
export const activityEnum = pgEnum('activity', [
  'sedentary',
  'light',
  'moderate',
  'active',
  'very_active',
])
export const dietEnum = pgEnum('diet', ['veg', 'nonveg', 'egg', 'vegan', 'jain'])
export const cooksEnum = pgEnum('cooks', ['self', 'family', 'mess', 'tiffin', 'mixed'])
export const confidenceEnum = pgEnum('confidence', ['exact', 'confirmed', 'rough'])
export const mealTypeEnum = pgEnum('meal_type', ['breakfast', 'lunch', 'dinner', 'snack'])
export const cookingFatEnum = pgEnum('cooking_fat', ['none', 'oil', 'ghee', 'butter'])
export const chatRoleEnum = pgEnum('chat_role', ['user', 'assistant'])
export const factKindEnum = pgEnum('fact_kind', [
  'sleep',
  'workout',
  'mood',
  'symptom',
  'energy',
  'weight',
  'travel',
  'cycle',
  'medication',
  'other',
])

// -------------------------------------------------------------------- auth

/**
 * One-time codes for phone sign-in.
 *
 * Codes are stored **hashed**, never in plaintext. A database read must not
 * hand someone the ability to sign in as anyone — the same reason we do not
 * store passwords, applied to something that is a password for sixty seconds.
 *
 * `attempts` exists because a 6-digit code is only 10^6 wide: without a
 * ceiling, brute force is a few thousand requests. Five tries and it is dead.
 */
export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** E.164. The identity being proven. */
    phone: text('phone').notNull(),
    /** scrypt(code, salt). Never the code itself. */
    codeHash: text('code_hash').notNull(),
    salt: text('salt').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('otp_phone_idx').on(table.phone, table.createdAt),
    index('otp_expiry_idx').on(table.expiresAt),
  ],
)

/**
 * Idempotency records.
 *
 * The client queues meals while offline and replays them when the signal comes
 * back. A replay that the server has already applied — the response was lost,
 * not the request — must not log the same dinner twice, because the person
 * cannot tell the difference between a duplicate and a mistake they made, and
 * a food log they do not trust is one they stop opening.
 *
 * The key is scoped to a user. Two people cannot collide, and neither can one
 * person read back another's response by guessing a key.
 *
 * `completedAt` being null means a request with this key is in flight. That
 * distinction is what makes two simultaneous replays safe: the second is told
 * to retry rather than being allowed to run the same write concurrently.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Client-supplied. Unique per user, not globally. */
    key: text('key').notNull(),
    /** Method and route pattern, so one key cannot be reused across endpoints. */
    endpoint: text('endpoint').notNull(),
    /** Hash of the body, to catch a key reused with different content. */
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    responseBody: jsonb('response_body'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The constraint is the mechanism, not an optimisation: it is what makes
    // two concurrent replays resolve to one winner.
    uniqueIndex('idempotency_user_key_idx').on(table.userId, table.key),
    index('idempotency_created_idx').on(table.createdAt),
  ],
)

/**
 * Sessions.
 *
 * Opaque random tokens, stored hashed, rather than JWTs. Two reasons, and both
 * matter more here than statelessness does:
 *
 *   1. **Revocable.** A user can end a session and it ends immediately. A JWT
 *      is valid until it expires, whatever we would like to happen.
 *   2. **No key management.** A leaked signing key forges every identity at
 *      once; a leaked session row is one session.
 *
 * For a health product where a stolen session reads someone's medical history,
 * revocation is worth a database lookup per request.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the bearer token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    /** Truncated to a /24 — enough to spot a stolen session, not a movement log. */
    ipPrefix: text('ip_prefix'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expiry_idx').on(table.expiresAt),
  ],
)

// --------------------------------------------------------------- household

export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  /** Default cooking fat for this kitchen. Set once, applied everywhere. */
  defaultCookingFat: cookingFatEnum('default_cooking_fat').notNull().default('oil'),
  defaultFatTsp: real('default_fat_tsp').notNull().default(1),
  /**
   * Staples usually in this kitchen. Feeds feature 10 — a suggestion that
   * ignores what you actually have is the "generic diet plan" users already
   * rejected: "they make ur diet plan n leave it to u".
   */
  pantry: jsonb('pantry').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ------------------------------------------------------------------- users

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id').references(() => households.id, { onDelete: 'set null' }),

    phone: text('phone').unique(),
    email: text('email').unique(),
    displayName: text('display_name'),

    sex: sexEnum('sex'),
    ageYears: integer('age_years'),
    heightCm: real('height_cm'),
    activity: activityEnum('activity').default('light'),
    goal: goalEnum('goal').default('maintain'),
    paceKgPerWeek: real('pace_kg_per_week'),

    diet: dietEnum('diet').default('veg'),
    cooks: cooksEnum('cooks').default('self'),

    /** Learned from when they actually log; drives notification timing. */
    mealTimes: jsonb('meal_times').$type<{ breakfast?: string; lunch?: string; dinner?: string }>(),

    /** Gentle / straight / blunt. Never sycophantic at any setting. */
    tone: text('tone').notNull().default('straight'),

    /**
     * Compressed secp256k1 public key the record is ECIES-encrypted to.
     * We never hold the matching private key.
     */
    recordPubKey: text('record_pub_key'),
    /** Address that anchors this user's snapshots on 0G Chain. */
    anchorAddress: text('anchor_address'),

    /** Set when the safety gate has permanently blocked this profile. */
    blockedReason: text('blocked_reason'),

    proactiveOptOut: boolean('proactive_opt_out').notNull().default(false),
    lastProactiveAt: timestamp('last_proactive_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('users_household_idx').on(table.householdId)],
)

/** Weight is a series, not a field. Feature 27 fits a metabolism from it. */
export const weightLogs = pgTable(
  'weight_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weightKg: real('weight_kg').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('weight_user_time_idx').on(table.userId, table.recordedAt)],
)

// ------------------------------------------------------------------- foods

/** Shared reference data. Never edited by a user correction. */
export const globalFoods = pgTable(
  'global_foods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Hindi, regional, and colloquial names that mean the same dish. */
    aliases: jsonb('aliases').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Household unit this dish is counted in: katori, roti, glass, plate. */
    unit: text('unit').notNull(),
    gramsPerUnit: real('grams_per_unit').notNull(),
    kcalPer100g: real('kcal_per_100g').notNull(),
    proteinPer100g: real('protein_per_100g').notNull(),
    carbPer100g: real('carb_per_100g').notNull(),
    fatPer100g: real('fat_per_100g').notNull(),
    /** Whether cooking fat materially changes this dish. Drives R2. */
    fatVaries: boolean('fat_varies').notNull().default(false),
    /** IFCT, USDA, label — so a number can always be traced to its origin. */
    source: text('source').notNull(),
  },
  (table) => [index('global_foods_name_idx').on(table.name)],
)

/**
 * The user's own version of a dish. R5.
 *
 * Created on correction. Always outranks `global_foods` in that user's search.
 * This is why month six beats month one for the same person.
 */
export const userFoods = pgTable(
  'user_foods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** What they call it. Matching is done on the normalised form. */
    name: text('name').notNull(),
    normalisedName: text('normalised_name').notNull(),
    basedOnGlobalFoodId: uuid('based_on_global_food_id').references(() => globalFoods.id),

    unit: text('unit').notNull(),
    gramsPerUnit: real('grams_per_unit').notNull(),
    kcalPer100g: real('kcal_per_100g').notNull(),
    proteinPer100g: real('protein_per_100g').notNull(),
    carbPer100g: real('carb_per_100g').notNull(),
    fatPer100g: real('fat_per_100g').notNull(),

    /** Their kitchen's answer, so R4 never asks again. */
    cookingFat: cookingFatEnum('cooking_fat'),
    cookingFatTsp: real('cooking_fat_tsp'),
    /** Their usual portion, so "your usual?" is one tap. */
    usualUnits: real('usual_units'),

    timesLogged: integer('times_logged').notNull().default(0),
    lastLoggedAt: timestamp('last_logged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_foods_unique_idx').on(table.userId, table.normalisedName)],
)

/**
 * Every attribute this user has settled, for any dish.
 *
 * Read as a set at question-planning time. This table IS rule R4 — its size is
 * why the question count decays, and querying it is cheaper than reasoning
 * about which questions were asked before.
 */
export const knownAttributes = pgTable(
  'known_attributes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `${normalisedFoodName}::${unknownKind}` — matches core's knownKey(). */
    attributeKey: text('attribute_key').notNull(),
    value: text('value').notNull(),
    /** How they settled it: answered a question, or corrected an entry. */
    settledBy: text('settled_by').notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('known_attr_unique_idx').on(table.userId, table.attributeKey)],
)

// ------------------------------------------------------------------- meals

export const meals = pgTable(
  'meals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mealType: mealTypeEnum('meal_type'),
    eatenAt: timestamp('eaten_at', { withTimezone: true }).notNull().defaultNow(),

    kcal: real('kcal').notNull(),
    proteinG: real('protein_g').notNull(),
    carbG: real('carb_g').notNull(),
    fatG: real('fat_g').notNull(),

    /** R3. Rolled up from the items. */
    confidence: confidenceEnum('confidence').notNull(),

    /** How it was logged: photo, text, voice, repeat. */
    source: text('source').notNull(),
    /** Model that read the photo, for cost and quality attribution. */
    model: text('model'),
    /** How many chain models failed before one answered. */
    failovers: integer('failovers').notNull().default(0),

    /**
     * The §6.2 thesis metric, recorded per meal.
     * Median of this across a week is the number that decides whether the
     * product's central claim is true.
     */
    questionsAsked: integer('questions_asked').notNull().default(0),
    questionsSkippedKnown: integer('questions_skipped_known').notNull().default(0),

    /** Set when the user edited after logging. Feeds R5 and measures learning. */
    correctedAt: timestamp('corrected_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('meals_user_time_idx').on(table.userId, table.eatenAt)],
)

export const mealItems = pgTable(
  'meal_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mealId: uuid('meal_id')
      .notNull()
      .references(() => meals.id, { onDelete: 'cascade' }),
    userFoodId: uuid('user_food_id').references(() => userFoods.id),
    globalFoodId: uuid('global_food_id').references(() => globalFoods.id),

    name: text('name').notNull(),
    /** As the user would say it: "2 roti", "1 katori". */
    portionLabel: text('portion_label').notNull(),
    units: real('units').notNull(),
    grams: real('grams').notNull(),

    kcal: real('kcal').notNull(),
    proteinG: real('protein_g').notNull(),
    carbG: real('carb_g').notNull(),
    fatG: real('fat_g').notNull(),

    cookingFat: cookingFatEnum('cooking_fat'),
    cookingFatTsp: real('cooking_fat_tsp'),

    /** Model confidence for this specific item, 0-1. */
    modelConfidence: real('model_confidence').notNull(),
    confidence: confidenceEnum('confidence').notNull(),
  },
  (table) => [index('meal_items_meal_idx').on(table.mealId)],
)

// ------------------------------------------------------- life chat (R6)

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: chatRoleEnum('role').notNull(),
    content: text('content').notNull(),
    /** True when the assistant started this exchange rather than the user. */
    proactive: boolean('proactive').notNull().default(false),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('chat_user_time_idx').on(table.userId, table.createdAt)],
)

/**
 * Structured facts extracted from the life chat.
 *
 * "slept badly, maybe 5 hours" becomes a sleep fact with a value. This is what
 * makes "why was I tired this week?" answerable, and it is the thing every
 * shipped competitor fails at — their coach cannot see their own product's data.
 */
export const lifeFacts = pgTable(
  'life_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceMessageId: uuid('source_message_id').references(() => chatMessages.id, {
      onDelete: 'set null',
    }),
    kind: factKindEnum('kind').notNull(),
    /** Normalised numeric value where one applies: hours slept, kg, 1-5 mood. */
    value: numeric('value', { precision: 10, scale: 2 }),
    unit: text('unit'),
    /** The user's own words, kept so we never paraphrase their experience back wrongly. */
    verbatim: text('verbatim').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

    /**
     * Set when a topic is finished. A resolved fact is NEVER raised again by
     * the proactive engine — this column exists because of a documented harm:
     * a coach that kept surfacing a healed injury for three months and then
     * argued with the user about it.
     */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('life_facts_user_kind_idx').on(table.userId, table.kind, table.occurredAt),
    index('life_facts_unresolved_idx').on(table.userId, table.resolvedAt),
  ],
)

// ---------------------------------------------------------------- safety

/**
 * Safety gate fires, by reason code only.
 *
 * Message text is deliberately absent. We need to know how often the gate
 * fires and on what class of input; we do not need — and must not keep — what
 * a distressed person typed.
 */
export const safetyEvents = pgTable(
  'safety_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    level: text('level').notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull(),
    surface: text('surface').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('safety_user_time_idx').on(table.userId, table.createdAt)],
)

// --------------------------------------------------------------- 0G record

/**
 * Nightly encrypted snapshots written to 0G Storage.
 *
 * `rootHashes` is the retrieval key. Losing it loses the data as surely as
 * deleting it, so it is stored here, anchored on chain, and included in every
 * export the user takes.
 */
export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rootHashes: jsonb('root_hashes').$type<string[]>().notNull(),
    txHashes: jsonb('tx_hashes').$type<string[]>().notNull(),
    schemaVersion: integer('schema_version').notNull(),
    bytes: integer('bytes').notNull(),
    fragmented: boolean('fragmented').notNull().default(false),
    /** Index in the on-chain anchor, once anchored. */
    anchorIndex: integer('anchor_index'),
    anchorTxHash: text('anchor_tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('snapshots_user_time_idx').on(table.userId, table.createdAt)],
)

export const attestationStatusEnum = pgEnum('attestation_status', [
  'verified',
  'failed',
  'unrequested',
  'unavailable',
])

/**
 * Per-call inference cost AND the TEE receipt that came with it.
 *
 * The cost columns keep free-tier viability observable rather than assumed. The
 * attestation columns are the more important half: they are the evidence behind
 * "nobody, including us, could read this".
 *
 * A receipt is only worth keeping if it stays attached to what it produced, so
 * it is recorded on the same row as the call rather than in a separate log
 * nobody would ever join against.
 */
export const inferenceUsage = pgTable(
  'inference_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    task: text('task').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    usd: numeric('usd', { precision: 12, scale: 8 }).notNull(),
    failovers: integer('failovers').notNull().default(0),

    /** Verdict from the Router's synchronous TEE signature check. */
    attestation: attestationStatusEnum('attestation').notNull().default('unrequested'),
    /** On-chain address of the enclave provider that served this call. */
    attestationProvider: text('attestation_provider'),
    /** Router request id, so a claim can be reconciled against their side. */
    attestationRequestId: text('attestation_request_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('usage_user_time_idx').on(table.userId, table.createdAt),
    index('usage_attestation_idx').on(table.userId, table.attestation),
  ],
)

/**
 * Streak state — feature 15.
 *
 * Duolingo's most-copied mechanic is not the streak, it is the freeze. Guilt
 * loses users; forgiveness keeps them. One free miss per week, granted
 * automatically and silently, because a streak that punishes a bad Tuesday is
 * how someone decides the whole thing is not for them.
 */
export const streaks = pgTable('streaks', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  currentDays: integer('current_days').notNull().default(0),
  longestDays: integer('longest_days').notNull().default(0),
  /** Local date of the most recent qualifying day. */
  lastLoggedDate: text('last_logged_date'),
  /** Unused forgiveness days. Replenishes weekly, capped. */
  freezesAvailable: integer('freezes_available').notNull().default(1),
  freezeRefreshedOn: text('freeze_refreshed_on'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// --------------------------------------------------- lab reports & markers

export const reportStatusEnum = pgEnum('report_status', ['pending', 'ready', 'failed'])

/**
 * An uploaded lab report — feature 16.
 *
 * The largest gap found in the research: Hindi videos explaining ECG, cancer
 * and ultrasound reports draw 2.2M, 1.05M and 903K views, while the best
 * AI-native equivalent has 706. Millions of people already do this work by
 * hand; nobody has served it.
 *
 * We store what was extracted, never a diagnosis. The raw image is not kept —
 * it goes to the model, the markers come back, and the file is discarded. A
 * lab report sitting in object storage is a liability we have no reason to
 * accept when the numbers are the useful part.
 */
export const labReports = pgTable(
  'lab_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: reportStatusEnum('status').notNull().default('pending'),
    /** Lab or hospital name, when the report states one. */
    labName: text('lab_name'),
    /** Date the sample was taken, not the date it was uploaded. */
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    model: text('model'),
    /** Plain-language summary. Explains; never interprets clinically. */
    summary: text('summary'),
    /** Set when the extraction found nothing usable. */
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('lab_reports_user_time_idx').on(table.userId, table.createdAt)],
)

export const markerFlagEnum = pgEnum('marker_flag', ['low', 'normal', 'high', 'unknown'])

/**
 * One measured value — feature 17.
 *
 * Stored per report so a marker becomes a series rather than a snapshot.
 * "Is it getting better or worse" is the question people actually have, and it
 * is unanswerable from a single PDF.
 */
export const healthMarkers = pgTable(
  'health_markers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportId: uuid('report_id').references(() => labReports.id, { onDelete: 'cascade' }),
    /** Normalised key so the same marker matches across labs: 'hba1c', 'ldl'. */
    code: text('code').notNull(),
    /** The name printed on the report, kept verbatim. */
    name: text('name').notNull(),
    value: numeric('value', { precision: 12, scale: 3 }).notNull(),
    unit: text('unit').notNull(),
    /** The lab's own reference range. Ranges differ between labs. */
    refLow: numeric('ref_low', { precision: 12, scale: 3 }),
    refHigh: numeric('ref_high', { precision: 12, scale: 3 }),
    flag: markerFlagEnum('flag').notNull().default('unknown'),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('markers_user_code_time_idx').on(table.userId, table.code, table.measuredAt),
  ],
)

// ------------------------------------------------------------- relations

export const usersRelations = relations(users, ({ one, many }) => ({
  household: one(households, {
    fields: [users.householdId],
    references: [households.id],
  }),
  meals: many(meals),
  chatMessages: many(chatMessages),
  lifeFacts: many(lifeFacts),
  userFoods: many(userFoods),
  weightLogs: many(weightLogs),
  snapshots: many(snapshots),
}))

export const householdsRelations = relations(households, ({ many }) => ({
  members: many(users),
}))

export const mealsRelations = relations(meals, ({ one, many }) => ({
  user: one(users, { fields: [meals.userId], references: [users.id] }),
  items: many(mealItems),
}))

export const mealItemsRelations = relations(mealItems, ({ one }) => ({
  meal: one(meals, { fields: [mealItems.mealId], references: [meals.id] }),
}))

export const labReportsRelations = relations(labReports, ({ one, many }) => ({
  user: one(users, { fields: [labReports.userId], references: [users.id] }),
  markers: many(healthMarkers),
}))

export const healthMarkersRelations = relations(healthMarkers, ({ one }) => ({
  user: one(users, { fields: [healthMarkers.userId], references: [users.id] }),
  report: one(labReports, { fields: [healthMarkers.reportId], references: [labReports.id] }),
}))

export const lifeFactsRelations = relations(lifeFacts, ({ one }) => ({
  user: one(users, { fields: [lifeFacts.userId], references: [users.id] }),
  sourceMessage: one(chatMessages, {
    fields: [lifeFacts.sourceMessageId],
    references: [chatMessages.id],
  }),
}))
