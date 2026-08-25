/**
 * @vitest-environment jsdom
 *
 * The screen a person gets when our code breaks.
 *
 * React unmounts the whole tree when a render throws, so without this the app
 * becomes an empty white page: no navigation, no message, nothing to press. On
 * a phone that is indistinguishable from the app being broken for good.
 *
 * These assert the behaviour that makes the difference between a bug and a lost
 * user: that something is still on screen, that trying again actually recovers,
 * that a person is never shown a stack trace, and that a bug in our rendering
 * never costs them their session.
 */

import { describe, expect, test, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from '../src/components/ErrorBoundary.tsx'

afterEach(cleanup)

function Boom({ throws }: { throws: boolean }): React.JSX.Element {
  if (throws) throw new Error('the API returned a shape we did not expect')
  return <p>the app</p>
}

/** React writes caught errors to console.error; that is expected here. */
function quietly<T>(run: () => T): T {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    return run()
  } finally {
    spy.mockRestore()
  }
}

describe('ErrorBoundary', () => {
  test('renders its children when nothing is wrong', () => {
    render(
      <ErrorBoundary>
        <Boom throws={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('the app')).toBeTruthy()
  })

  test('a render that throws leaves something on the screen instead of nothing', () => {
    quietly(() =>
      render(
        <ErrorBoundary>
          <Boom throws={true} />
        </ErrorBoundary>,
      ),
    )

    // The whole point: not a blank page.
    const alert = screen.getByRole('alert')
    expect(alert).toBeTruthy()
    expect(alert.textContent).toContain('Something in the app broke')

    // And it says the thing a person actually needs to know, because the
    // reasonable fear at this moment is that their data is gone.
    expect(alert.textContent).toContain('still signed in')
  })

  test('the person is never shown the exception', () => {
    quietly(() =>
      render(
        <ErrorBoundary>
          <Boom throws={true} />
        </ErrorBoundary>,
      ),
    )

    // Our words, not the runtime's. A stack trace tells a person nothing and
    // reads as though the app has come apart.
    expect(document.body.textContent).not.toContain('shape we did not expect')
    expect(document.body.textContent).not.toContain('Error')
  })

  test('trying again recovers, without reloading the app', () => {
    /*
     * The condition persists until something outside the component changes,
     * which is what a real one looks like — a cached response, a stale token, a
     * feature flag read once.
     *
     * A genuinely one-shot throw never reaches here at all: React retries a
     * failed render once on its own, so it heals before the boundary is asked
     * to show anything. Modelling it that way made this test pass while
     * asserting nothing.
     */
    let broken = true

    function Flaky(): React.JSX.Element {
      if (broken) throw new Error('still broken')
      return <p>recovered</p>
    }

    quietly(() => {
      render(
        <ErrorBoundary>
          <Flaky />
        </ErrorBoundary>,
      )

      expect(screen.getByRole('alert')).toBeTruthy()

      broken = false
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })

    // Recovery without a reload matters on a slow connection: reloading costs
    // the person the entire app again.
    expect(screen.getByText('recovered')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('when trying again keeps failing, it stops pretending and offers a reload', () => {
    quietly(() => {
      render(
        <ErrorBoundary>
          <Boom throws={true} />
        </ErrorBoundary>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('keeps failing')

    // Offering "Try again" a third time would be a lie about what will happen.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  test('the error is reported, so a bug nobody sees is still a bug we hear about', () => {
    const seen: Error[] = []

    quietly(() =>
      render(
        <ErrorBoundary onError={(error) => seen.push(error)}>
          <Boom throws={true} />
        </ErrorBoundary>,
      ),
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toContain('shape we did not expect')
  })
})

test('the boundary is actually mounted around the app', () => {
  /*
   * The defect this repository keeps producing is not broken code, it is
   * correct code nothing calls. A boundary that is never mounted passes every
   * test above and catches nothing in production, and the symptom — a white
   * screen — is exactly the symptom of not having one at all.
   */
  const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.tsx'), 'utf8')

  expect(main).toContain('ErrorBoundary')

  // Wrapping <App />, not merely imported and left beside it.
  expect(main).toMatch(/<ErrorBoundary>[\s\S]*<App \/>[\s\S]*<\/ErrorBoundary>/)
})
