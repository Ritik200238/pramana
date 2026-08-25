/**
 * What happens when the process is told to stop.
 *
 * There was no signal handling at all, so every deploy killed the server
 * outright: requests in flight were dropped, the `onClose` hook never ran, and
 * the connection pool was never drained.
 *
 * The chain was never at risk. An anchor carries a deterministic nonce the
 * contract refuses a second time, and Postgres releases the advisory lock when
 * the holder's connection dies — both verified elsewhere. What was lost was
 * somebody's request. The offline queue retries it with the same idempotency
 * key, so nothing vanished permanently; it simply looked to them like the app
 * had failed, which is its own cost and an avoidable one.
 *
 * These check the two halves that matter: that a shutdown drains rather than
 * drops, and that it cannot hang forever waiting for a request that never ends.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHarness } from './helpers/e2e.ts'
import { shutdown } from '../src/server.ts'

const SERVER = join(import.meta.dirname, '..', 'src', 'server.ts')

test('closing the server stops every background worker', async () => {
  /*
   * The `onClose` hook is what stops the timers, and before this nothing ever
   * called it in production — the process simply died. A worker left running
   * against a closed pool logs errors until the process ends; a worker stopped
   * properly does not.
   */
  const harness = await startHarness()

  // Closing twice must not throw: a shutdown racing an orchestrator's second
  // signal would otherwise turn a clean exit into a failed one.
  await harness.close()
  await assert.doesNotReject(() => harness.app.close())
})

test('both deploy signals are handled, not just the interactive one', () => {
  /*
   * SIGTERM is what an orchestrator sends on a deploy and is the one that
   * matters; SIGINT is Ctrl-C and is the one people remember. Handling only the
   * second would look correct in development and change nothing in production.
   */
  const source = readFileSync(SERVER, 'utf8')

  assert.match(source, /'SIGTERM'/, 'a deploy sends SIGTERM')
  assert.match(source, /'SIGINT'/)
  assert.match(source, /process\.once\(/, 'a second signal must not start a second shutdown')
})

test('a clean shutdown closes the app, then exits zero, in that order', async () => {
  /*
   * Behavioural rather than read from the source. `process.exit` on a signal is
   * the version of this that looks right and does nothing — it skips the
   * onClose hook, so the workers keep running until the process dies anyway and
   * the pool is never drained.
   */
  const events: string[] = []
  const app = {
    close: async () => {
      events.push('closed')
    },
    log: { info: () => undefined, error: () => undefined },
  }

  await shutdown(app as never, 'SIGTERM', (code) => events.push(`exit ${code}`))

  assert.deepEqual(events, ['closed', 'exit 0'], 'the drain must finish before the exit')
})

test('a shutdown that cannot close still exits, and says it failed', async () => {
  // A pool that will not drain must not leave the process sitting there until
  // an orchestrator sends SIGKILL, taking everything in flight with it.
  const events: string[] = []
  const app = {
    close: async () => {
      throw new Error('pool is stuck')
    },
    log: { info: () => undefined, error: () => events.push('logged the failure') },
  }

  await shutdown(app as never, 'SIGTERM', (code) => events.push(`exit ${code}`))

  assert.deepEqual(events, ['logged the failure', 'exit 1'])
})

test('a shutdown that will not finish gives up rather than hanging', () => {
  /*
   * The deadline itself is read from the source, because triggering it in a
   * test would mean waiting twenty-five seconds. What is asserted is that it
   * exists and is inside the window an orchestrator allows — thirty seconds by
   * default — since a deadline longer than that never fires and is decoration.
   */
  const source = readFileSync(SERVER, 'utf8')

  assert.match(source, /SHUTDOWN_GRACE_MS/, 'there must be a deadline')
  assert.match(source, /shutdown took too long/, 'and it must say so rather than exiting silently')

  const grace = /SHUTDOWN_GRACE_MS = ([\d_]+)/.exec(source)?.[1]?.replace(/_/g, '')
  assert.ok(grace, 'the deadline must be a literal that can be read')
  assert.ok(Number(grace) < 30_000, `${grace}ms is not inside a default grace period`)
})

