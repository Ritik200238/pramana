/**
 * API client with an offline queue.
 *
 * A dropped meal log is a dropped habit. Indian mobile networks are not
 * reliable, so a log taken offline is queued and replayed rather than lost —
 * the user should never be told "try again" for something they already did.
 */

export interface Targets {
  bmr: number
  tdee: number
  calories: number
  proteinG: number
  fatG: number
  carbG: number
  safetyNotes: string[]
}

export type Confidence = 'exact' | 'confirmed' | 'rough'

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
}

export interface ChatResponse {
  reply: string
  understood: Array<{ kind: string; verbatim: string; value: number | null; unit: string | null }>
  mentionsFood: boolean
  notice?: string
}

const BASE = '/api'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new ApiError(detail || response.statusText, response.status)
  }

  return (await response.json()) as T
}

export function isBlocked(value: unknown): value is BlockedResponse {
  return typeof value === 'object' && value !== null && 'blocked' in value
}

export function isNotFood(value: unknown): value is NotFoodResponse {
  return typeof value === 'object' && value !== null && 'notFood' in value
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
    items: Array<{ name: string; portionLabel: string; kcal: number; proteinG: number; confidence: Confidence }>
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

const OFFSET = -new Date().getTimezoneOffset()

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

export const api = {
  suggest(userId: string, available?: string) {
    return request<{ suggestion: string; proteinLeftG: number } | BlockedResponse>(
      `/users/${userId}/suggest`,
      {
        method: 'POST',
        body: JSON.stringify({ available, utcOffsetMinutes: OFFSET }),
      },
    )
  },

  dayLine(userId: string) {
    return request<{ line: string; streak: StreakState }>(
      `/users/${userId}/day-line?utcOffsetMinutes=${OFFSET}`,
    )
  },

  weekly(userId: string) {
    return request<{ review: string | null; message?: string; facts: unknown }>(
      `/users/${userId}/weekly?utcOffsetMinutes=${OFFSET}`,
    )
  },

  ask(userId: string, question: string, days = 14) {
    return request<{ answer: string; notice?: string } | BlockedResponse>(
      `/users/${userId}/ask`,
      {
        method: 'POST',
        body: JSON.stringify({ question, days, utcOffsetMinutes: OFFSET }),
      },
    )
  },

  streak(userId: string) {
    return request<StreakState>(`/users/${userId}/streak?utcOffsetMinutes=${OFFSET}`)
  },

  uploadReport(userId: string, imageUrl: string) {
    return request<ReportResult>(`/users/${userId}/reports`, {
      method: 'POST',
      body: JSON.stringify({ imageUrl }),
    })
  },

  markers(userId: string, code?: string) {
    return request<{ series: MarkerSeries[] }>(
      `/users/${userId}/markers${code ? `?code=${encodeURIComponent(code)}` : ''}`,
    )
  },

  setPantry(userId: string, items: string[]) {
    return request<{ items: string[] } | BlockedResponse>(`/users/${userId}/pantry`, {
      method: 'PUT',
      body: JSON.stringify({ items }),
    })
  },

  today(userId: string) {
    return request<DaySummary>(`/users/${userId}/today?utcOffsetMinutes=${OFFSET}`)
  },

  usuals(userId: string) {
    return request<{ usuals: Usual[] }>(`/users/${userId}/usuals`)
  },

  repeatMeal(userId: string, sourceMealId: string) {
    return request<{ mealId: string; kcal: number; proteinG: number; confidence: Confidence }>(
      '/meals/repeat',
      { method: 'POST', body: JSON.stringify({ userId, sourceMealId }) },
    )
  },

  draftMealText(userId: string, text: string) {
    return request<DraftResponse | NotFoodResponse | BlockedResponse>('/meals/draft-text', {
      method: 'POST',
      body: JSON.stringify({ userId, text }),
    })
  },

  proactive(userId: string) {
    return request<{ message: ProactiveMessage | null }>(
      `/users/${userId}/proactive?utcOffsetMinutes=${OFFSET}`,
    )
  },

  resolveFact(userId: string, factId: string) {
    return request<{ resolved: true }>(`/users/${userId}/facts/${factId}/resolve`, {
      method: 'POST',
    })
  },

  createUser(body: Record<string, unknown>) {
    return request<{ userId: string; targets: Targets; notes: string[] } | BlockedResponse>(
      '/users',
      { method: 'POST', body: JSON.stringify(body) },
    )
  },

  targets(userId: string) {
    return request<{ targets: Targets; notes: string[] }>(`/users/${userId}/targets`)
  },

  draftMeal(userId: string, imageUrl: string, note?: string) {
    return request<DraftResponse | NotFoodResponse | BlockedResponse>('/meals/draft', {
      method: 'POST',
      body: JSON.stringify({ userId, imageUrl, ...(note ? { note } : {}) }),
    })
  },

  commitMeal(body: Record<string, unknown>) {
    return request<CommitResponse>('/meals/commit', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  chat(userId: string, message: string) {
    return request<ChatResponse | BlockedResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify({ userId, message }),
    })
  },

  history(userId: string) {
    return request<{ messages: Array<{ role: string; content: string; createdAt: string }> }>(
      `/chat/history?userId=${userId}`,
    )
  },

  logWeight(userId: string, weightKg: number) {
    return request<{ ok: true }>(`/users/${userId}/weight`, {
      method: 'POST',
      body: JSON.stringify({ weightKg }),
    })
  },

  exportUrl(userId: string) {
    return `${BASE}/users/${userId}/export`
  },
}

// ------------------------------------------------------------ offline queue

const QUEUE_KEY = 'ogt.queue.v1'

interface QueuedRequest {
  id: string
  path: string
  body: string
  queuedAt: number
}

function readQueue(): QueuedRequest[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as QueuedRequest[]) : []
  } catch {
    // A corrupt or unavailable store must not break logging.
    return []
  }
}

function writeQueue(queue: QueuedRequest[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch {
    // Private mode, quota, or blocked storage. Losing the queue is bad but
    // throwing here would lose the meal in front of the user as well.
  }
}

export function enqueue(path: string, body: unknown): void {
  const queue = readQueue()
  queue.push({
    id: crypto.randomUUID(),
    path,
    body: JSON.stringify(body),
    queuedAt: Date.now(),
  })
  writeQueue(queue)
}

export function queueLength(): number {
  return readQueue().length
}

/**
 * Replay queued writes. Called on reconnect and at startup.
 * Stops at the first failure so ordering is preserved — meals must land in the
 * order they were eaten.
 */
export async function flushQueue(): Promise<{ sent: number; remaining: number }> {
  let queue = readQueue()
  let sent = 0

  while (queue.length > 0) {
    const next = queue[0]!
    try {
      await request(next.path, { method: 'POST', body: next.body })
      queue = queue.slice(1)
      writeQueue(queue)
      sent += 1
    } catch {
      break
    }
  }

  return { sent, remaining: queue.length }
}
