/**
 * @vitest-environment jsdom
 *
 * The screen that makes the strongest promise in the product.
 *
 * Two kinds of thing are checked here. The first is that the promise is kept in
 * code: the phrase is generated on the device, only the public half is ever
 * sent, and nothing stores a phrase for a key the server did not accept.
 *
 * The second is that the promise is *understood* before it is accepted. This is
 * the one screen where a person can take an irreversible action that can lose
 * them their history, so the words about losing it have to be on the screen and
 * the button has to be unreachable until they say they have written the phrase
 * down. That is interface, not cryptography, and it is the part that decides
 * whether this feature helps anybody.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Custody } from '../src/components/Custody.tsx'
import { api } from '../src/lib/api.ts'

/*
 * The key functions are stubbed, and only those.
 *
 * ethers' Node build produces Buffers that fail its own cross-realm
 * `instanceof Uint8Array` checks once jsdom has replaced the globals, so key
 * generation throws here for reasons that have nothing to do with this code —
 * confirmed by running the same module both with and without jsdom. The
 * cryptography is proved in custody-key.test.ts, in an environment where it can
 * be proved honestly; these tests are about the interface.
 *
 * `rememberPhrase` and `forgetPhrase` stay real, because whether a phrase is
 * left behind on a device is exactly what one of these tests is for.
 */
const FIXTURE = {
  phrase: 'test test test test test test test test test test test junk',
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  publicKey: '0x038318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed75',
}

vi.mock('../src/lib/custody.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/custody.ts')>()
  return {
    ...actual,
    createKey: async () => FIXTURE,
    fromPhrase: async () => FIXTURE,
    signAnchor: async () => ({ signature: '0x' + '11'.repeat(65), deadline: '99999999999' }),
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

beforeEach(() => {
  localStorage.clear()
})

describe('Custody', () => {
  test('a custodial person is told plainly what we can do, and what the trade is', async () => {
    vi.spyOn(api, 'custody').mockResolvedValue({
      selfCustody: false,
      since: null,
      address: null,
      publicKey: null,
    })

    render(<Custody />)

    await screen.findByRole('button', { name: 'Take my key' })

    // The current state, said without euphemism.
    expect(document.body.textContent).toContain('we could read them')

    // And the cost, before anybody has pressed anything. An app that mentions
    // the downside only after you commit has not really told you.
    expect(document.body.textContent).toContain('no reset')
  })

  test('the phrase is shown, and the button stays out of reach until it is written down', async () => {
    vi.spyOn(api, 'custody').mockResolvedValue({
      selfCustody: false,
      since: null,
      address: null,
      publicKey: null,
    })

    render(<Custody />)
    fireEvent.click(await screen.findByRole('button', { name: 'Take my key' }))

    const list = await screen.findByRole('list', { name: 'Your recovery phrase' })
    const words = list.querySelectorAll('li')
    expect(words).toHaveLength(12)

    // Every word is visible in order — not masked, not truncated, not behind a
    // reveal. Somebody is copying these onto paper, and a word they cannot read
    // is a record they cannot recover.
    const shown = Array.from(list.querySelectorAll('.phrase-word')).map((n) => n.textContent)
    expect(shown).toEqual(FIXTURE.phrase.split(' '))

    // Numbered, because the order is part of the secret.
    const numbers = Array.from(list.querySelectorAll('.phrase-index')).map((n) => n.textContent)
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)))

    const commit = screen.getByRole('button', { name: 'This key is mine now' })
    expect((commit as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    expect((commit as HTMLButtonElement).disabled).toBe(false)
  })

  test('only the public half is ever sent', async () => {
    vi.spyOn(api, 'custody').mockResolvedValue({
      selfCustody: false,
      since: null,
      address: null,
      publicKey: null,
    })

    const take = vi.spyOn(api, 'takeCustody').mockResolvedValue({
      selfCustody: true,
      since: new Date().toISOString(),
      address: '0x0000000000000000000000000000000000000001',
    })
    vi.spyOn(api, 'pendingAnchors').mockResolvedValue({ contract: null, chainId: 16602, pending: [] })

    render(<Custody />)
    fireEvent.click(await screen.findByRole('button', { name: 'Take my key' }))

    const list = await screen.findByRole('list', { name: 'Your recovery phrase' })
    const phrase = Array.from(list.querySelectorAll('.phrase-word'))
      .map((node) => node.textContent)
      .join(' ')

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'This key is mine now' }))

    await waitFor(() => expect(take).toHaveBeenCalled())

    // The whole promise, in one assertion: what left the device was a public
    // key and an address. A server that receives the phrase has taken custody
    // back, however good the reason.
    const [publicKey, address] = take.mock.calls[0]!
    expect(publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/i)
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)

    // The phrase itself never appears in what was sent.
    const sent = JSON.stringify(take.mock.calls)
    expect(sent).not.toContain(phrase)
    expect(sent).not.toContain('junk')
  })

  test('a rejected handover does not leave a phrase behind on the device', async () => {
    vi.spyOn(api, 'custody').mockResolvedValue({
      selfCustody: false,
      since: null,
      address: null,
      publicKey: null,
    })
    vi.spyOn(api, 'takeCustody').mockRejectedValue(new Error('nope'))

    render(<Custody />)
    fireEvent.click(await screen.findByRole('button', { name: 'Take my key' }))
    await screen.findByRole('list', { name: 'Your recovery phrase' })

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'This key is mine now' }))

    await screen.findByText(/did not go through/i)

    // A device holding a phrase for a key the server never accepted would look
    // like custody and behave like nothing.
    expect(localStorage.getItem('ogt:custody-phrase')).toBeNull()
  })

  test('somebody who already holds their key is not offered it again', async () => {
    vi.spyOn(api, 'custody').mockResolvedValue({
      selfCustody: true,
      since: '2026-08-01T00:00:00.000Z',
      address: '0x00000000000000000000000000000000000000aa',
      publicKey: '0x02' + 'ab'.repeat(32),
    })
    vi.spyOn(api, 'pendingAnchors').mockResolvedValue({ contract: null, chainId: 16602, pending: [] })

    render(<Custody />)

    await screen.findByText('You hold your own key')
    expect(screen.queryByRole('button', { name: 'Take my key' })).toBeNull()

    // Still says the irreversible part. This is the screen somebody returns to
    // when they are wondering whether the words still matter.
    expect(document.body.textContent).toContain('cannot reset them')
  })

  test('ethers is loaded on demand, not shipped to everybody', () => {
    /*
     * The lazy import is the whole reason a nutrition app can carry a wallet
     * library at all: the built ethers chunk is larger than the entire rest of
     * the app, and most people will never take custody.
     *
     * Asserted against the source rather than the bundle so it fails in the
     * pull request that breaks it, not in a size report somebody reads later. A
     * static `import ... from 'ethers'` anywhere in this module puts it back
     * into everybody's first load.
     */
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'lib', 'custody.ts'),
      'utf8',
    )

    // No static import — that is the line that would put 376 KB into
    // everybody's first load.
    expect(source).not.toMatch(/^import .*from 'ethers'/m)

    /*
     * And a dynamic one, however it is spelled. It is wrapped in `freshImport`
     * now, so matching `await import('ethers')` exactly failed on a change that
     * kept the property perfectly intact — the guard should be about the
     * property, not one arrangement of it.
     */
    expect(source).toMatch(/import\('ethers'\)/)
  })
})
