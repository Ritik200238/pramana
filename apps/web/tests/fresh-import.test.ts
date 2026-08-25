/**
 * @vitest-environment jsdom
 *
 * Surviving a deploy that lands while somebody has the app open.
 *
 * The service worker uses `autoUpdate`, and the built worker carries
 * `skipWaiting`, `clientsClaim` and `cleanupOutdatedCaches`. A deploy therefore
 * activates immediately, claims pages that are already open, and deletes the
 * previous precache — while those pages are still running the old JavaScript
 * with content-hashed chunk names.
 *
 * The app has exactly one lazily loaded module, and it is on the custody path.
 * Before this, somebody who left the app open, came back after a deploy, and
 * tapped "take my key" was told "could not create a key on this device". Their
 * device was fine. We had deleted the file while they were reading.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { freshImport, isStaleChunkError } from '../src/lib/fresh-import.ts'

beforeEach(() => {
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

/** How each browser words a chunk that is no longer there. */
const STALE_MESSAGES = [
  'Failed to fetch dynamically imported module: https://app/assets/index-Ab12.js',
  'error loading dynamically imported module',
  'Importing a module script failed.',
  'Expected a JavaScript module script but the server responded with a MIME type of text/html',
]

describe('freshImport', () => {
  test('a module that loads is simply returned', async () => {
    const reload = vi.fn()
    const value = await freshImport(async () => ({ ok: true }), { reload })

    expect(value).toEqual({ ok: true })
    expect(reload).not.toHaveBeenCalled()
  })

  test('every browser wording of a missing chunk is recognised', () => {
    for (const message of STALE_MESSAGES) {
      expect(isStaleChunkError(new Error(message))).toBe(true)
    }
  })

  test('a real bug inside the module is not mistaken for a stale chunk', () => {
    /*
     * Narrow on purpose. A module that throws while evaluating is a defect, and
     * turning it into a silent reload would hide it behind a flicker — the
     * worst possible way to lose a bug report.
     */
    for (const error of [
      new Error('Cannot read properties of undefined'),
      new TypeError('x is not a function'),
      new Error('Network request failed'),
      'a string, not an error',
      null,
    ]) {
      expect(isStaleChunkError(error)).toBe(false)
    }
  })

  test('an ordinary failure is rethrown untouched, with no reload', async () => {
    /*
     * The predicate is tested above, but testing a predicate says nothing about
     * whether the function consults it. Deleting that check passed every test
     * here until this one existed — and a module that throws while evaluating
     * would then have become a silent reload, which is the worst way to lose a
     * bug report.
     */
    const reload = vi.fn()
    const bug = new TypeError('x is not a function')

    const thrown = await freshImport(
      async () => {
        throw bug
      },
      { reload },
    ).catch((error: unknown) => error)

    expect(thrown).toBe(bug)
    expect(reload).not.toHaveBeenCalled()
  })

  test('a missing chunk reloads the page once', async () => {
    const reload = vi.fn()

    const pending = freshImport(
      async () => {
        throw new Error(STALE_MESSAGES[0])
      },
      { reload },
    )

    // Deliberately never settles: the page is going away, and resolving would
    // let the caller render an error for the instant before it does.
    const settled = await Promise.race([
      pending.then(() => 'settled').catch(() => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 20)),
    ])

    expect(reload).toHaveBeenCalledTimes(1)
    expect(settled).toBe('still pending')
  })

  test('it never reloads twice, because a loop is worse than an error', async () => {
    const reload = vi.fn()
    const load = async () => {
      throw new Error(STALE_MESSAGES[0])
    }

    void freshImport(load, { reload })
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Second time in the same tab: the flag is set, so it gives up and lets the
    // caller show something readable instead of spinning.
    await expect(freshImport(load, { reload })).rejects.toThrow(/dynamically imported/i)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('without storage it does not reload at all', async () => {
    const reload = vi.fn()

    /*
     * A private window with site data blocked has nowhere to record that a
     * reload already happened. Losing this recovery there is a far smaller harm
     * than a phone stuck reloading forever.
     */
    const original = new Error(STALE_MESSAGES[0])

    const thrown = await freshImport(
      async () => {
        throw original
      },
      { reload, storage: null },
    ).catch((error: unknown) => error)

    /*
     * The original error, not something thrown on the way out. An earlier
     * version of this test accepted any rejection, so deleting the storage
     * guard passed it — the code then threw a TypeError from `getItem` on null,
     * which rejects just as convincingly and means something completely
     * different.
     */
    expect(thrown).toBe(original)
    expect(reload).not.toHaveBeenCalled()
  })

  test('the one lazy import in the app goes through it', async () => {
    /*
     * The guard that matters. The helper is only useful if the import it exists
     * for actually uses it, and that is a line somebody could reasonably
     * "simplify" back.
     */
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'lib', 'custody.ts'),
      'utf8',
    )

    expect(source).toMatch(/freshImport\(\(\) => import\('ethers'\)\)/)
  })
})
