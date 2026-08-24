/**
 * What a person sees when the safety gate stops us.
 *
 * Deliberately not an error state. No red, no warning triangle, no "something
 * went wrong". Someone disclosing purging or self-harm has not made a mistake,
 * and rendering their disclosure as a failure would be a cruel piece of
 * interface design.
 *
 * The helpline is the largest tappable thing on the screen. If it is going to
 * be here at all, it should not be a footnote.
 */

export interface BlockedProps {
  message: string
  /**
   * Explicitly allows `undefined` as well as being optional: under
   * `exactOptionalPropertyTypes`, callers holding a possibly-absent helpline
   * would otherwise have to spread it conditionally at every call site.
   */
  helpline?: { label: string; number: string } | undefined
  onClose: () => void
}

export function Blocked({ message, helpline, onClose }: BlockedProps) {
  return (
    <div className="blocked" role="alertdialog" aria-label="A note from the app">
      <p className="blocked-message">{message}</p>

      {helpline && (
        <a className="helpline" href={`tel:${helpline.number}`}>
          <strong>{helpline.number}</strong>
          <span>{helpline.label}</span>
        </a>
      )}

      <button type="button" className="quiet" onClick={onClose}>
        Close
      </button>
    </div>
  )
}
