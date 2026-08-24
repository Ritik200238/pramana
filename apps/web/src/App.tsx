import { useCallback, useEffect, useState } from 'react'
import { Onboarding } from './screens/Onboarding.tsx'
import { Today } from './screens/Today.tsx'
import { MealFlow } from './screens/MealFlow.tsx'
import { Chat } from './screens/Chat.tsx'
import { Coach } from './screens/Coach.tsx'
import { flushQueue, queueLength } from './lib/api.ts'
import type { Targets } from './lib/api.ts'
import './app.css'

type Tab = 'today' | 'coach' | 'chat'

const USER_KEY = 'ogt.userId'
const TARGETS_KEY = 'ogt.targets'

export function App() {
  const [userId, setUserId] = useState<string | null>(() => localStorage.getItem(USER_KEY))
  // Kept only to decide whether onboarding is complete. Today fetches the live
  // targets itself, because weight changes and they must not go stale here.
  const [onboardedAt, setOnboardedAt] = useState<string | null>(() =>
    localStorage.getItem(TARGETS_KEY),
  )
  const [tab, setTab] = useState<Tab>('today')
  const [capturing, setCapturing] = useState(false)
  const [pending, setPending] = useState(queueLength())
  const [refreshKey, setRefreshKey] = useState(0)

  // Replay anything logged offline as soon as we are back.
  useEffect(() => {
    const sync = () => {
      void flushQueue().then(({ sent, remaining }) => {
        setPending(remaining)
        if (sent > 0) setRefreshKey((key) => key + 1)
      })
    }
    sync()
    window.addEventListener('online', sync)
    return () => window.removeEventListener('online', sync)
  }, [])

  const onboarded = useCallback((id: string, next: Targets) => {
    localStorage.setItem(USER_KEY, id)
    localStorage.setItem(TARGETS_KEY, JSON.stringify(next))
    setUserId(id)
    setOnboardedAt(JSON.stringify(next))
  }, [])

  if (!userId || !onboardedAt) {
    return <Onboarding onDone={onboarded} />
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
            userId={userId}
            onCapture={() => setCapturing(true)}
            onOpenChat={() => setTab('chat')}
          />
        )}
        {tab === 'coach' && <Coach userId={userId} />}
        {tab === 'chat' && <Chat userId={userId} />}
      </main>

      <nav className="tabs tabs-4" aria-label="Sections">
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
      </nav>

      {capturing && (
        <MealFlow
          userId={userId}
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
