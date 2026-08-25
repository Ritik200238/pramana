/**
 * Loading a chunk that may have been deleted out from under the page.
 *
 * The service worker is registered with `autoUpdate`, and the built worker
 * carries `skipWaiting`, `clientsClaim` and `cleanupOutdatedCaches`. Together
 * those mean a deploy takes effect immediately: the new worker activates,
 * claims pages that are already open, and deletes the previous precache.
 *
 * That is the behaviour we want, and it has one sharp edge. A page opened
 * before the deploy is still running the old JavaScript, and its chunk names
 * are content-hashed — so the moment it needs a lazily loaded module, it asks
 * for a file that no longer exists anywhere. The import rejects.
 *
 * There is exactly one such import in this app, and it is on the custody path:
 * somebody who left the app open, came back after a deploy, and tapped "take my
 * key" would be told "could not create a key on this device". Their device is
 * fine. We deleted the file while they were reading.
 *
 * So: recognise that specific failure and reload once, which is the only thing
 * that fixes it. Once, because a reload loop is worse than an error message —
 * it takes away even the ability to read one.
 */

/** Set for the life of the tab, so a bad deploy cannot cause a reload loop. */
const RELOADED = 'ogt:reloaded-after-update'

/**
 * Whether this looks like a chunk that is no longer there.
 *
 * Browsers word it differently and none of them give a code, so the message is
 * all there is. Narrow on purpose: a genuine bug inside the module must keep
 * throwing rather than turning into a mysterious reload.
 */
export function isStaleChunkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  return [
    // Chrome, Edge
    'failed to fetch dynamically imported module',
    // Firefox
    'error loading dynamically imported module',
    // Safari
    'importing a module script failed',
    // Some proxies serve an HTML error page, which parses as neither
    'expected a javascript module script',
  ].some((phrase) => error.message.toLowerCase().includes(phrase))
}

export interface FreshImportOptions {
  /** Injected so a test can observe it without navigating. */
  reload?: () => void
  /**
   * Where the "already reloaded" flag lives.
   *
   * Explicitly nullable, and read with `!== undefined` rather than `??`, so
   * passing `null` means "there is nowhere to record this" rather than falling
   * back to the real thing. The difference decides whether a reload happens at
   * all, which is too important to leave to an operator that treats null as
   * absent.
   */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

/**
 * Run a dynamic import, surviving a deploy that happened while the page was open.
 *
 * Anything that is not a missing chunk is rethrown untouched: a module that
 * throws on evaluation is a bug, and reloading would hide it behind a flicker.
 */
export async function freshImport<T>(
  load: () => Promise<T>,
  options: FreshImportOptions = {},
): Promise<T> {
  try {
    return await load()
  } catch (error) {
    if (!isStaleChunkError(error)) throw error

    const storage = options.storage !== undefined ? options.storage : safeSessionStorage()

    /*
     * No storage, no guard, no reload.
     *
     * Without somewhere to record that this already happened, a reload could
     * repeat every time the page loads — and a loop takes away even the ability
     * to read the error. A private window losing this recovery is a far smaller
     * harm than a phone stuck reloading.
     */
    if (!storage) throw error

    if (storage.getItem(RELOADED)) {
      /*
       * Already tried. Something else is wrong — an offline first load, a proxy
       * mangling the response — and another reload would spin. The caller shows
       * its own message, which is at least readable.
       */
      throw error
    }

    storage.setItem(RELOADED, '1')
    ;(options.reload ?? (() => window.location.reload()))()

    /*
     * The page is going away. Resolving or rejecting here would let the caller
     * render something for the instant before it does, which reads as a flash
     * of an error that is about to be irrelevant.
     */
    return new Promise<T>(() => {})
  }
}

function safeSessionStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.sessionStorage
  } catch {
    // Private windows and blocked site data. Without it the guard is gone, so
    // the reload is skipped rather than risking a loop.
    return null
  }
}
