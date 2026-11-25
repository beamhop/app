import { useEffect, useState } from 'react'
import { parseInvite, type HumanInvite } from '@beamhop/shared'
import { useStore, go } from './hooks'
import { TopBar } from './components'

export function JoinScreen({ payload, roomId: lobbyRoom }: { payload: string; roomId?: string }) {
  const s = useStore()
  const c = s.client
  const inv = payload === 'lobby' ? null : (parseInvite(payload) as HumanInvite | null)
  const roomId = inv?.roomId ?? lobbyRoom ?? ''
  const pending = c.pending.get(roomId)
  const inRoom = !!c.state(roomId)?.members[s.pk]
  const [name, setName] = useState(s.profile.name)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (inRoom) go(`r/${roomId}`, true)
  }, [inRoom, roomId])

  if (inv && inv.type !== 'human') return <Invalid />
  if (!inv && !pending) return <Invalid />

  if (pending) {
    return (
      <div className="screen">
        <TopBar title={<div className="brand"><span className="brand-dot" /> Beamhop</div>} onBack={() => go('')} />
        <div className="scroll">
          <div className="center-col" style={{ paddingTop: '12vh', textAlign: 'center' }}>
            {pending.denied ? (
              <>
                <div style={{ fontSize: 48 }}>🚪</div>
                <h2 style={{ fontSize: 34, letterSpacing: '-0.03em', margin: '10px 0' }}>Not this time.</h2>
                <p className="muted">{pending.host} didn’t let you into {pending.name}.</p>
                <button
                  className="btn"
                  onClick={() => {
                    c.cancelKnock(roomId)
                    go('', true)
                  }}
                >
                  Back home
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 48 }} className="dots-big">
                  ⏳
                </div>
                <h2 style={{ fontSize: 40, letterSpacing: '-0.035em', margin: '10px 0' }}>Hang tight.</h2>
                <p className="muted" style={{ fontSize: 17 }}>
                  {pending.host} will see that you’re here. You’ll join <b>{pending.name}</b> automatically.
                </p>
                <div className="card" style={{ display: 'inline-block', margin: '18px 0', textAlign: 'left' }}>
                  <div className="label">Joining as</div>
                  <div style={{ fontWeight: 650, fontSize: 18 }}>{pending.myName}</div>
                </div>
                <p className="small muted">Keep this tab open.</p>
                <button
                  className="btn ghost"
                  onClick={() => {
                    c.cancelKnock(roomId)
                    go('', true)
                  }}
                >
                  Leave lobby
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const ask = async () => {
    if (!name.trim() || !inv) return
    setBusy(true)
    try {
      await s.setName(name)
      await c.knock(inv, name.trim())
    } catch (e: any) {
      s.toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen">
      <TopBar title={<div className="brand"><span className="brand-dot" /> Beamhop</div>} onBack={() => go('')} />
      <div className="scroll">
        <div className="center-col" style={{ paddingTop: '10vh' }}>
          <p className="muted" style={{ margin: 0 }}>
            You’re invited to
          </p>
          <h2 style={{ fontSize: 'clamp(34px, 8vw, 52px)', letterSpacing: '-0.035em', margin: '4px 0 6px', lineHeight: 1.05 }}>{inv!.name}</h2>
          <p className="muted">Hosted by {inv!.host}</p>
          <div className="field" style={{ marginTop: 28 }}>
            <label>Your display name</label>
            <input className="input" autoFocus value={name} placeholder="Your name" maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
          </div>
          <button className="btn primary big block" disabled={!name.trim() || busy} onClick={ask}>
            Ask to join
          </button>
          <p className="hint" style={{ textAlign: 'center', marginTop: 14 }}>
            An admin will let you in. You can connect your agents once you’re inside.
          </p>
        </div>
      </div>
    </div>
  )
}

function Invalid() {
  return (
    <div className="screen">
      <TopBar title="Beamhop" onBack={() => go('')} />
      <div className="empty">
        <p>This invite link isn’t valid.</p>
        <button className="btn" onClick={() => go('')}>
          Go home
        </button>
      </div>
    </div>
  )
}
