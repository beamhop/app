import { useEffect, useState } from 'react'
import { useDesktop, useHash, parseRoute, useStore, go } from './hooks'
import { Toasts } from './components'
import { Home, RoomList } from './Home'
import { RoomScreen } from './Room'
import { JoinScreen } from './Join'
import { AgentLinkScreen } from './AgentLink'
import { AgentsScreen, AgentEditor } from './Agents'
import { SettingsScreen } from './Settings'
import { DMScreen } from './DM'
import { PairScreen } from './Pair'
import { finishOpenRouterSignIn } from '../agents/openrouter'
import { setCreds } from '../agents/providers'

export function App() {
  const s = useStore()
  const hash = useHash()
  const desktop = useDesktop()
  const [boot, setBoot] = useState<string | null>(null)

  useEffect(() => {
    finishOpenRouterSignIn()
      .then(async (r) => {
        if (r) {
          await setCreds('openrouter', { apiKey: r.key })
          s.toast('Signed in with OpenRouter')
        }
      })
      .catch((e) => s.toast(String(e.message ?? e), 'error'))
    s.init().catch((e) => setBoot(String(e?.message ?? e)))
    // no pinch / double-tap zoom on iOS
    const prevent = (e: Event) => e.preventDefault()
    document.addEventListener('gesturestart', prevent)
    document.addEventListener('gesturechange', prevent)
    let lastTouch = 0
    const dbl = (e: TouchEvent) => {
      const now = Date.now()
      if (now - lastTouch < 300 && !(e.target as HTMLElement)?.closest('input,textarea')) e.preventDefault()
      lastTouch = now
    }
    document.addEventListener('touchend', dbl, { passive: false })
    return () => {
      document.removeEventListener('gesturestart', prevent)
      document.removeEventListener('gesturechange', prevent)
      document.removeEventListener('touchend', dbl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (boot) return <div className="splash"><div className="empty">Couldn’t start Beamhop: {boot}</div></div>
  if (!s.ready) return <div className="splash"><div className="brand"><span className="brand-dot" /> Beamhop</div></div>

  const r = parseRoute(hash)
  let content: React.ReactNode
  switch (r.name) {
    case 'r':
      content = <RoomScreen roomId={r.args[0]} panel={r.args[1]} panelArg={r.args[2]} />
      break
    case 'join':
      content = <JoinScreen payload={r.args[0]} roomId={r.args[1]} />
      break
    case 'agent':
      content = <AgentLinkScreen payload={r.args[0]} />
      break
    case 'agents':
      content = r.args[0] ? <AgentEditor id={r.args[0]} roomId={r.args[1]} /> : <AgentsScreen />
      break
    case 'settings':
      content = <SettingsScreen section={r.args[0]} />
      break
    case 'dm':
      content = <DMScreen identity={r.args[0]} peer={r.args[1]} />
      break
    case 'pair':
      content = <PairScreen payload={r.args[0]} />
      break
    default:
      content = <Home />
  }

  const withSidebar = desktop && ['r', 'agents', 'settings', 'dm'].includes(r.name)
  return (
    <div className="app">
      {withSidebar ? (
        <div className="split">
          <div className="side">
            <RoomList activeRoom={r.name === 'r' ? r.args[0] : undefined} activeDM={r.name === 'dm' ? r.args[1] : undefined} />
          </div>
          <div className="main">{content}</div>
        </div>
      ) : (
        <div style={{ position: 'relative', flex: 1 }}>{content}</div>
      )}
      <Toasts />
    </div>
  )
}

export function ensureName(s: ReturnType<typeof useStore>, next: () => void, ask: (cb: () => void) => void) {
  if (s.profile.name) next()
  else ask(next)
}

export { go }
