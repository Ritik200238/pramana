/**
 * A blood report, photographed, explained in a sentence — and then tracked.
 *
 * This is the highest-evidence feature in FEATURES.md and it had no way in.
 * The route, the pipeline and its tests all existed; nothing rendered them, so
 * from a user's side the feature did not exist. That is the defect this
 * repository keeps producing, and here it was hiding the strongest thing we
 * have: Hindi videos explaining reports by hand pull millions of views, and the
 * best AI-native version anyone found had 706.
 *
 * Two rules shape everything on this screen.
 *
 * It never interprets. A number outside the reference range is shown as outside
 * the reference range, with the range beside it, and the sentence that follows
 * is "take this to a doctor" — not a diagnosis, not a reassurance, not a
 * probability. Someone reading their own HbA1c at midnight is exactly who gets
 * hurt by a confident guess.
 *
 * And it treats the flag as information, not alarm. A high marker is marked
 * clearly and calmly. Red panic on a health screen is how people stop opening
 * an app that has something they need to see.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, isBlocked, type MarkerSeries, type ReportResult } from '../lib/api.ts'

type Stage =
  | { name: 'idle' }
  | { name: 'reading' }
  | { name: 'done'; report: ReportResult }
  | { name: 'error'; message: string }

/** Plain words for a flag. Never a verdict. */
const FLAG_LABEL: Record<string, string> = {
  low: 'below the usual range',
  high: 'above the usual range',
  normal: 'in the usual range',
  unknown: 'no range given',
}

export function LabReport() {
  const [stage, setStage] = useState<Stage>({ name: 'idle' })
  const [series, setSeries] = useState<MarkerSeries[] | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadMarkers = useCallback(async () => {
    try {
      const result = await api.markers()
      setSeries(result.series)
    } catch {
      // The history is a bonus on this screen; failing to load it must not
      // take the upload with it.
      setSeries(null)
    }
  }, [])

  useEffect(() => {
    void loadMarkers()
  }, [loadMarkers])

  const onFile = async (file: File) => {
    setStage({ name: 'reading' })

    try {
      const dataUrl = await toDataUrl(file)
      const report = await api.uploadReport(dataUrl)

      if (isBlocked(report)) {
        setStage({ name: 'error', message: report.message })
        return
      }

      setStage({ name: 'done', report })
      // New markers change the history underneath it.
      void loadMarkers()
    } catch (error) {
      setStage({
        name: 'error',
        message:
          (error instanceof ApiError ? error.userMessage : null) ??
          'That did not read. A flatter photo, in better light, usually does.',
      })
    }
  }

  return (
    <section className="panel report">
      <h2>Blood report</h2>
      <p className="muted">
        Photograph the page. Every marker in one line, with what counts as usual.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        /*
          Labelled and taken out of the tab order.

          `sr-only` hides it visually and not from a screen reader, so before
          this it was an unnamed file input sitting in the tab order of the most
          important action in the app. The visible button is the real control and
          is properly named; this is here so that anybody who reaches the input
          another way still knows what it is.
        */
        aria-label="Take or choose a photo of your blood report."
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void onFile(file)
        }}
      />

      {stage.name !== 'reading' && (
        <button type="button" className="quiet" onClick={() => fileRef.current?.click()}>
          {stage.name === 'done' ? 'Read another' : 'Photograph a report'}
        </button>
      )}

      {stage.name === 'reading' && <p className="muted">Reading it…</p>}

      {stage.name === 'error' && <p className="error">{stage.message}</p>}

      {stage.name === 'done' && (
        <div className="report-result">
          {stage.report.labName && <p className="eyebrow">{stage.report.labName}</p>}
          {stage.report.summary && <p className="report-summary">{stage.report.summary}</p>}

          {stage.report.markers && stage.report.markers.length > 0 && (
            <ul className="markers">
              {stage.report.markers.map((marker) => (
                <li key={marker.code} className={`marker marker-${marker.flag}`}>
                  <span className="marker-name">{marker.name}</span>
                  <span className="marker-value">
                    {marker.value} {marker.unit}
                  </span>
                  <span className="marker-flag">{FLAG_LABEL[marker.flag] ?? marker.flag}</span>
                  {marker.refLow !== null && marker.refHigh !== null && (
                    // The range beside the number, always. A value on its own
                    // is a number somebody has to go and look up while worried.
                    <span className="marker-range">
                      usual {marker.refLow}–{marker.refHigh}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/*
            Not optional and not small. This screen shows numbers people will
            read as a verdict unless it says otherwise, so it says otherwise in
            the same breath.
          */}
          <p className="report-disclaimer">
            {stage.report.disclaimer ??
              'This explains what the report says. What it means for you is a question for a doctor — please take it to one.'}
          </p>
        </div>
      )}

      {series !== null && series.length > 0 && (
        <div className="marker-history">
          <h3>Over time</h3>
          {series.map((marker) => (
            <p key={marker.code} className="marker-line">
              <span className="marker-name">{marker.name}</span>
              <span className="marker-trend">
                {marker.points
                  .slice(-4)
                  .map((point) => `${point.value}`)
                  .join(' → ')}{' '}
                {marker.unit}
              </span>
            </p>
          ))}
          <p className="muted">
            Kept encrypted, and readable only with your key.
          </p>
        </div>
      )}
    </section>
  )
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read that image.'))
    reader.readAsDataURL(file)
  })
}
