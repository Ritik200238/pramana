/**
 * @vitest-environment jsdom
 *
 * The confidence badge tells people what to do about a rough number, and what
 * to do depends on where they are standing.
 *
 * On the day view the meals are listed underneath and each opens a correction,
 * so "tap any item" is true. On the screen straight after logging there is a
 * total, a badge and a Done button — nothing to tap. That screen showed the
 * same sentence, so the app asked for an impossible action at the moment
 * somebody had just been told the number was a guess and was most likely to
 * want to fix it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ConfidenceBadge } from '../src/components/ConfidenceBadge'

// Auto-cleanup is not on in this project, so without this each case searches
// the DOM left behind by the one before it and asserts against the wrong badge.
afterEach(cleanup)

describe('what a rough number tells you to do', () => {
  it('offers the tap only where there is something to tap', () => {
    render(<ConfidenceBadge level="rough" correctable />)
    expect(screen.getByText(/tap any item to correct it/i)).toBeTruthy()
  })

  it('never promises a tap on a screen without items', () => {
    render(<ConfidenceBadge level="rough" />)

    expect(screen.queryByText(/tap any item/i)).toBeNull()
    // And still says the number can be fixed, which is the part that matters.
    expect(screen.getByText(/correct it once it is logged/i)).toBeTruthy()
  })

  it('defaults to the honest one, so a new placement cannot inherit the promise', () => {
    /*
     * The direction of the default is the whole guard. Defaulting to
     * "correctable" would mean any screen that forgets the prop repeats exactly
     * the bug this fixes, silently.
     */
    render(<ConfidenceBadge level="rough" />)
    expect(screen.queryByText(/tap any item/i)).toBeNull()
  })

  it('still distinguishes a barcode from a guess', () => {
    // The reason the component exists: a guess must never look like a barcode.
    const { unmount } = render(<ConfidenceBadge level="exact" />)
    expect(screen.getByText(/from a barcode or packet label/i)).toBeTruthy()
    expect(screen.queryByText(/estimated/i)).toBeNull()
    unmount()

    render(<ConfidenceBadge level="confirmed" />)
    expect(screen.getByText(/you told me the amounts/i)).toBeTruthy()
  })
})
