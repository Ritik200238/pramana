/**
 * What the app does when the network accepts a request and never answers it.
 *
 * This is not the same failure as being offline, and it is the more common one
 * on a phone: a dead cell at the edge of coverage, a train tunnel, a cafe portal
 * that completes the handshake and then swallows everything. `fetch` has no
 * timeout, so the promise simply never settles.
 *
 * The app already knew what to do about a failed session check — open on the
 * last known session so a meal can still be queued, or fall back to sign-in.
 * None of it ran. Every one of those branches is reached by catching a
 * rejection, and a hang does not reject. The result was a spinner that stayed
 * on screen until the app was closed, which is what a person would call broken.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, isAuthFailure } from '../src/lib/api'

/** A fetch that resolves only when the test says so, or never. */
function hangingFetch() {
  const calls: Array<{ signal: AbortSignal | null }> = []

  const impl = vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal ?? null
    calls.push({ signal })

    return new Promise<Response>((_resolve, reject) => {
      // Exactly what the platform does: an aborted request rejects with this.
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
      })
    })
  })

  vi.stubGlobal('fetch', impl)
  return { calls, impl }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a request that is never answered', () => {
  it('gives up rather than hanging forever', async () => {
    vi.useFakeTimers()
    hangingFetch()

    const pending = api.me()
    // Assert the rejection before advancing, so an unhandled rejection cannot
    // escape between the two.
    const settled = expect(pending).rejects.toBeInstanceOf(ApiError)

    await vi.advanceTimersByTimeAsync(13_000)
    await settled
  })

  it('says something a person can act on, and does not sign them out', async () => {
    vi.useFakeTimers()
    hangingFetch()

    const pending = api.me().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(13_000)
    const error = (await pending) as ApiError

    expect(error.humanMessage).toMatch(/could not reach/i)

    /*
     * The important half. `isAuthFailure` decides between "you are signed out"
     * and "we could not ask", and a timeout is emphatically the second. If a
     * tunnel could sign somebody out, it would take the offline queue with it —
     * along with the meal they were in the middle of logging.
     */
    expect(isAuthFailure(error)).toBe(false)
    expect(error.status).not.toBe(401)
  })

  it('actually passes an abort signal to fetch', async () => {
    vi.useFakeTimers()
    const { calls } = hangingFetch()

    const pending = api.me().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(13_000)
    await pending

    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0]?.signal?.aborted).toBe(true)
  })

  it('does not hold a model call to the same limit as a profile read', async () => {
    /*
     * A meal photo goes to a vision model and is slow on purpose. Timing it out
     * at the speed of an auth check would break the feature this product is
     * built around — a fix for a hang that breaks the main flow is not a fix.
     */
    vi.useFakeTimers()
    hangingFetch()

    let settled = false
    const pending = api.chat('what did I eat').then(
      () => { settled = true },
      () => { settled = true },
    )

    // Well past the fast limit, nowhere near the model one.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(30_000)
    await pending
    expect(settled).toBe(true)
  })
})
