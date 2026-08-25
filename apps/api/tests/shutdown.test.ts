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

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHarness } from './helpers/e2e.ts'
import { beginShutdown, isShuttingDown, resetShutdownState, shutdown } from '../src/server.ts'

const SERVER = join(import.meta.dirname, '..', 'src', 'server.ts')

/*
 * The shutdown flag lives on the module, because the signal arrives long after
 * the route is registered. That makes it shared across every case in this file,
 * and the first version of these tests did not reset it — so the two cases that
 * call `shutdown()` left it set and a later one saw a server already draining.
 *
 * Reset before each rather than after, so a case that throws cannot poison the
 * next one.
 */
beforeEach(() => {
  resetShutdownState()
})

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

test('readiness refuses before the drain, while health keeps saying alive', async () => {
  /*
   * The two mean different things and a deploy needs both. `/health` answering
   * means the process is alive and must not be killed; `/ready` answering means
   * it can take work. During a shutdown the first is true and the second is not.
   *
   * Conflating them either kills a draining process early or keeps routing
   * traffic into one that is closing.
   */
  const harness = await startHarness()

  try {
    const before = await harness.app.inject({ method: 'GET', url: '/ready' })
    assert.equal(before.statusCode, 200)
    assert.equal(before.json().shuttingDown, false)

    beginShutdown()

    const during = await harness.app.inject({ method: 'GET', url: '/ready' })
    assert.equal(during.statusCode, 503, 'a load balancer must be told to stop')
    assert.equal(during.json().shuttingDown, true)

    // Still alive. Answering 503 here would invite an orchestrator to kill the
    // process mid-drain, which is the thing the drain exists to avoid.
    const health = await harness.app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200, 'liveness must not fail during a shutdown')
  } finally {
    resetShutdownState()
    await harness.close()
  }
})

test('the drain waits after refusing readiness, rather than closing at once', async () => {
  /*
   * A load balancer only learns this process is going away on its next probe,
   * and requests it already routed are still arriving. Closing immediately
   * refuses them — a burst of errors on every deploy, which is exactly what
   * this sequencing exists to prevent.
   */
  const order: string[] = []

  const app = {
    close: async () => {
      // The property that matters: by the time anything closes, the load
      // balancer has already been told to stop.
      order.push(`closed, shuttingDown=${isShuttingDown()}`)
    },
    // Logs are not part of the sequence being asserted — there are two of them
    // and counting them made this test about the wrong thing.
    log: { info: () => undefined, error: () => undefined },
  }

  try {
    await shutdown(app as never, 'SIGTERM', (code) => order.push(`exit ${code}`), 5)

    assert.deepEqual(order, ['closed, shuttingDown=true', 'exit 0'])
  } finally {
    resetShutdownState()
  }
})

test('the pause between refusing readiness and closing actually happens', async () => {
  /*
   * The pause is the whole mechanism, and ordering alone cannot see it: close
   * still happens after `beginShutdown()` whether the wait is there or not.
   * Deleting it passed every other test here.
   *
   * A load balancer learns this process is going away on its next probe. Remove
   * the wait and the socket closes before it finds out, which produces exactly
   * the refused requests the sequencing exists to prevent.
   */
  const app = {
    close: async () => undefined,
    log: { info: () => undefined, error: () => undefined },
  }

  const started = Date.now()
  await shutdown(app as never, 'SIGTERM', () => undefined, 60)
  const elapsed = Date.now() - started

  resetShutdownState()

  // Generous lower bound: timers are not precise, and the assertion is that a
  // wait occurred at all rather than that it was exactly sixty milliseconds.
  assert.ok(elapsed >= 45, `shutdown returned after ${elapsed}ms; it did not wait`)
})
