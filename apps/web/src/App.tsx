/**
 * The shell.
 *
 * Four states, and the important one is that they are resolved from the server
 * rather than from local storage: loading, signed out, signed in but not
 * onboarded, and ready. Trusting localStorage for "am I signed in" is how an
 * app shows a logged-out person a dashboard skeleton for two seconds before
 * bouncing them to a login screen.
 */

import { useCallback, useEffect, useState } from 'react'
import { Onboarding } from './screens/Onboarding.tsx'
import { SignIn } from './screens/SignIn.tsx'
import { Today } from './screens/Today.tsx'
import { MealFlow } from './screens/MealFlow.tsx'
import { Chat } from './screens/Chat.tsx'
import { Coach } from './screens/Coach.tsx'
import { You } from './screens/You.tsx'
import {
  api,
  clearToken,
  flushQueue,
  isAuthFailure,
  lastKnownSession,
  queueLength,
  storeSession,
  SESSION_EXPIRED,
} from './lib/api.ts'
import './app.css'

type Tab = 'today' | 'coach' | 'chat' | 'you'

type Auth =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'onboarding' }
  | { state: 'ready' }

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'loading' })
  const [tab, setTab] = useState<Tab>('today')
  const [capturing, setCapturing] = useState(false)
  const [pending, setPending] = useState(queueLength())
  const [refreshKey, setRefreshKey] = useState(0)

  /** Ask the server who we are. The only source of truth for session state. */
  const resolveSession = useCallback(async () => {
    try {
      const me = await api.me()
      // Recorded before anything can be queued, so a meal logged offline is
      // attributable to the person who logged it rather than to whoever is
      // holding the phone when it finally sends.
      storeSession(me.user.id, me.onboarded)
      setAuth({ state: me.onboarded ? 'ready' : 'onboarding' })
      return
    } catch (error) {
      /*
       * A 401 means signed out. Anything else means we could not ask.
       *
       * Treating both the same put somebody who reloaded the app underground
       * on the sign-in screen — where they could not sign in either, because
       * that needs the network too, and could not log the meal in front of
       * them. The offline queue exists for precisely that moment and was
       * unreachable in it.
       *
       * So when the network is the problem and we still hold a token, the app
       * opens on what we last knew. Reads come from the service worker cache,
       * writes queue, and the first genuine 401 from anywhere signs them out
       * properly through the listener below.
       */
      if (!isAuthFailure(error)) {
        const known = lastKnownSession()
        if (known) {
          setAuth({ state: known.onboarded ? 'ready' : 'onboarding' })
          return
        }
      }

      clearToken()
      setAuth({ state: 'signed-out' })
    }
  }, [])

  useEffect(() => {
    void resolveSession()
  }, [resolveSession])

  // A 401 anywhere signs us out here, once, rather than in every screen.
  useEffect(() => {
    const onExpired = () => {
      clearToken()
      setAuth({ state: 'signed-out' })
    }
    window.addEventListener(SESSION_EXPIRED, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED, onExpired)
  }, [])

  // Replay anything logged offline as soon as we are back — but only while
  // signed in, because the queue drains through authenticated endpoints.
  useEffect(() => {
    if (auth.state !== 'ready') return

    const sync = () => {
      void flushQueue().then(({ sent, remaining }) => {
        setPending(remaining)
        if (sent > 0) setRefreshKey((key) => key + 1)
      })
    }

    sync()
    window.addEventListener('online', sync)
    return () => window.removeEventListener('online', sync)
  }, [auth.state])

  if (auth.state === 'loading') {
    return (
      <div className="boot">
        <div className="spinner" aria-hidden="true" />
        <span className="sr-only">Loading</span>
      </div>
    )
  }

  if (auth.state === 'signed-out') {
    return <SignIn onSignedIn={() => void resolveSession()} />
  }

  if (auth.state === 'onboarding') {
    return <Onboarding onDone={() => setAuth({ state: 'ready' })} />
  }

  return (
    <div className="app">
      {pending > 0 && (
        <div className="banner" role="status">
          {pending} meal{pending === 1 ? '' : 's'} waiting to sync. They are saved.
        </div>
      )}

      <main className="main">
        {tab === 'today' && (
          <Today
            key={refreshKey}
            onCapture={() => setCapturing(true)}
            onOpenChat={() => setTab('chat')}
          />
        )}
        {tab === 'coach' && <Coach />}
        {tab === 'chat' && <Chat />}
        {tab === 'you' && (
          <You
            onSignedOut={() => {
              clearToken()
              setAuth({ state: 'signed-out' })
            }}
          />
        )}
      </main>

      <nav className="tabs tabs-5" aria-label="Sections">
        <button
          type="button"
          className={tab === 'today' ? 'tab tab-on' : 'tab'}
          onClick={() => setTab('today')}
          aria-current={tab === 'today' ? 'page' : undefined}
        >
          Today
        </button>
        <button
          type="button"
          className={tab === 'coach' ? 'tab tab-on' : 'tab'}
          onClick={() => setTab('coach')}
          aria-current={tab === 'coach' ? 'page' : undefined}
        >
          Coach
        </button>
        <button type="button" className="capture" onClick={() => setCapturing(true)}>
          <span aria-hidden="true">📷</span>
          <span className="sr-only">Log a meal</span>
        </button>
        <button
          type="button"
          className={tab === 'chat' ? 'tab tab-on' : 'tab'}
          onClick={() => setTab('chat')}
          aria-current={tab === 'chat' ? 'page' : undefined}
        >
          Chat
        </button>
        <button
          type="button"
          className={tab === 'you' ? 'tab tab-on' : 'tab'}
          onClick={() => setTab('you')}
          aria-current={tab === 'you' ? 'page' : undefined}
        >
          You
        </button>
      </nav>

      {capturing && (
        <MealFlow
          onClose={() => setCapturing(false)}
          onLogged={() => {
            setCapturing(false)
            setPending(queueLength())
            setRefreshKey((key) => key + 1)
          }}
        />
      )}
    </div>
  )
}
