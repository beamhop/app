import { useState } from 'react'
import { useStore, go } from './hooks'
import { TopBar } from './components'
import { completePairing, parsePairing } from '../core/pairing'

export function PairScreen({ payload }: { payload: string }) {
  const s = useStore()
  const info = parsePairing(payload)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const hasData = s.client.rooms.size > 0 || s.liveAgents().length > 0
  const pair = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await completePairing(s, payload)
      if (r.sk === s.exportNsec()) {
        s.toast('This device already uses that account')
        go('')
        return
      }
      await s.replaceIdentity(r.sk, r.profile)
    } catch (e: any) {
      setErr(e.message)
      setBusy(false)
    }
  }
  return (
    <div className="screen">
      <TopBar title="Pair this device" onBack={() => go('')} />
      <div className="scroll">
        <div className="center-col" style={{ paddingTop: '10vh' }}>
          {!info ? (
            <p className="err">This pairing link isn’t valid.</p>
          ) : (
            <>
              <h2 style={{ fontSize: 32, letterSpacing: '-0.03em' }}>Use your Beamhop account here?</h2>
              <p className="muted">This device gets your identity, rooms and agents from your other device.</p>
              {hasData && <p className="err small">This device already has its own rooms or agents. Pairing replaces them on this device.</p>}
              <button className="btn primary big block" disabled={busy} onClick={pair}>
                {busy ? 'Pairing…' : 'Pair this device'}
              </button>
              {err && <p className="err">{err}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
