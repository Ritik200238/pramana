/**
 * API client.
 *
 * Two properties this file is responsible for:
 *
 *   1. **Identity is never an argument.** The server derives the user from the
 *      session on every request. A client method taking a `userId` would
 *      re-create the vulnerability the backend just closed, so none of them do
 *      — the paths carry `me` rather than an id.
 *
 *   2. **A dropped log is a dropped habit.** Indian mobile networks are not
 *      reliable, so writes taken offline are queued and replayed. The person is
 *      told their meal is saved, never asked to retry something they already did.
 */

/*
 * Shared shapes come from the package that owns them.
 *
 * `Targets` and `Confidence` used to be restated here, which made them a copy
 * of a definition living somewhere else — the exact arrangement that has drifted
 * every other time it appeared in this repository. Imported as types only, so
 * nothing from the package reaches the browser bundle.
 */
import type { Confidence, Targets } from '@ogt/core'

export type { Confidence, Targets }

// ------------------------------------------------------------------- types





export interface DraftItem {
  id: string
  name: string
  unit: string
  units: number
  gramsPerUnit: number
  kcalPer100g: number
  proteinPer100g: number
  carbPer100g: number
  fatPer100g: number
  modelConfidence: number
}

export interface Question {
  itemId: string
  itemName: string
  kind: 'portion' | 'cooking_fat' | 'protein_source' | 'preparation'
  text: string
  options: string[]
}

export interface DraftResponse {
  vision: unknown
  items: DraftItem[]
  questions: Question[]
  unresolvedCount: number
  skippedKnown: number
  estimate: { kcal: number; proteinG: number; carbG: number; fatG: number }
  model: string
  failovers: number
}

export interface NotFoodResponse {
  notFood: true
  message: string
}

export interface BlockedResponse {
  blocked: true
  message: string
  helpline?: { label: string; number: string }
}

export interface Answer {
  itemId: string
  kind: Question['kind']
  answer: string
  units?: number
  cookingFat?: 'none' | 'oil' | 'ghee' | 'butter'
  cookingFatTsp?: number
}

export interface CommitResponse {
  mealId: string
  totals: { kcal: number; proteinG: number; carbG: number; fatG: number }
  confidence: Confidence
  questionsAsked: number
  streakDays?: number
}

export interface ChatResponse {
  reply: string
  understood: Array<{ kind: string; verbatim: string; value: number | null; unit: string | null }>
  mentionsFood: boolean
  notice?: string
}

export interface DaySummary {
  date: string
  targets: Targets | null
  totals: { kcal: number; proteinG: number; carbG: number; fatG: number }
  proteinLeftG: number
  proteinPct: number
  caloriesLeft: number
  confidence: Confidence
  mealCount: number
  meals: Array<{
    id: string
    mealType: string | null
    eatenAt: string
    kcal: number
    proteinG: number
    confidence: Confidence
    source: string
    questionsAsked: number
    items: Array<{
      /** Needed to correct it. Without this the write path is unreachable. */
      id: string
      units: number
      name: string
      portionLabel: string
      kcal: number
      proteinG: number
      confidence: Confidence
    }>
  }>
  questionsPerMeal: number
}

export interface Usual {
  sourceMealId: string
  label: string
  kcal: number
  proteinG: number
  timesEaten: number
  lastEatenAt: string
  mealType: string | null
  itemCount: number
}

export interface ProactiveMessage {
  kind: string
  text: string
  factId?: string
}

export interface StreakState {
  currentDays: number
  longestDays: number
  freezesAvailable: number
  loggedToday: boolean
}

export interface MarkerSeries {
  code: string
  name: string
  unit: string
  points: Array<{
    value: number
    flag: 'low' | 'normal' | 'high' | 'unknown'
    refLow: number | null
    refHigh: number | null
    measuredAt: string
  }>
}

export interface ReportResult {
  reportId: string
  status: 'ready' | 'failed'
  labName?: string | null
  summary?: string
  message?: string
  disclaimer?: string
  markers?: Array<{
    code: string
    name: string
    value: number
    unit: string
    refLow: number | null
    refHigh: number | null
    flag: 'low' | 'normal' | 'high' | 'unknown'
  }>
}

export interface Me {
  user: {
    id: string
    phone: string | null
    displayName: string | null
    sex: 'male' | 'female' | null
    ageYears: number | null
    heightCm: number | null
    goal: string | null
    diet: string | null
    cooks: string | null
    tone: string
  }
  onboarded: boolean
}

export interface ProofReceipt {
  task: string
  model: string
  attestation: 'verified' | 'failed' | 'unrequested' | 'unavailable'
  provider: string | null
  requestId: string | null
  createdAt: string
  explorer: string | null
}

