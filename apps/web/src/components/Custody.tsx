/**
 * Taking your records out of our hands.
 *
 * This screen makes the strongest promise in the product, so it is written to
 * be understood rather than to sound reassuring. It says what we can do now,
 * what we will not be able to do after, and — the part most apps leave out —
 * what happens if the words are lost. Nobody should agree to this without
 * knowing that last part.
 *
 * There is no "are you sure?" dialog. There is a phrase you have to have seen
 * and a box you have to tick, which is a slower and more honest gate than a
 * confirm button people click through.
 */

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api.ts'
import {
  createKey,
  forgetPhrase,
  rememberPhrase,
  rememberedPhrase,
  signAnchor,
  type DeviceKey,
} from '../lib/custody.ts'

type State =
  | { step: 'loading' }
  | { step: 'ours' }
  | { step: 'generated'; key: DeviceKey; written: boolean }
  | { step: 'saving'; key: DeviceKey }
  | { step: 'theirs'; since: string | null; address: string | null }
  | { step: 'error'; message: string }

export function Custody() {
  const [state, setState] = useState<State>({ step: 'loading' })
  const [anchors, setAnchors] = useState<{ pending: number; signed: number } | null>(null)

  const load = useCallback(async () => {
    try {
      const current = await api.custody()
      setState(
        current.selfCustody
          ? { step: 'theirs', since: current.since, address: current.address }
          : { step: 'ours' },
      )
    } catch (error) {
      setState({
        step: 'error',
        message:
          (error instanceof ApiError ? error.userMessage : null) ??
          'Could not check this just now.',
      })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * Sign whatever is waiting, whenever this screen is open and the phrase is on
   * the device.
   *
   * Records keep being written either way — encrypting needs only the public
   * key — but they cannot be anchored until their owner signs, and their owner
   * is now the person rather than us. Doing it here, quietly, is the difference
   * between a promise and a chore.
   */
  const signPending = useCallback(async () => {
    const phrase = rememberedPhrase()
    if (!phrase) return

    try {
      const { contract, chainId, pending } = await api.pendingAnchors()
      if (!contract || pending.length === 0) {
        setAnchors({ pending: 0, signed: 0 })
        return
      }

      const unsigned = pending.filter((anchor) => !anchor.signed)
      let signed = 0

      for (const anchor of unsigned) {
        const { signature, deadline } = await signAnchor(phrase, contract, chainId, anchor)
        await api.submitAnchorSignature(anchor.id, signature, deadline)
        signed += 1
      }

      setAnchors({ pending: pending.length, signed })
    } catch {
      // Not surfaced. Anchoring is background work and it retries next time the
      // screen opens; an error here would alarm somebody about something that
      // is already in hand.
    }
  }, [])

  useEffect(() => {
    if (state.step === 'theirs') void signPending()
  }, [state.step, signPending])

  const generate = async () => {
    try {
      setState({ step: 'generated', key: await createKey(), written: false })
    } catch (error) {
      // Kept where a developer will find it. The person sees a sentence; the
      // cause — an old browser, blocked crypto, a failed chunk load — is only
      // ever diagnosable from here.
      console.error('could not create a custody key', error)
      setState({ step: 'error', message: 'Could not create a key on this device.' })
    }
  }

  const confirm = async (key: DeviceKey) => {
    setState({ step: 'saving', key })
    try {
      const result = await api.takeCustody(key.publicKey, key.address)
      // Stored only after the server accepted it. Storing first would leave a
      // device holding a phrase for a key nobody uses.
      rememberPhrase(key.phrase)
      setState({ step: 'theirs', since: result.since, address: result.address })
    } catch (error) {
      forgetPhrase()
      setState({
        step: 'error',
        message:
          (error instanceof ApiError ? error.userMessage : null) ?? 'That did not go through.',
      })
    }
  }

  if (state.step === 'loading') {
    return (
      <section className="panel">
        <h2>Your key</h2>
        <p className="muted">Checking…</p>
      </section>
    )
  }

  if (state.step === 'error') {
    return (
      <section className="panel">
        <h2>Your key</h2>
        <p className="error">{state.message}</p>
        <button type="button" className="quiet" onClick={() => void load()}>
          Try again
        </button>
      </section>
    )
  }

  if (state.step === 'theirs') {
    return (
      <section className="panel custody custody-theirs">
        <h2>You hold your own key</h2>
        <p>
          Your records are encrypted to a key only you have. We can still write them, and we
          cannot read them.
        </p>
        {state.address && (
          <p className="custody-address">
            <span className="eyebrow">Your account</span>
            <code>{state.address}</code>
          </p>
        )}
        {state.since && (
          <p className="muted">Since {new Date(state.since).toLocaleDateString()}.</p>
        )}
        {anchors !== null && anchors.signed > 0 && (
          <p className="muted">
            Signed {anchors.signed} record{anchors.signed === 1 ? '' : 's'} on this device.
          </p>
        )}
        <p className="muted">
          Those twelve words are the only way back to this. We cannot reset them, and nobody
          here can look them up.
        </p>
      </section>
    )
  }

  if (state.step === 'generated' || state.step === 'saving') {
    const { key } = state
    const saving = state.step === 'saving'

    return (
      <section className="panel custody">
        <h2>Write these down</h2>
        <p>
          Twelve words. They are your key. This is the only time they are shown, and we never
          receive them.
        </p>

        <ol className="phrase" aria-label="Your recovery phrase">
          {key.phrase.split(' ').map((word, index) => (
            <li key={`${index}-${word}`}>
              <span className="phrase-index">{index + 1}</span>
              <span className="phrase-word">{word}</span>
            </li>
          ))}
        </ol>

        <p className="muted">
          They work in any wallet, not only here. If you lose them, your past records stay
          encrypted and nobody — including us — can open them again.
        </p>

        <label className="choice-inline">
          <input
            type="checkbox"
            checked={state.step === 'generated' ? state.written : true}
            disabled={saving}
            onChange={(event) =>
              state.step === 'generated' &&
              setState({ step: 'generated', key, written: event.target.checked })
            }
          />
          <span>I have written them down somewhere safe.</span>
        </label>

        <button
          type="button"
          // Gated on having ticked it rather than on a dialog. Somebody who has
          // not saved the words must not be one tap from losing their history.
          disabled={saving || (state.step === 'generated' && !state.written)}
          onClick={() => void confirm(key)}
        >
          {saving ? 'Taking custody…' : 'This key is mine now'}
        </button>
      </section>
    )
  }

  return (
    <section className="panel custody">
      <h2>Your key</h2>
      <p>
        Right now we hold the key to your records. That is what lets you use this without a
        wallet, and it means we could read them.
      </p>
      <p>
        You can take that key instead. We will keep writing your records and stop being able to
        open them.
      </p>
      <p className="muted">
        The trade is real: there is no reset. Lose the words and your past records stay closed
        for good.
      </p>
      <button type="button" className="quiet" onClick={() => void generate()}>
        Take my key
      </button>
    </section>
  )
}
