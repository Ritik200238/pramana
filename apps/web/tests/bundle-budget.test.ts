/**
 * What a first visit actually costs somebody.
 *
 * This is an India-first product on mid-range Android over metered data, so the
 * first load is not a vanity metric — it is money, and it is the difference
 * between opening the app on a train and giving up on it.
 *
 * The measurement that matters is what the service worker precaches, not what
 * the bundler prints. Precaching downloads every chunk it lists on the first
 * visit, so a chunk being lazily imported saves nothing if it is precached
 * anyway: the import defers parsing and the bytes arrive regardless.
 *
 * That is exactly what was happening. `custody.ts` imports ethers dynamically,
 * with a comment explaining that people who never take their own key should not
 * pay for it — and the precache pulled all 140 KB of it down for everybody,
 * making the comment false and the effort pointless.
 *
 *   before   14 entries, 643.6 KiB precached, ~220 KB gzipped first load
 *   after    13 entries, 270.8 KiB precached,   80 KB gzipped first load
 *
 * Skips loudly without a build rather than passing, because a budget test that
 * quietly measures nothing is worse than no budget at all.
 */

import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const DIST = join(import.meta.dirname, '..', 'dist')
const SW = join(DIST, 'sw.js')

/**
 * The ceiling for a first visit, gzipped, across everything the worker fetches
 * before the app is usable.
 *
 * Set a little above where it stands so ordinary work does not trip it, and
 * close enough that adding a large dependency does. It is meant to start a
 * conversation, not to be raised silently — raising it is the decision.
 */
const FIRST_LOAD_BUDGET_KB = 110

const built = existsSync(SW)

describe.skipIf(!built)('what a first visit costs', () => {
  /** Every asset the service worker precaches. */
  function precached(): string[] {
    const sw = readFileSync(SW, 'utf8')
    return [...new Set(Array.from(sw.matchAll(/"([^"]+\.(?:js|css|html|svg|png|woff2))"/g), (m) => m[1]!))]
  }

  test('the wallet library is not downloaded by people who never use it', () => {
    /*
     * The whole point of the dynamic import. If ethers is in this list, the
     * import is decoration: everybody pays for it on their first visit and only
     * the parsing is deferred.
     */
    const ethers = precached().filter((asset) => asset.includes('ethers'))
    expect(ethers).toEqual([])
  })

  test('the wallet chunk still exists, so custody is not broken', () => {
    // Excluded from the precache, not from the build. Somebody who does take
    // their key must still be able to.
    const assets = readFileSync(join(DIST, 'index.html'), 'utf8')
    expect(assets).toBeTruthy()

    const chunks = readdirSync(join(DIST, 'assets'))
    expect(chunks.some((name) => name.startsWith('ethers-'))).toBe(true)
  })

  test('a first visit stays within its budget', () => {
    let total = 0
    const parts: Array<[string, number]> = []

    for (const asset of precached()) {
      const path = join(DIST, asset)
      if (!existsSync(path)) continue
      const size = gzipSync(readFileSync(path)).length
      total += size
      parts.push([asset, size])
    }

    const kb = total / 1024
    const largest = parts.sort((a, b) => b[1] - a[1]).slice(0, 3)

    expect(
      kb,
      `first load is ${kb.toFixed(1)} KB gzipped. Largest: ${largest
        .map(([name, size]) => `${name} ${(size / 1024).toFixed(1)}KB`)
        .join(', ')}`,
    ).toBeLessThan(FIRST_LOAD_BUDGET_KB)
  })

  test('nothing enormous is precached without somebody deciding to', () => {
    /*
     * A single large asset is how a budget gets eaten in one commit. Named
     * individually so the failure says which one, rather than only that the
     * total moved.
     */
    const oversized = precached()
      .map((asset) => {
        const path = join(DIST, asset)
        return existsSync(path)
          ? ([asset, gzipSync(readFileSync(path)).length / 1024] as const)
          : ([asset, 0] as const)
      })
      .filter(([, kb]) => kb > 90)

    expect(oversized).toEqual([])
  })
})