// ---------------------------------------------------------------- transport

const BASE = '/api'
const TOKEN_KEY = 'ogt.token'
/**
 * Minutes east of UTC, read at the moment it is needed.
 *
 * This was captured once when the module loaded, which is fine for a page
 * reloaded every visit and wrong for an installed app. A PWA resumed from the
 * background lives for days, and somebody who flies with it keeps sending the
 * offset of the country they left — so a meal eaten on Tuesday morning is filed
 * against Monday, and the day's totals they are shown are somebody else's day.
 *
 * The same shape of mistake as reading a timezone once on the server: it looks
 * right, and it quietly puts a meal in the wrong day.
 */
function utcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

export class ApiError extends Error {
  readonly status: number
  /** The server's machine-readable code, when it sent one. */
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  /**
   * Something worth showing a person, or null.
   *
   * Only messages the server wrote for a human are returned. A 500 says
   * nothing — deliberately, since its message can carry internals — and the
   * caller supplies its own wording rather than showing "internal_error".
   */
  get userMessage(): string | null {
    return this.status >= 400 && this.status < 500 && this.humanMessage
      ? this.humanMessage
      : null
  }

  humanMessage: string | null = null
}

/** Fired when the server says the session is gone, so the shell reacts once. */
export const SESSION_EXPIRED = 'ogt:session-expired'

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    // Private mode or blocked storage. The httpOnly cookie still carries the
    // session, so this is degraded rather than broken.
    return null
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // See above — the cookie is the primary carrier.
  }
}

/**
 * Empty the service worker's cache of read responses.
 *
 * The cache is keyed by URL, and every person reads the same paths — so a
 * response cached for one is a response that can be served to the next. On a
 * shared phone, which is the ordinary case in this market, that is one person's
 * health record answering another person's request whenever the network is slow
 * enough for the cache to win.
 *
 * Expiry alone does not solve it: the window is a day, and a phone can change
 * hands in a minute. So it is emptied whenever a session ends, by any route.
 *
 * Best effort by design. A browser with no Cache Storage, or one that refuses,
 * must not stop somebody signing out.
 */
export async function clearCachedReads(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.includes('api')).map((name) => caches.delete(name)))
  } catch {
    // Nothing useful to do. The token is gone either way.
  }
}

const USER_KEY = 'ogt.user'

/** Remember who is signed in, so queued work can be attributed to them. */
export function storeUserId(userId: string): void {
  try {
    localStorage.setItem(USER_KEY, userId)
  } catch {
    // Without this, queued meals cannot be attributed and will not be sent.
    // Losing them is the correct failure: sending them to whoever is next is not.
  }
}

export function readUserId(): string | null {
  try {
    return localStorage.getItem(USER_KEY)
  } catch {
    return null
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
    // The queue is deliberately left alone: those meals still belong to the
    // person who logged them, and they send when that person signs back in.
    localStorage.removeItem(USER_KEY)
  } catch {
    // Nothing useful to do here.
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readToken()

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    // Send the session cookie; the bearer header is the fallback for clients
    // where a cookie is unavailable.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })

  if (response.status === 401) {
    clearToken()
    // The session is over, so the cached answers belong to nobody now.
    void clearCachedReads()
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED))
    throw new ApiError('Your session has ended. Please sign in again.', 401)
  }

  if (!response.ok) {
    // Parsed rather than kept as text. The body is JSON, and passing it through
    // raw meant `error.message` was a JSON document — one careless render away
    // from showing somebody `{"error":"rate_limited",...}` on screen.
    const raw = await response.text().catch(() => '')
    let code: string | null = null
    let human: string | null = null

    try {
      const parsed = JSON.parse(raw) as { error?: string; message?: string }
      code = parsed.error ?? null
      human = parsed.message ?? null
    } catch {
      // Not JSON — a proxy error page, most likely. Nothing to show a person.
    }

    const error = new ApiError(human ?? code ?? response.statusText, response.status, code)
    error.humanMessage = human
    throw error
  }

  return (await response.json()) as T
}

export function isBlocked(value: unknown): value is BlockedResponse {
  return typeof value === 'object' && value !== null && 'blocked' in value
}

export function isNotFood(value: unknown): value is NotFoodResponse {
  return typeof value === 'object' && value !== null && 'notFood' in value
}

// --------------------------------------------------------------------- api

