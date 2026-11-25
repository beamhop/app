import { useState } from 'react'
import { nip19 } from 'nostr-tools'
import { DEFAULT_BLOSSOM, DEFAULT_RELAYS } from '@beamhop/shared'
import { useStore, go, copyText } from './hooks'
import { CopyBox, QR, Sheet, TopBar } from './components'
import { Icon } from './icons'
import { startPairing, type PairingSession } from '../core/pairing'

const REPO = 'https://github.com/beamhop/app'
export const EXT_ZIP = `${REPO}/raw/dist/extension/beamhop-companion.zip`
export const EXT_ZIP_FF = `${REPO}/raw/dist/extension/beamhop-companion-firefox.zip`

export function ExtensionHelp({ compact }: { compact?: boolean }) {
  const s = useStore()
  if (s.hasExtension) return <div className="small ok">Companion extension {s.ext} is installed.</div>
  return (
    <div className="small">
      <ol className="steps">
        <li>
          Download <a href={EXT_ZIP}>beamhop-companion.zip</a> from the repo and unzip it.
        </li>
        <li>
          Open <span className="kbd">chrome://extensions</span> (or edge://, brave://), turn on <b>Developer mode</b>, click <b>Load unpacked</b> and pick the unzipped folder.
        </li>
        <li>Reload Beamhop.</li>
      </ol>
      {!compact && (
        <p className="muted">
          Firefox: download <a href={EXT_ZIP_FF}>beamhop-companion-firefox.zip</a>, unzip, open <span className="kbd">about:debugging#/runtime/this-firefox</span>, click <b>Load Temporary Add-on</b> and pick its <span className="kbd">manifest.json</span>. Firefox removes it when it restarts.
        </p>
      )}
    </div>
  )
}

export function SettingsScreen({ section }: { section?: string }) {
  const s = useStore()
  const [name, setName] = useState(s.profile.name)
  const [relays, setRelays] = useState(s.settings.relays.join('\n'))
  const [blossom, setBlossom] = useState(s.settings.blossom.join('\n'))
  const [reveal, setReveal] = useState(false)
  const [pair, setPair] = useState<PairingSession | null>(null)
  const [importing, setImporting] = useState(false)
  const [danger, setDanger] = useState(false)
  const npub = nip19.npubEncode(s.pk)
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone

  return (
    <div className="screen">
      <TopBar title="Settings" onBack={() => go('')} />
      <div className="scroll">
        <div className="center-col" style={{ paddingBottom: 80 }}>
          <div className="section-title">Profile</div>
          <div className="card">
            <div className="field" style={{ marginTop: 0 }}>
              <label>Display name</label>
              <div className="copy-box">
                <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                <button
                  className="btn"
                  disabled={!name.trim() || name === s.profile.name}
                  onClick={async () => {
                    await s.setName(name)
                    for (const id of s.client.rooms.keys()) if (s.client.state(id)?.members[s.pk]) s.client.stateOp(id, { op: 'profile', name: name.trim() }).catch(() => {})
                    s.toast('Saved')
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>

          <div className="section-title">Your devices</div>
          <div className="card stack">
            <div className="small muted">Use Beamhop on your phone and computer with the same rooms and agents. Your agents answer from whichever of your devices is online.</div>
            <div className="row wrap">
              <button className="btn primary" onClick={async () => setPair(await startPairing(s))}>
                <Icon name="phone" size={18} /> Add another device
              </button>
              <button className="btn" onClick={() => setImporting(true)}>
                <Icon name="key" size={18} /> Use an existing key
              </button>
            </div>
          </div>

          <div className="section-title">Identity</div>
          <div className="card stack">
            <div className="small muted">Your Nostr public key. Created on this device; nobody else holds it.</div>
            <CopyBox value={npub} />
            {!reveal ? (
              <button className="btn" onClick={() => setReveal(true)}>
                Back up secret key
              </button>
            ) : (
              <>
                <div className="small err">Anyone with this key can read your rooms and act as you. Store it somewhere safe.</div>
                <CopyBox value={nip19.nsecEncode(s.sk)} />
              </>
            )}
          </div>

          <div className="section-title">Companion extension</div>
          <div className="card stack">
            <div className="small muted">Lets browser agents use your ChatGPT and GitHub Copilot plans, makes Google sign-in one click, and gives agents full web access. It runs only on Beamhop pages and sends nothing anywhere else.</div>
            <ExtensionHelp />
          </div>

          <div className="section-title">Install app</div>
          <div className="card small">
            {standalone ? (
              'Beamhop is installed.'
            ) : s.installPrompt ? (
              <button
                className="btn primary"
                onClick={() => {
                  s.installPrompt.prompt()
                  s.installPrompt = null
                  s.bump()
                }}
              >
                Install Beamhop
              </button>
            ) : isIOS ? (
              <>Tap the Share button in Safari, then “Add to Home Screen”.</>
            ) : (
              <>Use your browser’s “Install app” or “Add to Home screen” menu item.</>
            )}
          </div>

          <div className="section-title">Relays</div>
          <div className="card stack">
            <div className="small muted">Public Nostr relays carry your encrypted messages. One per line. Rooms remember the relays they were created with.</div>
            <textarea className="input mono" rows={5} value={relays} onChange={(e) => setRelays(e.target.value)} />
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  const list = relays.split(/\s+/).map((x) => x.trim()).filter((x) => /^wss?:\/\//.test(x))
                  if (!list.length) return s.toast('Add at least one wss:// relay', 'error')
                  s.saveSettings({ relays: list })
                  s.toast('Saved')
                }}
              >
                Save
              </button>
              <button className="btn ghost" onClick={() => setRelays(DEFAULT_RELAYS.join('\n'))}>
                Reset
              </button>
            </div>
          </div>

          <div className="section-title">File servers</div>
          <div className="card stack">
            <div className="small muted">Blossom servers store encrypted attachments. Files are encrypted before upload.</div>
            <textarea className="input mono" rows={3} value={blossom} onChange={(e) => setBlossom(e.target.value)} />
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  const list = blossom.split(/\s+/).map((x) => x.trim()).filter((x) => /^https:\/\//.test(x))
                  if (!list.length) return s.toast('Add at least one https:// server', 'error')
                  s.saveSettings({ blossom: list })
                  s.toast('Saved')
                }}
              >
                Save
              </button>
              <button className="btn ghost" onClick={() => setBlossom(DEFAULT_BLOSSOM.join('\n'))}>
                Reset
              </button>
            </div>
          </div>

          <div className="section-title">About</div>
          <div className="card small muted">
            Beamhop runs entirely in your browser. No account, no Beamhop server: rooms are end-to-end encrypted and travel over public Nostr relays.{' '}
            <a href={REPO} target="_blank" rel="noreferrer">
              Source on GitHub
            </a>
            . Build {__BUILD__}.
          </div>

          <div className="section-title">Danger zone</div>
          <button className="btn danger block" onClick={() => setDanger(true)}>
            Delete account & data
          </button>
        </div>
      </div>
      {pair && <PairSheet session={pair} onClose={() => (pair.close(), setPair(null))} />}
      {importing && <ImportSheet onClose={() => setImporting(false)} />}
      {danger && (
        <Sheet onClose={() => setDanger(false)}>
          <h3>Delete everything?</h3>
          <p className="muted">You leave every room (admin rooms are handed to another member), deletion requests go to relays, and all data on this device is erased. This can’t be undone.</p>
          <div className="row end">
            <button className="btn" onClick={() => setDanger(false)}>
              Cancel
            </button>
            <button className="btn danger solid" onClick={() => s.deleteEverything()}>
              Delete
            </button>
          </div>
        </Sheet>
      )}
      {section === 'x' && null}
    </div>
  )
}

