/**
 * A rate-limit store that tells each caller its own count.
 *
 * `@fastify/rate-limit`'s LocalStore hands its callback the object it keeps in
 * the LRU, not a copy of it. The plugin then reads `result.current` after an
 * `await`, so under concurrency every request in the same tick reads whatever
 * the counter finished at rather than where it was when that request arrived.
 *
 * Measured against the real thing, on `POST /auth/request-code` where the limit
 * is six an hour:
 *
 *   sequential, eight requests  -> 200 200 200 200 200 429 429 429
 *   concurrent, four requests   -> all allowed   (all four read "4")
 *   concurrent, eight requests  -> all refused   (all eight read "8")
 *
 * The second line is the wrong direction and the third is worse. Eight people
 * arriving together are all turned away, including the six who were within the
 * limit — and "arriving together behind one address" is the normal case for the
 * market this is built for, where a whole carrier sits behind one NAT. A burst
 * from a single phone would lock out everybody on that IP.
 *
 * Nobody floods an endpoint politely, so the concurrent path is the only one
 * that was ever going to matter.
 *
 * The fix is one word — copy — and everything else here is the same algorithm
 * the library uses, kept deliberately identical so this stays a bug fix rather
 * than a second implementation with its own opinions.
 */

interface Entry {
  count: number
  windowStartedAtMs: number
}

export interface CountingStoreOptions {
  timeWindow?: number
}

export class CountingStore {
  private readonly entries = new Map<string, Entry>()
  private readonly timeWindow: number

  constructor(options: CountingStoreOptions = {}) {
    this.timeWindow = options.timeWindow ?? 60_000
  }

  /**
   * Required by the plugin: a per-route store sharing this one's settings.
   *
   * The counters are deliberately not shared with the parent — each route keeps
   * its own, which is what the library does and what the limits assume.
   */
  child(): CountingStore {
    return new CountingStore({ timeWindow: this.timeWindow })
  }

  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow: number = this.timeWindow,
  ): void {
    const now = Date.now()
    const existing = this.entries.get(key)

    let entry: Entry
    if (!existing || existing.windowStartedAtMs + timeWindow <= now) {
      entry = { count: 1, windowStartedAtMs: now }
    } else {
      entry = { count: existing.count + 1, windowStartedAtMs: existing.windowStartedAtMs }
    }

    this.entries.set(key, entry)

    /*
     * A snapshot, and the whole point of this file.
     *
     * The caller reads these numbers after an await. Handing back anything that
     * later increments can reach means it reads somebody else's count.
     */
    callback(null, {
      current: entry.count,
      ttl: Math.max(0, entry.windowStartedAtMs + timeWindow - now),
    })
  }

  /** Exposed for tests; the plugin never calls it. */
  reset(): void {
    this.entries.clear()
  }
}