export const api = {
  // ---- auth ----

  requestCode(phone: string) {
    return request<{ sent: true; expiresInSeconds: number; devCode?: string }>(
      '/auth/request-code',
      { method: 'POST', body: JSON.stringify({ phone }) },
    )
  },

  async verifyCode(phone: string, code: string) {
    const result = await request<{ token: string; expiresAt: string; isNewUser: boolean }>(
      '/auth/verify',
      { method: 'POST', body: JSON.stringify({ phone, code }) },
    )
    storeToken(result.token)
    return result
  },

  me() {
    return request<Me>('/auth/me')
  },

  async signOut() {
    try {
      await request<{ signedOut: true }>('/auth/signout', { method: 'POST' })
    } finally {
      clearToken()
      // Before the next person signs in on this device.
      await clearCachedReads()
    }
  },

  // ---- profile ----

  /**
   * Fill in the profile of the signed-in user. Not a create — the user row
   * already exists from sign-in, so identity is never a body field.
   */
  createProfile(body: Record<string, unknown>) {
    return request<{ userId: string; targets: Targets; notes: string[] } | BlockedResponse>(
      '/users/me/profile',
      { method: 'POST', body: JSON.stringify(body) },
    )
  },

  logWeight(weightKg: number) {
    return request<{ ok: true }>('/users/me/weight', {
      method: 'POST',
      body: JSON.stringify({ weightKg }),
    })
  },

  setTone(tone: 'gentle' | 'straight' | 'blunt') {
    return request<{ tone: string }>('/users/me/tone', {
      method: 'PATCH',
      body: JSON.stringify({ tone }),
    })
  },

  askMeLess() {
    return request<{ proactiveOptOut: true }>('/users/me/ask-me-less', { method: 'POST' })
  },

  // ---- the day ----

  today() {
    return request<DaySummary>(`/users/me/today?utcOffsetMinutes=${utcOffsetMinutes()}`)
  },

  usuals() {
    return request<{ usuals: Usual[] }>('/users/me/usuals')
  },

  repeatMeal(sourceMealId: string, idempotencyKey = crypto.randomUUID()) {
    return request<CommitResponse>('/meals/repeat', {
      method: 'POST',
      body: JSON.stringify({ sourceMealId }),
      headers: { 'Idempotency-Key': idempotencyKey },
    })
  },

  // ---- logging ----

  draftMeal(imageUrl: string, note?: string) {
    return request<DraftResponse | NotFoodResponse | BlockedResponse>('/meals/draft', {
      method: 'POST',
      body: JSON.stringify({ imageUrl, ...(note ? { note } : {}) }),
    })
  },

  draftMealText(text: string) {
    return request<DraftResponse | NotFoodResponse | BlockedResponse>('/meals/draft-text', {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  },

  commitMeal(body: Record<string, unknown>, idempotencyKey = crypto.randomUUID()) {
    return request<CommitResponse>('/meals/commit', {
      method: 'POST',
      body: JSON.stringify(body),
      // Generated per call rather than per retry, so a double tap on a slow
      // connection logs one meal.
      headers: { 'Idempotency-Key': idempotencyKey },
    })
  },

  correctItem(
    mealId: string,
    itemId: string,
    changes: { units?: number; cookingFat?: string; cookingFatTsp?: number; name?: string },
  ) {
    return request<{ totals: DaySummary['totals']; learned: boolean }>(
      `/meals/${mealId}/items/${itemId}`,
      { method: 'PATCH', body: JSON.stringify(changes) },
    )
  },

  // ---- coach ----

  chat(message: string) {
    return request<ChatResponse | BlockedResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    })
  },

  history() {
    return request<{ messages: Array<{ role: string; content: string; createdAt: string }> }>(
      '/chat/history',
    )
  },

  suggest(available?: string) {
    return request<{ suggestion: string; proteinLeftG: number } | BlockedResponse>(
      '/users/me/suggest',
      { method: 'POST', body: JSON.stringify({ available, utcOffsetMinutes: utcOffsetMinutes() }) },
    )
  },

  dayLine() {
    return request<{ line: string; streak: StreakState }>(
      `/users/me/day-line?utcOffsetMinutes=${utcOffsetMinutes()}`,
    )
  },

  weekly() {
    return request<{ review: string | null; message?: string; facts: unknown }>(
      `/users/me/weekly?utcOffsetMinutes=${utcOffsetMinutes()}`,
    )
  },

  ask(question: string, days = 14) {
    return request<{ answer: string; notice?: string } | BlockedResponse>('/users/me/ask', {
      method: 'POST',
      body: JSON.stringify({ question, days, utcOffsetMinutes: utcOffsetMinutes() }),
    })
  },

  streak() {
    return request<StreakState>(`/users/me/streak?utcOffsetMinutes=${utcOffsetMinutes()}`)
  },

  proactive() {
    return request<{ message: ProactiveMessage | null }>(
      `/users/me/proactive?utcOffsetMinutes=${utcOffsetMinutes()}`,
    )
  },

  resolveFact(factId: string) {
    return request<{ resolved: true }>(`/users/me/facts/${factId}/resolve`, { method: 'POST' })
  },

  // ---- reports ----

  uploadReport(imageUrl: string) {
    return request<ReportResult>('/users/me/reports', {
      method: 'POST',
      body: JSON.stringify({ imageUrl }),
    })
  },

  markers(code?: string) {
    return request<{ series: MarkerSeries[] }>(
      `/users/me/markers${code ? `?code=${encodeURIComponent(code)}` : ''}`,
    )
  },

  setPantry(items: string[]) {
    return request<{ items: string[] } | BlockedResponse>('/users/me/pantry', {
      method: 'PUT',
      body: JSON.stringify({ items }),
    })
  },

  // ---- proof ----

  /** The receipts. What ran where, and whether the enclave signature verified. */
  proof() {
    return request<{ total: number; verified: number; summary: string; receipts: ProofReceipt[] }>(
      '/users/me/proof',
    )
  },

  exportUrl() {
    return `${BASE}/users/me/export`
  },

  /**
   * The export that also carries the key.
   *
   * Separate from the plain one deliberately — see the note on the button. A
   * health record and a credential should not come out of the same click.
   */
  exportWithKeyUrl() {
    return `${BASE}/users/me/export?includeRecordKey=true`
  },
}

