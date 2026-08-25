/**
 * What a person sees when our code breaks, instead of a white screen.
 *
 * React unmounts the entire tree when a render throws. With nothing catching
 * that, one undefined field in one response empties the page — no navigation,
 * no message, no way back — and on a phone the only recourse a person has is to
 * decide the app is broken and close it.
 *
 * Three things this must not do, each of which is a way error screens usually
 * make a bad moment worse:
 *
 *   It must not sign anybody out. A render bug is our fault and their session is
 *   still valid; the same principle as a failed network call not clearing the
 *   token.
 *
 *   It must not show a stack trace. That is for the console, where it is
 *   preserved in full.
 *
 *   It must not offer only "reload". Re-rendering is usually enough, and a
 *   reload on a slow connection costs the person the whole app again — so
 *   trying again is offered first, and reloading only once trying again has
 *   visibly not worked.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Told about every caught error, for logging or reporting. */
  onError?: ((error: Error, info: ErrorInfo) => void) | undefined
}

interface ErrorBoundaryState {
  error: Error | null
  /** How many times this boundary has caught, across resets. */
  failures: number
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, failures: 0 }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState((previous) => ({ failures: previous.failures + 1 }))

    // Kept in full where a developer will look for it, and nowhere a person
    // will be shown it.
    console.error('render failed', error, info.componentStack)
    this.props.onError?.(error, info)
  }

  private readonly retry = (): void => {
    this.setState({ error: null })
  }

  private readonly reload = (): void => {
    window.location.reload()
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children

    /*
     * One failure is usually transient — a response that arrived in a shape we
     * did not expect, gone by the next render. Repeated failures are not, and
     * saying "try again" a fourth time would be pretending.
     */
    const persistent = this.state.failures > 1

    return (
      <div className="boundary" role="alert">
        <p className="boundary-message">
          {persistent
            ? 'That part of the app keeps failing. Reloading usually clears it.'
            : 'Something in the app broke. Your data is safe and you are still signed in.'}
        </p>

        {!persistent && (
          <button type="button" onClick={this.retry}>
            Try again
          </button>
        )}

        <button type="button" className={persistent ? undefined : 'quiet'} onClick={this.reload}>
          Reload
        </button>
      </div>
    )
  }
}
