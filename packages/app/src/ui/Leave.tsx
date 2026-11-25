import { useState } from 'react'
import { isAdmin } from '@beamhop/shared'
import { useStore, go } from './hooks'
import { Radio, Sheet } from './components'

export function LeaveSheet({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const s = useStore()
  const c = s.client
  const st = c.state(roomId)!
  const admin = isAdmin(st, s.pk)
  const others = Object.entries(st.members).filter(([pk]) => pk !== s.pk)
  const otherAdmins = st.admins.filter((a) => a !== s.pk)
  const needsHandover = admin && otherAdmins.length === 0 && others.length > 0
  const [mode, setMode] = useState<'keep' | 'kick'>('keep')
  const [next, setNext] = useState(others[0]?.[0] ?? '')
  const [busy, setBusy] = useState(false)
  const leave = async () => {
    setBusy(true)
    try {
      if (admin && mode === 'kick') await c.leave(roomId, { closeRoom: true })
      else await c.leave(roomId, needsHandover ? { newAdmin: next } : {})
      go('', true)
    } catch (e: any) {
      s.toast(e.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Sheet onClose={onClose}>
      <h3>Heading out?</h3>
      {admin ? (
        <>
          <p className="muted">You’re the admin. Your agents leave with you.</p>
          {others.length > 0 && (
            <>
              <Radio on={mode === 'keep'} title="Keep session" desc="The room keeps going." onClick={() => setMode('keep')} />
              <Radio on={mode === 'kick'} title="Kick everyone" desc="Close the room for everyone." onClick={() => setMode('kick')} />
              {mode === 'keep' && needsHandover && (
                <>
                  <div className="section-title">Choose the new admin</div>
                  {others.map(([pk, m]) => (
                    <Radio key={pk} on={next === pk} title={m.name} onClick={() => setNext(pk)} />
                  ))}
                </>
              )}
            </>
          )}
        </>
      ) : (
        <p className="muted">You’ll stop receiving messages from this room. Your agents leave with you.</p>
      )}
      <div className="row end" style={{ marginTop: 16 }}>
        <button className="btn" onClick={onClose}>
          Stay
        </button>
        <button className="btn danger solid" disabled={busy || (mode === 'keep' && needsHandover && !next)} onClick={leave}>
          Leave room
        </button>
      </div>
    </Sheet>
  )
}
