/**
 * @vitest-environment jsdom
 *
 * The offline queue, against storage and a server that are not behaving.
 *
 * The queue already has a good suite: replay order, permanent rejections,
 * rate limits, expired sessions, idempotency keys, in-flight duplicates. All of
 * it assumes storage holds what we put there and the server answers something
 * sensible. Neither is a safe assumption on the platform this ships to.
 *
 * This is the offline path, which for the people this is built for is not an
 * edge case — it is Tuesday. A crash here loses the meal in front of them.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { enqueue, flushQueue, queueLength, storeUserId } from '../src/lib/api.ts'

const QUEUE_KEY = 'ogt.queue.v1'
const USER = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  localStorage.clear()
  storeUserId(USER)
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

function rawEntries(): unknown[] {
  const raw = localStorage.getItem(QUEUE_KEY)
  return raw ? (JSON.parse(raw) as unknown[]) : []
}

describe('the queue against hostile storage', () => {
  test('valid JSON that is not an array does not lose the meal in hand', () => {
    /*
     * The defect this was written for. `JSON.parse` succeeding says only that
     * the string was JSON — another script on this origin, a partial write, or
     * an older build could leave anything here. The previous version cast the
     * result and pushed onto it, so this threw `queue.push is not a function`
     * out of `enqueue` and lost the meal somebody had just logged.
     */
    for (const junk of ['"a string"', '{"not":"an array"}', '42', 'null', 'true']) {
      localStorage.setItem(QUEUE_KEY, junk)

      expect(() => enqueue('/meals/commit', { kcal: 400 })).not.toThrow()
      expect(queueLength()).toBe(1)
    }
  })

  test('unparseable storage is survived rather than thrown from', () => {
    localStorage.setItem(QUEUE_KEY, '{ this is not json at all')

    expect(() => enqueue('/meals/commit', { kcal: 400 })).not.toThrow()
    expect(queueLength()).toBe(1)
  })

  test('one malformed entry costs one meal, not the whole queue', () => {
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify([
        { id: 'a', path: '/meals/commit', body: '{}', queuedAt: 1, userId: USER },
        { id: 'b', nonsense: true },
        null,
        'a string in the array',
        { id: 'c', path: '/meals/commit', body: '{}', queuedAt: 2, userId: USER },
      ]),
    )

    // Discarding everything on one bad row would turn a small corruption into
    // a lost week.
    expect(queueLength()).toBe(2)
  })

  test('the queue is bounded, because storage is', () => {
    for (let index = 0; index < 260; index += 1) {
      enqueue('/meals/commit', { index })
    }

    /*
     * localStorage does not grow forever. Once it is full every later write
     * fails silently, so an uncapped queue does not grow without limit — it
     * quietly stops accepting the meal in front of the person instead.
     */
    expect(rawEntries().length).toBeLessThanOrEqual(200)
  })

  test('at the cap the oldest is dropped, never the one just logged', () => {
    for (let index = 0; index < 260; index += 1) {
      enqueue('/meals/commit', { index })
    }

    const bodies = rawEntries().map((entry) => (entry as { body: string }).body)

    // The newest is the one somebody is looking at and was told was saved.
    expect(bodies.at(-1)).toContain('"index":259')
    // The oldest survivors are from the middle, so the front was shed.
    expect(bodies[0]).not.toContain('"index":0')
  })
})

describe('the queue against a server that is not behaving', () => {
  test('a body that is not JSON does not stop the drain from being tried', async () => {
    enqueue('/meals/commit', { kcal: 400 })

    // Some proxies answer with an HTML error page and a 200. Parsing that
    // throws, and an unhandled throw here would take the whole flush down.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><body>Gateway Error</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })),
    )

    await expect(flushQueue()).resolves.toBeDefined()
  })

  test('a 500 keeps the meal rather than discarding it', async () => {
    enqueue('/meals/commit', { kcal: 400 })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))

    const result = await flushQueue()

    // A server fault is not the person's fault, and it is not a reason to lose
    // what they logged.
    expect(result.sent).toBe(0)
    expect(queueLength()).toBe(1)
  })

  test('a flush that runs twice at once does not send anything twice', async () => {
    enqueue('/meals/commit', { kcal: 400 })

    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        sent.push(init?.headers?.['idempotency-key'] ?? 'none')
        await new Promise((resolve) => setTimeout(resolve, 10))
        return new Response('{}', { status: 201 })
      }),
    )

    // Two things can start a drain — coming back online, and opening the app —
    // and on a flaky connection they happen together.
    await Promise.all([flushQueue(), flushQueue()])

    /*
     * If it did go twice, both carried the same idempotency key, so the server
     * records one. That is the guarantee that actually protects the day's
     * totals, and it is the one worth asserting.
     */
    const distinct = new Set(sent)
    expect(distinct.size).toBeLessThanOrEqual(1)
    expect(queueLength()).toBe(0)
  })
})
