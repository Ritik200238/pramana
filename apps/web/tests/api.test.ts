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
function scriptFetch(statuses: number[], bodies?: string[]) {
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
      text: async () => bodies?.shift() ?? '',
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
  // Somebody is signed in before they can log a meal, and queued work is
  // attributed to them. Without this every entry is unattributable and is
  // deliberately never sent.
  api.storeUserId('user-a')
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

  test('a replay carries the queued id as its idempotency key', async () => {
    api.enqueue('/meals/commit', { meal: 'dinner' })

    const calls = scriptFetch([200])
    await api.flushQueue()

    // The id was generated once, when the meal was logged, and does not change
    // across replays — which is exactly what makes a lost response harmless
    // instead of a duplicate dinner.
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('the same key is reused when a replay is retried', async () => {
    api.enqueue('/meals/commit', { meal: 'dinner' })

    const first = scriptFetch([503])
    await api.flushQueue()
    const second = scriptFetch([200])
    await api.flushQueue()

    const keyOf = (c: { init: RequestInit }) =>
      (c.init.headers as Record<string, string>)['Idempotency-Key']
    // A new key on retry would defeat the whole mechanism.
    expect(keyOf(second[0]!)).toBe(keyOf(first[0]!))
  })

  test('an in-flight duplicate is kept, not dropped', async () => {
    api.enqueue('/meals/commit', { meal: 'dinner' })

    // 409 says an identical replay is still being processed. Dropping it would
    // discard a meal whose write may not have finished.
    scriptFetch([409])
    expect(await api.flushQueue()).toEqual({ sent: 0, remaining: 1 })
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

describe('error reporting', () => {
  test('a server message is parsed, not handed over as raw JSON', async () => {
    scriptFetch(
      [429],
      ['{"error":"rate_limited","message":"A lot of questions in a short time."}'],
    )

    await expect(api.api.today()).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    })
  })

  test('a client error offers its message to the UI', async () => {
    scriptFetch([429], ['{"error":"rate_limited","message":"Give it a moment."}'])

    try {
      await api.api.today()
      expect.unreachable()
    } catch (error) {
      expect((error as InstanceType<typeof api.ApiError>).userMessage).toBe('Give it a moment.')
    }
  })

  test('a server fault offers nothing, because its message may carry internals', async () => {
    scriptFetch([500], ['{"error":"internal_error"}'])

    try {
      await api.api.today()
      expect.unreachable()
    } catch (error) {
      // The caller supplies its own wording rather than showing "internal_error".
      expect((error as InstanceType<typeof api.ApiError>).userMessage).toBeNull()
    }
  })

  test('a non-JSON body does not become the message', async () => {
    scriptFetch([502], ['<html>Bad Gateway</html>'])

    try {
      await api.api.today()
      expect.unreachable()
    } catch (error) {
      // A proxy error page is not something to show a person.
      expect((error as InstanceType<typeof api.ApiError>).userMessage).toBeNull()
    }
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

// ------------------------------------------------------------- reachability

describe('every built feature has a way in', () => {
  /*
   * The bug this guards is one the repository kept producing: something built,
   * tested and shipped in the API that no screen ever calls. A sweep found
   * twelve at once — including no way to sign out, no way to see the
   * attestation receipts the privacy claim rests on, and no way to export the
   * data we promise is yours.
   *
   * None of it failed a test, because everything each piece did in isolation
   * was correct. Reachability is only visible from the outside.
   */
  test('the client methods that carry a promise are called by a screen', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')

    const roots = ['src/screens', 'src/components']
    let ui = ''
    for (const root of roots) {
      for (const file of readdirSync(root)) {
        if (file.endsWith('.tsx')) ui += readFileSync(join(root, file), 'utf8')
      }
    }

    // Each of these is a sentence the product says out loud somewhere.
    const promises = {
      'signOut': 'somebody on a shared phone must be able to sign out',
      'proof': 'the privacy claim must be checkable by the person it is made to',
      'exportUrl': '"export everything, free, forever" needs a button',
      'correctItem': 'corrections are the moat; without them nothing is learned',
      'setTone': 'the bluntness of the coach is advertised as adjustable',
      'askMeLess': 'one tap, obeyed permanently — it has to exist to be tapped',
    }

    const flat = ui.replace(/\s+/g, '')

    const unreachable = Object.entries(promises)
      // Prefixed with `api.` deliberately: matching the bare name passes on a
      // local helper that merely shares it, which is how this test first passed
      // while the feature it guards was gone. Whitespace is stripped first
      // because a chained call spread over lines is still a call.
      .filter(([method]) => !flat.includes(`api.${method}(`))
      .map(([method, why]) => `${method}: ${why}`)

    expect(unreachable).toEqual([])
  })
})

describe('shared shapes are not copied', () => {
  test('Targets and Confidence come from the package that owns them', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/lib/api.ts', 'utf8')

    /*
     * These were restated here, which made them a copy of a definition that
     * lives elsewhere. Every hand-maintained copy in this repository has
     * drifted from its original — prices from the catalogue, capabilities from
     * the model list, a table list from the schema — and none of those failed a
     * test, because the test mirrored the copy.
     *
     * Imported as types only, so nothing from the package reaches the bundle.
     * The build is byte-identical either way.
     */
    expect(source).toMatch(/import type \{[^}]*Targets[^}]*\} from '@ogt\/core'/)
    expect(source).not.toMatch(/export interface Targets \{/)
    expect(source).not.toMatch(/export type Confidence =/)
  })
})

describe('a device that changes hands', () => {
  /*
   * The service worker caches read responses for a day, keyed by URL. Every
   * person reads the same paths, so a response cached for one is a response
   * that can be served to the next — and on a shared phone, which is the
   * ordinary case in this market, that is one person's health record answering
   * somebody else's request whenever the network is slow enough for the cache
   * to win.
   *
   * Expiry does not help: the window is a day and a phone changes hands in a
   * minute. The cache has to be emptied when a session ends.
   */
  function fakeCaches() {
    const deleted: string[] = []
    vi.stubGlobal('caches', {
      keys: async () => ['api-reads', 'workbox-precache-v2', 'other'],
      delete: async (name: string) => {
        deleted.push(name)
        return true
      },
    })
    return deleted
  }

  test('signing out empties the cached reads', async () => {
    const deleted = fakeCaches()
    scriptFetch([200])

    await api.api.signOut()

    expect(deleted).toContain('api-reads')
  })

  test('a sign-out that fails still empties them', async () => {
    const deleted = fakeCaches()
    scriptFetch([500])

    // A failed sign-out leaving one person's data readable by the next is the
    // worst outcome here, so the cache goes regardless.
    await expect(api.api.signOut()).rejects.toBeDefined()
    expect(deleted).toContain('api-reads')
  })

  test('an expired session empties them too', async () => {
    const deleted = fakeCaches()
    scriptFetch([401])

    await expect(api.api.today()).rejects.toMatchObject({ status: 401 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(deleted).toContain('api-reads')
  })

  test('the precache is left alone', async () => {
    const deleted = fakeCaches()
    scriptFetch([200])

    await api.api.signOut()

    // Clearing the app shell would make the next launch a blank screen on a bad
    // connection, and it holds nobody's data.
    expect(deleted).not.toContain('workbox-precache-v2')
  })

  test('a browser without Cache Storage still signs out', async () => {
    vi.stubGlobal('caches', undefined)
    scriptFetch([200])

    // Private mode, an old browser, a locked-down profile. None of them may
    // stop somebody signing out.
    await expect(api.api.signOut()).resolves.toBeUndefined()
  })
})

describe('the queue on a shared phone', () => {
  /*
   * The queue lives in local storage and used to survive a sign-out untouched.
   * So on a shared phone the next person to sign in flushed the previous
   * person's meals into their own account: one lost a day of food they had
   * been told was saved, the other gained a day they never ate.
   */
  test('a meal is only ever sent to the person who logged it', async () => {
    api.enqueue('/meals/commit', { meal: 'alice dinner' })

    // Alice signs out, Bob signs in on the same phone.
    api.clearToken()
    api.storeUserId('user-b')

    const calls = scriptFetch([200])
    const result = await api.flushQueue()

    expect(calls).toHaveLength(0)
    expect(result).toEqual({ sent: 0, remaining: 0 })
  })

  test('and it is still there when they sign back in', async () => {
    api.enqueue('/meals/commit', { meal: 'alice dinner' })

    api.clearToken()
    api.storeUserId('user-b')
    await api.flushQueue()

    // Alice returns. Her meal was told to her as saved, so it must still send.
    api.storeUserId('user-a')
    const calls = scriptFetch([200])
    const result = await api.flushQueue()

    expect(result).toEqual({ sent: 1, remaining: 0 })
    expect(JSON.parse(calls[0]!.body as string).meal).toBe('alice dinner')
  })

  test('the count shown is the count of your own meals', async () => {
    api.enqueue('/meals/commit', { meal: 'alice dinner' })
    expect(api.queueLength()).toBe(1)

    api.storeUserId('user-b')
    // Bob has logged nothing. Telling him one meal is waiting to sync would be
    // both wrong and alarming.
    expect(api.queueLength()).toBe(0)
  })

  test('an unattributable meal is dropped rather than given to somebody', async () => {
    // A queue written before entries carried an owner. There is no safe person
    // to send it to.
    storage.setItem(
      'ogt.queue.v1',
      JSON.stringify([{ id: 'old', path: '/meals/commit', body: '{}', queuedAt: 1 }]),
    )

    const calls = scriptFetch([200])
    const result = await api.flushQueue()

    expect(calls).toHaveLength(0)
    expect(result).toEqual({ sent: 0, remaining: 0 })
    expect(api.queueLength()).toBe(0)
  })

  test('one person flushing does not discard another person’s meals', async () => {
    api.enqueue('/meals/commit', { meal: 'alice dinner' })

    api.storeUserId('user-b')
    api.enqueue('/meals/commit', { meal: 'bob lunch' })

    const calls = scriptFetch([200])
    await api.flushQueue()

    // Bob's sent, Alice's untouched.
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]!.body as string).meal).toBe('bob lunch')

    api.storeUserId('user-a')
    expect(api.queueLength()).toBe(1)
  })
})

describe('a phone that travels', () => {
  test('the timezone offset is read per request, not once at startup', async () => {
    const realOffset = Date.prototype.getTimezoneOffset

    try {
      // India.
      Date.prototype.getTimezoneOffset = () => -330
      let calls = scriptFetch([200])
      await api.api.today()
      expect(calls[0]!.path).toContain('utcOffsetMinutes=330')

      /*
       * The same installed app, resumed after a flight. Captured once at module
       * load, this would still say 330 — and a meal eaten on Tuesday morning
       * would be filed against Monday, with a day's totals belonging to
       * somebody else's day.
       */
      Date.prototype.getTimezoneOffset = () => 300
      calls = scriptFetch([200])
      await api.api.today()
      expect(calls[0]!.path).toContain('utcOffsetMinutes=-300')
    } finally {
      Date.prototype.getTimezoneOffset = realOffset
    }
  })

  test('every day-scoped read carries the current offset', async () => {
    const realOffset = Date.prototype.getTimezoneOffset

    try {
      Date.prototype.getTimezoneOffset = () => 0
      for (const call of [api.api.today, api.api.streak, api.api.proactive, api.api.dayLine]) {
        const calls = scriptFetch([200])
        await call()
        // A read that decides which day something belongs to must not use a
        // different clock from its neighbours.
        expect(calls[0]!.path).toContain('utcOffsetMinutes=0')
      }
    } finally {
      Date.prototype.getTimezoneOffset = realOffset
    }
  })
})

describe('the core loop announces itself and does not lose your photo', () => {
  /*
   * The two longest and most fragile moments in the product both happen inside
   * the meal flow: the seconds a vision model takes, and whatever happens if it
   * fails.
   */
  async function mealFlow(): Promise<string> {
    const { readFileSync } = await import('node:fs')
    return readFileSync('src/screens/MealFlow.tsx', 'utf8')
  }

  test('the wait and the result are announced', async () => {
    const source = await mealFlow()

    // Live regions were added for chat and coach and missed here — the primary
    // loop, and the longest wait in the product. Somebody using a screen reader
    // was told nothing between taking a photo and being asked a question.
    const reading = source.slice(source.indexOf("stage.name === 'reading'"))
    expect(reading.slice(0, 260)).toMatch(/role="status"/)

    const result = source.slice(source.indexOf("stage.name === 'result'"))
    expect(result.slice(0, 260)).toMatch(/role="status"/)
  })

  test('a failure retries the request, not the photograph', async () => {
    const source = await mealFlow()

    // Sending somebody back to the camera means re-photographing food they may
    // already be eating, over what was usually a dropped connection.
    expect(source).toMatch(/lastInput/)
    const errorStage = source.slice(source.indexOf("stage.name === 'error'"))
    expect(errorStage.slice(0, 600)).toMatch(/retry\(\)/)

    // And taking a new photo stays available, because sometimes the picture
    // really was the problem.
    expect(errorStage.slice(0, 600)).toMatch(/Take another photo/)
  })

  test('the failure message is written for a person', async () => {
    const source = await mealFlow()

    // error.message is the server's sentence for a 4xx and a bare status line
    // for anything else. Only the first is worth showing.
    expect(source).toMatch(/readableError/)
    expect(source).not.toMatch(/message: error instanceof Error \? error\.message/)
  })
})

describe('every screen that waits or fails says so', () => {
  /*
   * Written after finding the same gap twice.
   *
   * Live regions were added as a category — chat, then the coach panels — and
   * the check was "do live regions exist" rather than "does each journey have
   * one". The meal flow, the longest wait in the product, had none. Onboarding,
   * the first ninety seconds of anybody's use, had a silent failure. Repeating
   * a meal changed the day's totals without a word.
   *
   * A fix applied by category misses the path that matters most, so this asks
   * about paths.
   */
  async function screen(name: string): Promise<string> {
    const { readFileSync } = await import('node:fs')
    return readFileSync(`src/screens/${name}.tsx`, 'utf8')
  }

  const ANNOUNCES = /role="(status|alert)"|aria-live/

  test('a failure is announced on every screen that can fail', async () => {
    for (const name of ['SignIn', 'Onboarding', 'MealFlow', 'Coach', 'Today']) {
      const source = await screen(name)
      // Each of these has a catch block that puts something on screen. A person
      // who cannot see it needs to be told.
      expect(source, `${name} shows failures silently`).toMatch(ANNOUNCES)
    }
  })

  test('a wait that takes seconds is announced', async () => {
    const mealFlow = await screen('MealFlow')
    const reading = mealFlow.slice(mealFlow.indexOf("stage.name === 'reading'"))
    expect(reading.slice(0, 260)).toMatch(ANNOUNCES)
  })

  test('an action that changes the day announces what changed', async () => {
    const today = await screen('Today')

    // One tap logs a whole meal. Hearing nothing afterwards leaves somebody
    // with no way to know whether it worked.
    expect(today).toMatch(ANNOUNCES)

    /*
     * Checked inside the handler, not merely somewhere in the file. The first
     * version of this asserted that the word "announcement" appeared, which the
     * unused state variable satisfied on its own — so deleting the line that
     * actually announces anything left the test green.
     */
    const handler = today.slice(today.indexOf('api.repeatMeal'))
    expect(handler.slice(0, 500)).toMatch(/setAnnouncement\(/)
  })

  test('screens prefer the server’s wording when it has some', async () => {
    // Rate limiting is the common case, and "could not reach the server" is
    // both wrong and unhelpful for it.
    for (const name of ['Coach', 'Chat', 'MealFlow', 'SignIn']) {
      const source = await screen(name)
      expect(source, `${name} invents its own message`).toMatch(/userMessage|readableError/)
    }
  })
})