function PairSheet({ session, onClose }: { session: PairingSession; onClose: () => void }) {
  const [state, setState] = useState(session.state)
  session.onState = setState
  return (
    <Sheet onClose={onClose}>
      <h3>Add another device</h3>
      {state === 'done' ? (
        <>
          <p className="ok">Paired. The other device is loading your rooms.</p>
          <button className="btn primary block" onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <>
          <p className="muted">Scan this with the other device’s camera, or open the link there. Keep this screen open until it finishes.</p>
          <div style={{ textAlign: 'center', margin: '10px 0' }}>
            <QR value={session.url} />
          </div>
          <CopyBox value={session.url} />
          <p className="hint">The link works once, for 10 minutes. Your key is sent end-to-end encrypted to the device that opens it.</p>
        </>
      )}
    </Sheet>
  )
}

function ImportSheet({ onClose }: { onClose: () => void }) {
  const s = useStore()
  const [v, setV] = useState('')
  const [err, setErr] = useState('')
  const doImport = async () => {
    try {
      let hex = v.trim()
      if (hex.startsWith('nsec')) {
        const d = nip19.decode(hex)
        if (d.type !== 'nsec') throw new Error('not an nsec')
        hex = Array.from(d.data as Uint8Array, (b) => b.toString(16).padStart(2, '0')).join('')
      }
      if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Paste an nsec… key or 64 hex characters')
      await s.replaceIdentity(hex.toLowerCase())
    } catch (e: any) {
      setErr(e.message)
    }
  }
  return (
    <Sheet onClose={onClose}>
      <h3>Use an existing key</h3>
      <p className="muted">This replaces the identity on this device. Rooms and agents tied to the current key disappear from this device.</p>
      <div className="field">
        <input className="input mono" placeholder="nsec1…" value={v} onChange={(e) => setV(e.target.value)} />
        {err && <div className="err">{err}</div>}
      </div>
      <button className="btn danger solid block" disabled={!v.trim()} onClick={doImport}>
        Replace identity
      </button>
      <button className="btn ghost block" style={{ marginTop: 6 }} onClick={() => copyText(s.exportNsec())}>
        Copy the current key first
      </button>
    </Sheet>
  )
}
