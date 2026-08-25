/**
 * @vitest-environment jsdom
 *
 * You — the screen where the product describes itself.
 *
 * Everything here is a claim about what we can and cannot do, which makes it the
 * one screen where being out of date is the same as lying. It already was: the
 * trust note said moving the key onto somebody's device was "the next thing to
 * change" for a while after it had already changed, so the most
 * trust-sensitive sentence in the product was the stale one.
 *
 * So these tests hold the copy to the code. What the screen says about
 * attestation has to match what attestation actually gives us, and what it says
 * about custody has to match what custody actually does.
 *
 * Sign-out is the other thing worth pinning. A failed sign-out that leaves
 * somebody signed in on a borrowed phone is the worst outcome this screen has.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { You } from '../src/screens/You.tsx'
import { api } from '../src/lib/api.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

const PROOF = {
  summary: 'Every reading of your food this week ran on attested hardware.',
  total: 12,
  verified: 12,
  receipts: [
    {
      requestId: 'req-1',
      provider: '0xa48f01287233509FD694a22Bf840225062E67836',
      model: 'qwen/qwen2.5-omni-7b',
      status: 'verified' as const,
      verifiedAt: '2026-08-25T10:00:00.000Z',
    },
  ],
}

function renderYou() {
  const onSignedOut = vi.fn()

  if (!vi.isMockFunction(api.proof)) {
    vi.spyOn(api, 'proof').mockResolvedValue(PROOF as never)
  }
  if (!vi.isMockFunction(api.me)) {
    vi.spyOn(api, 'me').mockResolvedValue({
      user: {
        id: 'u1',
        phone: '+919876543210',
        displayName: null,
        sex: 'male',
        ageYears: 28,
        heightCm: 175,
        goal: 'lose',
        diet: 'veg',
        cooks: 'self',
        tone: 'straight',
      },
      onboarded: true,
    } as never)
  }
  if (!vi.isMockFunction(api.custody)) {
    vi.spyOn(api, 'custody').mockResolvedValue({
      selfCustody: false,
      since: null,
      address: null,
      publicKey: null,
    })
  }
  if (!vi.isMockFunction(api.facts)) {
    vi.spyOn(api, 'facts').mockResolvedValue({ facts: [] })
  }

  render(<You onSignedOut={onSignedOut} />)
  return { onSignedOut }
}

describe('You', () => {
  test('the proof panel says what a receipt is, and what it is not', async () => {
    renderYou()

    await screen.findByText(/where your data was processed/i)
    fireEvent.click(screen.getByText(/what does .*verified.* actually mean/i))

    /*
     * The honest limit, stated on the screen that makes the claim: 0G checks
     * the signature and tells us the result. We never hold the signature, so a
     * person cannot re-run the check themselves.
     */
    expect(document.body.textContent).toMatch(/receipt, not a proof you can re-run/i)
  })

  test('what it says about custody matches what custody does', async () => {
    renderYou()

    await screen.findByText(/where your data was processed/i)
    fireEvent.click(screen.getByText(/what does .*verified.* actually mean/i))

    const text = document.body.textContent ?? ''

    // Says plainly that by default we can read them.
    expect(text).toMatch(/we\s*can read them/i)

    // And that taking the key is available now, rather than promised. This
    // sentence was stale once and it is the one people decide on.
    expect(text).not.toMatch(/next thing to change|coming soon|will be able/i)
    expect(text).toMatch(/take that key/i)
  })

  test('exporting the key warns that it is a credential, not a copy', async () => {
    renderYou()

    // Scoped to the heading: "your data" appears in prose too, and matching
    // prose would not prove the export section rendered at all.
    await screen.findByRole('heading', { name: /^your data$/i })

    // Downloading everything is offered plainly — no charge, no cancellation
    // flow — because it is their record.
    expect(screen.getByRole('link', { name: /download everything/i })).toBeTruthy()

    fireEvent.click(screen.getByText(/take your key as well/i))

    /*
     * The key is a different thing from the data, and the difference is the
     * whole warning: a file that reads their records forever and acts as them
     * on chain. Somebody who thinks they are downloading a backup should not
     * discover that later.
     */
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/it is also a credential/i)
    expect(text).toMatch(/act as you on 0G Chain/i)
    expect(text).toMatch(/do not send that file to anyone/i)
  })

  test('signing out clears the session even when the server call fails', async () => {
    vi.spyOn(api, 'signOut').mockRejectedValue(new Error('offline'))

    const { onSignedOut } = renderYou()

    await screen.findByText(/account/i)
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))

    /*
     * The worst outcome on this screen is a borrowed phone that stays signed in
     * because the network was down. Local state is cleared either way.
     */
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled())
  })

  test('the custody panel and the remembered panel are both mounted', () => {
    /*
     * Both were built and unreachable at some point in this repository's life,
     * which is its most expensive recurring defect. Asserted against the source
     * so it fails in the change that unmounts one, rather than in a report from
     * somebody who could not find the feature.
     */
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'screens', 'You.tsx'),
      'utf8',
    )

    expect(source).toContain('<Custody />')
    expect(source).toContain('<Remembered />')
  })
})
