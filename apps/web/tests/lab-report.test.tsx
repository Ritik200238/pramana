/**
 * @vitest-environment jsdom
 *
 * The blood-report screen.
 *
 * This is the highest-evidence feature in FEATURES.md and until now it had no
 * way in: the route, the pipeline and its tests all existed while nothing
 * rendered them, so from a user's side the feature did not exist.
 *
 * The assertions that matter here are not about layout. Somebody reads their
 * own HbA1c on this screen, often at night, often worried. So: a value is never
 * shown without the range it is being compared against, the app never says what
 * a result means, and the line telling them to take it to a doctor is present
 * every time — including when the report comes back with nothing useful in it.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LabReport } from '../src/components/LabReport.tsx'
import { api } from '../src/lib/api.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const REPORT = {
  reportId: 'r1',
  status: 'ready' as const,
  labName: 'Dr Lal PathLabs',
  summary: 'Your HbA1c is a little above the usual range. Everything else reads as usual.',
  disclaimer:
    'This explains what the report says. What it means for you is a question for a doctor — please take it to one.',
  markers: [
    {
      code: 'hba1c',
      name: 'HbA1c',
      value: 6.1,
      unit: '%',
      refLow: 4,
      refHigh: 5.7,
      flag: 'high' as const,
    },
    {
      code: 'hb',
      name: 'Haemoglobin',
      value: 14.2,
      unit: 'g/dL',
      refLow: 13,
      refHigh: 17,
      flag: 'normal' as const,
    },
  ],
}

/** Drives the hidden file input the way a camera would. */
async function photograph() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['x'], 'report.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input, 'files', { value: [file] })
  fireEvent.change(input)
}

describe('LabReport', () => {
  test('a report is read, and every value carries the range it is judged against', async () => {
    vi.spyOn(api, 'markers').mockResolvedValue({ series: [] })
    vi.spyOn(api, 'uploadReport').mockResolvedValue(REPORT)

    render(<LabReport />)
    await photograph()

    await screen.findByText(/HbA1c is a little above/)

    // The number, its unit, and — the part that stops somebody googling at
    // midnight — what counts as usual, right beside it.
    expect(document.body.textContent).toContain('6.1 %')
    expect(document.body.textContent).toContain('usual 4–5.7')
    expect(document.body.textContent).toContain('above the usual range')

    expect(document.body.textContent).toContain('14.2 g/dL')
    expect(document.body.textContent).toContain('usual 13–17')
  })

  test('it never says what a result means', async () => {
    vi.spyOn(api, 'markers').mockResolvedValue({ series: [] })
    vi.spyOn(api, 'uploadReport').mockResolvedValue(REPORT)

    render(<LabReport />)
    await photograph()
    await screen.findByText(/HbA1c is a little above/)

    // The words an anxious person reads as a verdict. A screen that explains a
    // report has no business producing any of them.
    for (const verdict of ['diabetes', 'diabetic', 'prediabetes', 'disease', 'risk of', 'you have']) {
      expect(document.body.textContent?.toLowerCase()).not.toContain(verdict)
    }

    // And the one sentence that has to be there instead.
    expect(document.body.textContent).toContain('question for a doctor')
  })

  test('the doctor line is present even when the report says nothing useful', async () => {
    vi.spyOn(api, 'markers').mockResolvedValue({ series: [] })
    vi.spyOn(api, 'uploadReport').mockResolvedValue({
      reportId: 'r2',
      status: 'ready',
      // No summary, no markers, no disclaimer from the server.
    })

    render(<LabReport />)
    await photograph()

    // A fallback rather than a blank space. The one time this line is most
    // likely to go missing is the one time the response was unusual.
    await waitFor(() =>
      expect(document.body.textContent).toContain('question for a doctor'),
    )
  })

  test('an unreadable photo says what to do about it, not what went wrong', async () => {
    vi.spyOn(api, 'markers').mockResolvedValue({ series: [] })
    vi.spyOn(api, 'uploadReport').mockRejectedValue(new Error('boom'))

    render(<LabReport />)
    await photograph()

    // Actionable, and about the photo rather than about our stack.
    const message = await screen.findByText(/did not read/i)
    expect(message.textContent).toMatch(/better light|flatter/i)
    expect(document.body.textContent).not.toContain('boom')

    // And the way back is still there.
    expect(screen.getByRole('button', { name: /photograph a report/i })).toBeTruthy()
  })

  test('markers already on file are shown over time', async () => {
    vi.spyOn(api, 'markers').mockResolvedValue({
      series: [
        {
          code: 'hba1c',
          name: 'HbA1c',
          unit: '%',
          points: [
            { value: 6.4, flag: 'high', refLow: 4, refHigh: 5.7, measuredAt: '2026-02-01' },
            { value: 6.1, flag: 'high', refLow: 4, refHigh: 5.7, measuredAt: '2026-08-01' },
          ],
        },
      ],
    })

    render(<LabReport />)

    // The whole argument for keeping the record: one reading is a number, two
    // is a direction.
    await screen.findByText('Over time')
    expect(document.body.textContent).toContain('6.4 → 6.1')

    // And whose record it is.
    expect(document.body.textContent).toContain('only with your key')
  })

  test('the screen is reachable — a tab renders it', () => {
    /*
     * The defect this feature spent its whole life in: a working route, a
     * tested pipeline, and nothing rendering it. Asserted against the source so
     * it fails in the change that unmounts it, rather than in a bug report from
     * somebody who could not find the feature.
     */
    const coach = readFileSync(
      join(import.meta.dirname, '..', 'src', 'screens', 'Coach.tsx'),
      'utf8',
    )

    expect(coach).toContain('LabReport')
    expect(coach).toMatch(/panel === 'report'\s*&&\s*<LabReport\s*\/>/)
  })
})
