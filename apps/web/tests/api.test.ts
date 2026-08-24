/**
 * The client's two pieces of real logic: what happens to a request when the
 * session is gone, and what happens to a meal that was logged with no signal.
 *
 * The queue is the part worth testing hardest. "Your meals are saved" is a
 * promise the app makes on screen, and the ways it can quietly become false —
 * an order that reconstructs a day wrongly, one rejected write blocking every
 * good one behind it, a transient failure discarding food someone ate — are
 * not visible in the UI until a user has already lost something.
 *
 * There is no DOM here on purpose. Stubbing three globals tests the logic
 * itself rather than a jsdom emulation of it.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

// --------------------------------------------------------------- fake globals

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
const listeners = new EventTarget()

vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', listeners)

/** A fetch that answers from a queue of scripted statuses, recording calls. */
function scriptFetch(statuses: number[]) {
  const calls: Array<{ path: string; body: unknown; init: RequestInit }> = []
  let index = 0

  const fake = vi.fn(async (path: string, init: RequestInit) => {
    const status = statuses[index++] ?? 200
    calls.push({ path, body: init.body, init })
    return {
      ok: status < 400,
      status,
      statusText: `status ${status}`,
      json: async () => ({ ok: true }),
      text: async () => '',
    } as unknown as Response
  })

  vi.stubGlobal('fetch', fake)
  return calls
}

const api = await import('../src/lib/api.ts')

beforeEach(() => {
  storage.clear()
  vi.unstubAllGlobals()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', listeners)
})

// ---------------------------------------------------------------- the queue

describe('the offline queue', () => {
  test('replays in the order the meals were eaten', async () => {
    api.enqueue('/meals/commit', { meal: 'breakfast' })
    api.enqueue('/meals/commit', { meal: 'lunch' })
    api.enqueue('/meals/commit', { meal: 'dinner' })
    expect(api.queueLength()).toBe(3)

    const calls = scriptFetch([200, 200, 200])
    const result = await api.flushQueue()

    expect(result).toEqual({ sent: 3, remaining: 0 })
    // Order is not cosmetic: a day's totals reconstruct from this sequence.
    expect(calls.map((call) => JSON.parse(call.body as string).meal)).toEqual([
      'breakfast',
      'lunch',
      'dinner',
    ])
  })

  test('a permanently rejected write is dropped so later meals still land', async () => {
    api.enqueue('/meals/commit', { meal: 'malformed' })
    api.enqueue('/meals/commit', { meal: 'good' })

    // 422 will be 422 forever. Retrying it blocks every meal behind it.
    const calls = scriptFetch([422, 200])
    const result = await api.flushQueue()

    expect(result).toEqual({ sent: 1, remaining: 0 })
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1]!.body as string).meal).toBe('good')
  })

  test('a server failure keeps the meal rather than discarding it', async () => {
    api.enqueue('/meals/commit', { meal: 'dinner' })

    scriptFetch([503])
    const result = await api.flushQueue()

    // The server being down is not the user's fault and must not cost them food.
    expect(result).toEqual({ sent: 0, remaining: 1 })
    expect(api.queueLength()).toBe(1)
  })

  test('rate limiting pauses the drain instead of dropping the meal', async () => {
    api.enqueue('/meals/commit', { meal: 'dinner' })

    // 429 is a 4xx that means "later", not "never" — the one exception.
    scriptFetch([429])
    expect(await api.flushQueue()).toEqual({ sent: 0, remaining: 1 })
  })

  test('an expired session pauses the drain and keeps everything', async () => {
    api.enqueue('/meals/commit', { meal: 'breakfast' })
    api.enqueue('/meals/commit', { meal: 'lunch' })

    scriptFetch([401])
    const result = await api.flushQueue()

    // They will sign back in; the meals must still be there when they do.
    expect(result).toEqual({ sent: 0, remaining: 2 })
  })

  test('a network error stops the drain without losing anything', async () => {
    api.enqueue('/meals/commit', { meal: 'dinner' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    expect(await api.flushQueue()).toEqual({ sent: 0, remaining: 1 })
  })
})

// -------------------------------------------------------------- the session

describe('session handling', () => {
  test('a 401 clears the token and announces itself exactly once', async () => {
    api.storeToken('session-token')
    expect(storage.getItem('ogt.token')).toBe('session-token')

    const seen = vi.fn()
    listeners.addEventListener(api.SESSION_EXPIRED, seen)

    scriptFetch([401])
    await expect(api.api.me()).rejects.toMatchObject({ status: 401 })

    expect(storage.getItem('ogt.token')).toBeNull()
    expect(seen).toHaveBeenCalledTimes(1)
    listeners.removeEventListener(api.SESSION_EXPIRED, seen)
  })

  test('every request carries the cookie, and the token when there is one', async () => {
    api.storeToken('session-token')
    const calls = scriptFetch([200])
    await api.api.today()

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(calls[0]!.init.credentials).toBe('include')
    expect(headers.Authorization).toBe('Bearer session-token')
  })

  test('a signed-out client sends no authorization header at all', async () => {
    const calls = scriptFetch([200])
    await api.api.today()

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(calls[0]!.init.credentials).toBe('include')
  })

  test('signing out clears the token even if the server call fails', async () => {
    api.storeToken('session-token')
    scriptFetch([500])

    await expect(api.api.signOut()).rejects.toBeDefined()
    // Otherwise a failed sign-out leaves a live token on a shared phone.
    expect(storage.getItem('ogt.token')).toBeNull()
  })

  test('blocked storage degrades instead of throwing', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
      removeItem() {
        throw new Error('blocked')
      },
    })

    // Private mode must not crash the app; the cookie still carries the session.
    expect(() => api.storeToken('x')).not.toThrow()
    expect(() => api.clearToken()).not.toThrow()
    expect(api.queueLength()).toBe(0)
  })
})

// ------------------------------------------------------------ shape guards

describe('response discrimination', () => {
  test('a blocked response is recognised before its fields are read', () => {
    expect(api.isBlocked({ blocked: true, message: 'x' })).toBe(true)
    expect(api.isBlocked({ totals: {} })).toBe(false)
    expect(api.isBlocked(null)).toBe(false)
  })

  test('a not-food response is recognised', () => {
    expect(api.isNotFood({ notFood: true, message: 'x' })).toBe(true)
    expect(api.isNotFood({ vision: {} })).toBe(false)
  })
})