// ------------------------------------------------------------ offline queue

const QUEUE_KEY = 'ogt.queue.v1'

interface QueuedRequest {
  id: string
  path: string
  body: string
  queuedAt: number
  /**
   * Who logged this meal.
   *
   * Absent in queues written before this existed, and those cannot be sent to
   * anybody: the whole point is that we no longer know whose they are.
   */
  userId?: string
}

function readQueue(): QueuedRequest[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as QueuedRequest[]) : []
  } catch {
    return []
  }
}

function writeQueue(queue: QueuedRequest[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch {
    // Losing the queue is bad, but throwing here would lose the meal in front
    // of the person as well.
  }
}

export function enqueue(path: string, body: unknown): void {
  const queue = readQueue()
  queue.push({
    id: crypto.randomUUID(),
    path,
    body: JSON.stringify(body),
    queuedAt: Date.now(),
    // Stamped at the moment it is queued, because by the time it is sent the
    // person at the phone may not be the person who ate the meal.
    ...(readUserId() ? { userId: readUserId()! } : {}),
  })
  writeQueue(queue)
}

/** How many of *this* person's meals are still waiting. */
export function queueLength(): number {
  const owner = readUserId()
  return readQueue().filter((entry) => entry.userId !== undefined && entry.userId === owner).length
}

/**
 * Replay queued writes, in order.
 *
 * Ordering matters: meals must land in the order they were eaten or a day's
 * totals reconstruct wrongly. So a transient failure stops the drain rather
 * than skipping ahead.
 */
export async function flushQueue(): Promise<{ sent: number; remaining: number }> {
  const owner = readUserId()

  /*
   * Only this person's meals.
   *
   * The queue lives in local storage and used to survive a sign-out untouched,
   * so on a shared phone the next person to sign in flushed the previous
   * person's meals into their own account. They lost the record and somebody
   * else gained a day of food they never ate.
   *
   * Entries belonging to somebody else are left exactly where they are, so
   * they still send when that person signs back in. Entries with no owner at
   * all predate this and cannot be attributed to anyone, so they are dropped
   * rather than guessed at.
   */
  const all = readQueue()
  const mine = all.filter((entry) => entry.userId !== undefined && entry.userId === owner)
  const theirs = all.filter((entry) => entry.userId !== undefined && entry.userId !== owner)

  if (mine.length + theirs.length !== all.length) {
    writeQueue([...mine, ...theirs])
  }

  let queue = mine
  let sent = 0

  while (queue.length > 0) {
    const next = queue[0]!
    try {
      await request(next.path, {
        method: 'POST',
        body: next.body,
        // The queued id is a natural idempotency key: it was generated once,
        // when the meal was logged, and never changes across replays. This is
        // what makes a lost response harmless rather than a duplicate dinner.
        headers: { 'Idempotency-Key': next.id },
      })
      queue = queue.slice(1)
      writeQueue([...queue, ...theirs])
      sent += 1
    } catch (error) {
      // A rejected write will never succeed on retry, so drop it rather than
      // blocking every later meal behind it forever. 401 is excluded — that one
      // resolves the moment they sign back in.
      const rejected =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401 &&
        error.status !== 429 &&
        // 409 means an identical replay is still being processed. Dropping it
        // would discard a meal whose write may not have finished.
        error.status !== 409
      if (rejected) {
        queue = queue.slice(1)
        writeQueue([...queue, ...theirs])
        continue
      }
      break
    }
  }

  return { sent, remaining: queue.length }
}
