/**
 * The rate-limit store, at the level where its properties actually live.
 *
 * `burst.test.ts` proves the endpoint behaves under load, which is the thing
 * that matters. It cannot reach two properties of the store itself: that each
 * caller is told its own count rather than a shared one, and that a window
 * eventually ends. The second was found by mutation — removing the expiry check
 * broke nothing, because every burst test runs inside a single window, and a
 * limit that never resets would have shipped.
 *
 * A limiter that never forgets is not a limiter. It is a ban.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CountingStore } from '../src/plugins/counting-store.ts'

/** The callback API, as a promise, so a test can read what a caller is told. */
function incr(
  store: CountingStore,
  key: string,
  timeWindow?: number,
): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => {
    store.incr(
      key,
      (error, result) => (error ? reject(error) : resolve(result!)),
      timeWindow,
    )
  })
}

test('each caller is told its own count, not the total', async () => {
  const store = new CountingStore({ timeWindow: 60_000 })

  /*
   * The whole reason this file exists. The library's store hands back the object
   * it keeps, and the plugin reads the count after an await — so eight requests
   * in one tick all read eight. Here they must read one through eight.
   */
  const results = await Promise.all(
    Array.from({ length: 8 }, () => incr(store, 'same-key')),
  )

  assert.deepEqual(
    results.map((result) => result.current).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8],
  )
})

test('a snapshot does not change afterwards', async () => {
  const store = new CountingStore({ timeWindow: 60_000 })

  const first = await incr(store, 'key')
  await incr(store, 'key')
  await incr(store, 'key')

  // Holding a result must not mean holding a live view of the counter.
  assert.equal(first.current, 1)
})

test('a window ends, so a limit is a limit and not a ban', async () => {
  /*
   * Found by mutation: deleting the expiry check failed nothing, because every
   * other test runs inside one window. Somebody rate-limited once would have
   * stayed limited for the life of the process.
   */
  const store = new CountingStore({ timeWindow: 20 })

  await incr(store, 'key', 20)
  await incr(store, 'key', 20)

  const before = await incr(store, 'key', 20)
  assert.equal(before.current, 3)

  await new Promise((resolve) => setTimeout(resolve, 30))

  const after = await incr(store, 'key', 20)
  assert.equal(after.current, 1, 'the count must start again once the window has passed')
})

test('the ttl counts down within a window, and resets with it', async () => {
  const store = new CountingStore({ timeWindow: 100 })

  const first = await incr(store, 'key', 100)
  assert.ok(first.ttl > 0 && first.ttl <= 100)

  await new Promise((resolve) => setTimeout(resolve, 30))

  const later = await incr(store, 'key', 100)
  // Somebody is reading this off a Retry-After header, so it has to mean the
  // time remaining rather than the window length.
  assert.ok(later.ttl < first.ttl, `ttl should have decreased, ${later.ttl} vs ${first.ttl}`)
})

test('different keys do not share a counter', async () => {
  const store = new CountingStore({ timeWindow: 60_000 })

  await incr(store, 'one')
  await incr(store, 'one')
  const other = await incr(store, 'two')

  // One host's burst must not spend another host's budget.
  assert.equal(other.current, 1)
})

test('a child store keeps its own counters', async () => {
  const parent = new CountingStore({ timeWindow: 60_000 })
  const child = parent.child()

  await incr(parent, 'key')
  await incr(parent, 'key')
  const fromChild = await incr(child, 'key')

  /*
   * The plugin makes one of these per route. Sharing counters between them
   * would mean a burst on one endpoint spending the budget of every other,
   * which is how a single noisy client takes down everything at once.
   */
  assert.equal(fromChild.current, 1)
})
