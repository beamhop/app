import { useState } from 'react'
import { parseInvite } from '@beamhop/shared'
import { useDesktop, useNow, useStore, go } from './hooks'
import { Avatar, RoomAvatar, Sheet, TopBar, timeAgo } from './components'
import { Icon } from './icons'

export function NameSheet({ onClose, onDone, title = 'What should people call you?' }: { onClose: () => void; onDone: (name: string) => void; title?: string }) {
  const s = useStore()
  const [name, setName] = useState(s.profile.name)
  const submit = async () => {
    if (!name.trim()) return
    await s.setName(name)
    onDone(name.trim())
  }
  return (
    <Sheet onClose={onClose}>
      <h3>{title}</h3>
      <p className="muted">This is your display name in rooms. You can change it later.</p>
      <div className="field">
        <input className="input" autoFocus placeholder="Your name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <button className="btn primary block big" disabled={!name.trim()} onClick={submit}>
        Continue
      </button>
    </Sheet>
  )
}

export function useHopRoom() {
  const s = useStore()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const create = async () => {
    setBusy(true)
    try {
      const id = await s.client.createRoom(s.profile.name)
      go(`r/${id}/invite`)
    } catch (e: any) {
      s.toast(e?.message ?? String(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const hop = () => (s.profile.name ? create() : setAsking(true))
  const sheet = asking ? (
    <NameSheet
      onClose={() => setAsking(false)}
      onDone={() => {
        setAsking(false)
        create()
      }}
    />
  ) : null
  return { hop, sheet, busy }
}

export function Landing() {
  const { hop, sheet, busy } = useHopRoom()
  const [paste, setPaste] = useState(false)
  return (
    <div className="screen">
      <div className="scroll">
        <div className="landing">
          <div className="topbar" style={{ borderBottom: 0, background: 'transparent' }}>
            <div className="brand grow">
              <span className="brand-dot" /> Beamhop
            </div>
            <button className="btn ghost small" onClick={() => setPaste(true)}>
              Have a link?
            </button>
            <button className="icon-btn" onClick={() => go('settings')} aria-label="Settings">
              <Icon name="settings" />
            </button>
          </div>
          <div className="hero">
            <h2>
              <span>Your people.</span>
              <span className="a">Their agents.</span>
              <span>One room.</span>
            </h2>
            <button className="btn primary big" onClick={hop} disabled={busy}>
              Hop a Room
            </button>
            <p className="muted small" style={{ maxWidth: 380 }}>
              Private, end-to-end encrypted rooms over public Nostr relays. Nothing to sign up for, no server in the middle.
            </p>
          </div>
          <div className="works">
            <div className="muted small">Works with the agents you already use</div>
            <div className="chips">
              {['Claude Code', 'Cursor', 'ChatGPT', 'GitHub Copilot', 'Gemini', 'OpenRouter', 'Your own agent'].map((x) => (
                <span key={x} className="chip">
                  {x}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      {sheet}
      {paste && <PasteLinkSheet onClose={() => setPaste(false)} />}
    </div>
  )
}

export function PasteLinkSheet({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState('')
  const [err, setErr] = useState('')
  const open = () => {
    if (v.includes('#/pair/')) {
      location.hash = v.slice(v.indexOf('#'))
      return onClose()
    }
    const inv = parseInvite(v)
    if (!inv) return setErr('That doesn’t look like a Beamhop link.')
    const m = v.match(/#\/(join|agent)\/([A-Za-z0-9_-]+)/)
    go(`${inv.type === 'human' ? 'join' : 'agent'}/${m ? m[2] : v.trim()}`)
    onClose()
  }
  return (
    <Sheet onClose={onClose}>
      <h3>Open a link</h3>
      <p className="muted">Paste a room invite, an agent link or a device pairing link.</p>
      <div className="field">
        <input className="input" autoFocus placeholder="https://…#/join/…" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open()} />
        {err && <div className="err">{err}</div>}
      </div>
      <button className="btn primary block" onClick={open} disabled={!v.trim()}>
        Open
      </button>
    </Sheet>
  )
}

export function Home() {
  const s = useStore()
  const desktop = useDesktop()
  const c = s.client
  const hasAnything = c.rooms.size > 0 || c.pending.size > 0 || c.dmThreads().length > 0
  if (!hasAnything) return <Landing />
  if (desktop)
    return (
      <div className="split">
        <div className="side">
          <RoomList />
        </div>
        <div className="main">
          <div className="empty" style={{ margin: 'auto' }}>
            <div style={{ fontSize: 44 }}>🛸</div>
            <p>Pick a room, or hop a new one.</p>
          </div>
        </div>
      </div>
    )
  return (
    <div className="screen">
      <RoomList />
    </div>
  )
}

export function RoomList({ activeRoom, activeDM }: { activeRoom?: string; activeDM?: string }) {
  const s = useStore()
  const c = s.client
  const now = useNow()
  const { hop, sheet, busy } = useHopRoom()
  const [paste, setPaste] = useState(false)
  const rooms = [...c.rooms.values()]
    .filter((r) => !r.left)
    .map((r) => {
      const st = c.state(r.roomId)
      const msgs = c.messages(r.roomId).filter((m) => m.payload.t === 'msg')
      const last = msgs[msgs.length - 1]
      return { r, st, last, at: last?.ms ?? r.joinedAt * 1000 }
    })
    .sort((a, b) => b.at - a.at)
  const threads = c.dmThreads()
  return (
    <div className="panel" style={{ background: 'var(--bg)' }}>
      <TopBar title={<div className="brand"><span className="brand-dot" /> Beamhop</div>}>
        <button className="icon-btn" onClick={() => setPaste(true)} aria-label="Open link">
          <Icon name="link" />
        </button>
        <button className="icon-btn" onClick={() => go('agents')} aria-label="Agents">
          <Icon name="bot" />
        </button>
        <button className="icon-btn" onClick={() => go('settings')} aria-label="Settings">
          <Icon name="settings" />
        </button>
      </TopBar>
      <div className="scroll">
        <div style={{ padding: '4px 12px 100px' }}>
          {s.installPrompt && (
            <div className="card install-banner">
              <div className="grow small">Install Beamhop for a full-screen app.</div>
              <button
                className="btn small primary"
                onClick={async () => {
                  s.installPrompt.prompt()
                  s.installPrompt = null
                  s.bump()
                }}
              >
                Install
              </button>
            </div>
          )}
          {c.pending.size > 0 && (
            <>
              <div className="section-title">Waiting to join</div>
              <div className="list">
                {[...c.pending.values()].map((p) => (
                  <button key={p.roomId} className="list-item pending-row" onClick={() => go(`join/lobby/${p.roomId}`)}>
                    <div className="avatar emoji">⏳</div>
                    <div className="main">
                      <div className="t">{p.name}</div>
                      <div className="s">{p.denied ? 'Not admitted' : `Waiting for ${p.host} to let you in`}</div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="row between">
            <div className="section-title">Rooms</div>
            <button className="btn small" onClick={hop} disabled={busy} style={{ marginTop: 8 }}>
              <Icon name="plus" size={16} /> Hop a room
            </button>
          </div>
          {rooms.length === 0 ? (
            <div className="empty small">No rooms yet.</div>
          ) : (
            <div className="list">
              {rooms.map(({ r, st, last, at }) => {
                const unread = c.unreadCount(r.roomId)
                const preview = last
                  ? `${last.pubkey === s.pk ? 'You' : c.nameOf(r.roomId, last.pubkey)}: ${(last.payload as any).text?.replace(/\s+/g, ' ').slice(0, 80) ?? ''}`
                  : st?.closed
                    ? 'Room closed'
                    : 'No messages yet'
                return (
                  <button key={r.roomId} className={`list-item ${activeRoom === r.roomId ? 'active' : ''}`} onClick={() => go(`r/${r.roomId}`)}>
                    <RoomAvatar emoji={st?.emoji ?? '💬'} color={st?.color ?? '#888'} />
                    <div className="main">
                      <div className="t">{st?.name ?? 'Room'}</div>
                      <div className="s">{preview}</div>
                    </div>
                    <div className="stack" style={{ alignItems: 'flex-end', gap: 4 }}>
                      <span className="tiny faint">{timeAgo(at, now)}</span>
                      {unread > 0 && activeRoom !== r.roomId && <span className="badge">{unread}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
          {threads.length > 0 && (
            <>
              <div className="section-title">Direct messages</div>
              <div className="list">
                {threads.map((t) => {
                  const agent = s.agentByPk(t.identity) ?? s.agentByPk(t.peer)
                  const peerName = agent ? agent.name : peerDisplayName(s, t.peer)
                  return (
                    <button key={t.identity + t.peer} className={`list-item ${activeDM === t.peer ? 'active' : ''}`} onClick={() => go(`dm/${t.identity}/${t.peer}`)}>
                      <Avatar pk={agent?.pk ?? t.peer} name={peerName} emoji={agent?.emoji} agent={!!agent} />
                      <div className="main">
                        <div className="t">
                          {peerName} {agent && <span className="tag agent">Agent</span>}
                        </div>
                        <div className="s">{t.last.text.slice(0, 80)}</div>
                      </div>
                      <span className="tiny faint">{timeAgo(t.last.ms, now)}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
      {sheet}
      {paste && <PasteLinkSheet onClose={() => setPaste(false)} />}
    </div>
  )
}

export function peerDisplayName(s: ReturnType<typeof useStore>, pk: string) {
  for (const id of s.client.rooms.keys()) {
    const n = s.client.rooms.get(id)?.names[pk]
    if (n) return n
  }
  return pk.slice(0, 8)
}
