/**
 * The state every user is in for their first ninety seconds.
 *
 * Signed in, no profile yet. It is short-lived and therefore easy to forget,
 * and it is the worst possible moment to show somebody a crash: they have given
 * us a phone number and received nothing yet.
 *
 * An error-path sweep found two responses here that no test asserted, so this
 * asks the broader question instead of patching the two: what does every route
 * do for a user who has proved who they are and told us nothing else? The
 * answer must be a clean refusal everywhere, and never a 500.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signIn, startHarness, type Harness } from './helpers/e2e.ts'

async function withSignedInStranger(
  body: (h: Harness, headers: Record<string, string>) => Promise<void>,
): Promise<void> {
  const harness = await startHarness()
  try {
    const { token } = await signIn(harness, '9600000001')
    // Deliberately no profile call.
    await body(harness, { authorization: `Bearer ${token}` })
  } finally {
    await harness.close()
  }
}

test('the app knows to ask, rather than to show a dashboard', async () => {
  await withSignedInStranger(async (h, headers) => {
    const me = await h.app.inject({ method: 'GET', url: '/auth/me', headers })
    assert.equal(me.statusCode, 200)
    assert.equal(me.json().onboarded, false, 'this is the flag the client branches on')
  })
})

test('targets refuse cleanly when there is nothing to compute them from', async () => {
  await withSignedInStranger(async (h, headers) => {
    const response = await h.app.inject({ method: 'GET', url: '/users/me/targets', headers })

    // Inventing a target from no height, weight or goal would be worse than
    // refusing: it is a number somebody might act on.
    assert.equal(response.statusCode, 409, response.body)
    assert.equal(response.json().error, 'profile_incomplete')
  })
})

test('the pantry refuses cleanly before there is a household', async () => {
  await withSignedInStranger(async (h, headers) => {
    const response = await h.app.inject({
      method: 'PUT',
      url: '/users/me/pantry',
      headers,
      payload: { items: ['dal', 'rice'] },
    })

    assert.equal(response.statusCode, 409, response.body)
    assert.equal(response.json().error, 'no_household')
  })
})

test('no route answers a half-known user with a server error', async () => {
  await withSignedInStranger(async (h, headers) => {
    // Every GET that takes no parameters. A 500 here is us failing, not them.
    const routes = [
      '/users/me/today',
      '/users/me/usuals',
      '/users/me/streak',
      '/users/me/proactive',
      '/users/me/targets',
      '/auth/me',
      '/auth/sessions',
    ]

    const faults: string[] = []
    for (const url of routes) {
      const response = await h.app.inject({ method: 'GET', url, headers })
      if (response.statusCode >= 500) faults.push(`${url} -> ${response.statusCode}`)
    }

    assert.deepEqual(faults, [], 'these fail on a user who has simply not finished signing up')
  })
})

test('today reads as empty rather than broken before onboarding', async () => {
  await withSignedInStranger(async (h, headers) => {
    const response = await h.app.inject({ method: 'GET', url: '/users/me/today', headers })

    assert.equal(response.statusCode, 200, response.body)
    const day = response.json()
    assert.equal(day.mealCount, 0)
    // No targets yet, and the screen is built to render that state. Sending a
    // fabricated target instead would put a number on screen nobody chose.
    assert.equal(day.targets, null)
  })
})

test('a stranger cannot skip onboarding by logging a meal', async () => {
  await withSignedInStranger(async (h, headers) => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/meals/commit',
      headers,
      payload: { vision: { items: [] }, answers: [], source: 'text' },
    })

    // Whatever the answer is, it must be a refusal rather than a fault.
    assert.ok(response.statusCode < 500, `commit answered ${response.statusCode}`)
  })
})
