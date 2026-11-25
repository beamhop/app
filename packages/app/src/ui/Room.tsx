import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { downloadDecrypted, uploadEncrypted, isAdmin, type Decoded, type FileRef, type RoomState } from '@beamhop/shared'
import { useDesktop, useMedia, useStore, go, copyText } from './hooks'
import { Avatar, RoomAvatar, Sheet, clock } from './components'
import { Icon } from './icons'
import { Markdown, type MentionName } from './Markdown'
import { PeoplePanel, AgentSettingsPanel } from './People'
import { InviteSheet, AgentLinkCard } from './Invite'
import { LeaveSheet } from './Leave'
import { guessMime } from '../agents/tools'

const QUICK = ['👍', '❤️', '😂', '🎉', '🤔', '👀']

export function RoomScreen({ roomId, panel, panelArg }: { roomId: string; panel?: string; panelArg?: string }) {
  const s = useStore()
  const desktop = useDesktop()
  const wide = useMedia('(min-width: 1200px)')
  const c = s.client
  const st = c.state(roomId)
  const [sidePref, setSidePref] = useState(() => localStorage.getItem('bh-side') !== '0')

  useEffect(() => {
    if (!st && !c.pending.has(roomId)) {
      const t = setTimeout(() => {
        if (!c.state(roomId)) go('', true)
      }, 3000)
      return () => clearTimeout(t)
    }
  }, [st, roomId, c])

  if (!st)
    return (
      <div className="screen">
        <div className="empty" style={{ margin: 'auto' }}>
          Loading room…
        </div>
      </div>
    )

  const close = () => go(`r/${roomId}`)
  const showSidePanel = desktop && (panel === 'people' || panel === 'agent' || (wide && sidePref && !panel) || (wide && sidePref && (panel === 'invite' || panel === 'leave' || panel === 'rename')))
  const togglePeople = () => {
    if (desktop && wide) {
      const v = !(sidePref && !panel) && !(panel === 'people')
      setSidePref(v)
      localStorage.setItem('bh-side', v ? '1' : '0')
      if (panel) go(`r/${roomId}`)
      return
    }
    go(panel === 'people' ? `r/${roomId}` : `r/${roomId}/people`)
  }
  const sideContent =
    panel === 'agent' && panelArg ? (
      <AgentSettingsPanel roomId={roomId} agentPk={panelArg} onBack={() => go(`r/${roomId}/people`)} />
    ) : (
      <PeoplePanel roomId={roomId} onClose={desktop ? togglePeople : close} />
    )

  return (
    <div className="screen" style={desktop ? { flexDirection: 'row' } : undefined}>
      <Chat roomId={roomId} st={st} onPeople={togglePeople} panelOpen={!desktop && (panel === 'people' || panel === 'agent')} />
      {desktop && showSidePanel && <div className="right">{sideContent}</div>}
      {!desktop && (panel === 'people' || panel === 'agent') && <MobilePanel onClose={close}>{sideContent}</MobilePanel>}
      {panel === 'invite' && <InviteSheet roomId={roomId} tab={panelArg === 'agent' ? 'agent' : 'human'} onClose={close} />}
      {panel === 'leave' && <LeaveSheet roomId={roomId} onClose={close} />}
      {panel === 'rename' && <RenameSheet roomId={roomId} st={st} onClose={close} />}
    </div>
  )
}

/** Full-screen panel on phones; swipe right to dismiss. */
function MobilePanel({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const g = useRef<{ x: number; y: number; lock?: 'h' | 'v' } | null>(null)
  return (
    <div
      ref={ref}
      className="overlay-panel peek-shadow"
      style={{ animation: 'slidein .25s cubic-bezier(.2,.8,.2,1)' }}
      onTouchStart={(e) => (g.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchMove={(e) => {
        const p = g.current
        if (!p || !ref.current) return
        const dx = e.touches[0].clientX - p.x
        const dy = e.touches[0].clientY - p.y
        if (!p.lock && Math.abs(dx) + Math.abs(dy) > 10) p.lock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
        if (p.lock === 'h' && dx > 0) {
          ref.current.style.transition = 'none'
          ref.current.style.transform = `translateX(${dx}px)`
        }
      }}
      onTouchEnd={(e) => {
        const p = g.current
        g.current = null
        if (!p || !ref.current) return
        const dx = e.changedTouches[0].clientX - p.x
        ref.current.style.transition = ''
        if (p.lock === 'h' && dx > 80) {
          ref.current.style.transform = 'translateX(100%)'
          setTimeout(onClose, 180)
        } else ref.current.style.transform = ''
      }}
    >
      <style>{`@keyframes slidein { from { transform: translateX(100%) } to { transform: none } }`}</style>
      {children}
    </div>
  )
}

function RenameSheet({ roomId, st, onClose }: { roomId: string; st: RoomState; onClose: () => void }) {
  const s = useStore()
  const [name, setName] = useState(st.name)
  const [emoji, setEmoji] = useState(st.emoji)
  const emojis = ['🛸', '🌿', '🔥', '🎈', '🧪', '🪐', '🍋', '🦊', '🎧', '🧭', '🌊', '⚡️', '📚', '🏗️', '🎨', '🧠']
  const save = async () => {
    await s.client.stateOp(roomId, { op: 'rename', name: name.trim() || st.name, emoji })
    onClose()
  }
  return (
    <Sheet onClose={onClose}>
      <h3>Room name</h3>
      <div className="field">
        <input className="input" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </div>
      <div className="emoji-row">
        {emojis.map((e) => (
          <button key={e} className={e === emoji ? 'on' : ''} onClick={() => setEmoji(e)}>
            {e}
          </button>
        ))}
      </div>
      <div className="row end" style={{ marginTop: 16 }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </div>
    </Sheet>
  )
}

// ------------------------------------------------------------------ chat

interface ViewMsg {
  ev: Decoded
  text: string
  edited: boolean
  deleted: boolean
  reactions: [string, string[]][]
  reply?: Decoded
}

function buildView(msgs: Decoded[]) {
  const byId = new Map(msgs.map((m) => [m.id, m]))
  const edits = new Map<string, string>()
  const dels = new Set<string>()
  const reacts = new Map<string, Map<string, Set<string>>>()
  for (const m of msgs) {
    const p = m.payload
    if (p.t === 'edit' && byId.get(p.target)?.pubkey === m.pubkey) edits.set(p.target, p.text)
    else if (p.t === 'del' && byId.get(p.target)?.pubkey === m.pubkey) dels.add(p.target)
    else if (p.t === 'react' && byId.has(p.target)) {
      const r = reacts.get(p.target) ?? new Map()
      const set = r.get(p.emoji) ?? new Set()
      if (p.remove) set.delete(m.pubkey)
      else set.add(m.pubkey)
      r.set(p.emoji, set)
      reacts.set(p.target, r)
    }
  }
  const out: (ViewMsg | { system: string; ev: Decoded })[] = []
  for (const m of msgs) {
    const p = m.payload
    if (p.t === 'msg') {
      out.push({
        ev: m,
        text: edits.get(m.id) ?? p.text,
        edited: edits.has(m.id),
        deleted: dels.has(m.id),
        reactions: [...(reacts.get(m.id) ?? new Map())].map(([e, set]) => [e, [...set]] as [string, string[]]).filter(([, l]) => l.length),
        reply: p.reply ? byId.get(p.reply) : undefined,
      })
    } else if (p.t === 'state') out.push({ system: '', ev: m })
  }
  return out
}

function systemText(c: ReturnType<typeof useStore>['client'], roomId: string, ev: Decoded): string | null {
  const p = ev.payload as any
  const who = ev.pubkey === c.pk ? 'You' : c.nameOf(roomId, ev.pubkey)
  const target = (pk: string) => (pk === c.pk ? 'you' : c.nameOf(roomId, pk))
  switch (p.op) {
    case 'admit':
      return `${who} let ${p.name} in`
    case 'remove':
      return p.pubkey === ev.pubkey ? `${who} left` : `${who} removed ${target(p.pubkey)}`
    case 'promote':
      return `${who} made ${target(p.pubkey)} an admin`
    case 'rename':
      return `${who} renamed the room to “${p.name}”`
    case 'agent-add':
      return `${p.name} joined as ${ev.pubkey === c.pk ? 'your' : c.nameOf(roomId, ev.pubkey) + '’s'} agent`
    case 'agent-remove':
      return `${target(p.pubkey)} left`
    case 'close':
      return `${who} closed the room`
    case 'lobby':
      return `${who} reset the invite link`
    default:
      return null
  }
}

function Chat({ roomId, st, onPeople, panelOpen }: { roomId: string; st: RoomState; onPeople: () => void; panelOpen: boolean }) {
  const s = useStore()
  const c = s.client
  const desktop = useDesktop()
  const msgs = c.messages(roomId)
  const view = useMemo(() => buildView(msgs), [msgs])
  const people = Object.keys(st.members).length
  const agents = Object.keys(st.agents).length
  const admin = isAdmin(st, s.pk)
  const lobby = admin ? c.lobby(roomId) : []
  const streams = [...(c.streams.get(roomId)?.values() ?? [])].filter((x) => !x.done && Date.now() - x.ts < 120_000)
  const typing = [...(c.typing.get(roomId) ?? [])].filter(([pk, t]) => pk !== s.pk && Date.now() - t < 6000).map(([pk]) => c.nameOf(roomId, pk))
  const online = c.onlineAgents(roomId)
  const names: MentionName[] = useMemo(
    () => [...Object.values(st.members).map((m) => ({ name: m.name, agent: false })), ...Object.values(st.agents).map((a) => ({ name: a.name, agent: true }))],
    [st],
  )
  const [reply, setReply] = useState<Decoded | null>(null)
  const [editing, setEditing] = useState<ViewMsg | null>(null)
  const [actions, setActions] = useState<ViewMsg | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const me = st.members[s.pk]
  const welcomeKey = `bh-welcome-${roomId}`
  const [welcome, setWelcome] = useState(() => !!me && st.createdBy !== s.pk && Date.now() / 1000 - me.joinedAt < 900 && !localStorage.getItem(welcomeKey))

  // edge-swipe right = back to the room list; swipe left = people panel
  const layer = useRef<HTMLDivElement>(null)
  const g = useRef<{ x: number; y: number; edge: boolean; lock?: 'h' | 'v' } | null>(null)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  })
  useEffect(() => {
    c.markRead(roomId)
  }, [msgs.length, roomId, c])
  useEffect(() => {
    atBottom.current = true
    setReply(null)
    setEditing(null)
  }, [roomId])

  const onScroll = () => {
    const el = scroller.current!
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottom.current = near
    setShowJump(!near)
  }

  let lastAuthor = ''
  let lastMs = 0
  let lastDay = ''
  const rendered: React.ReactNode[] = []
  for (const item of view) {
    const day = new Date(item.ev.ms).toDateString()
    if (day !== lastDay) {
      lastDay = day
      lastAuthor = ''
      rendered.push(
        <div className="day-line" key={'d' + day}>
          <span>{new Date(item.ev.ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        </div>,
      )
    }
    if ('system' in item) {
      const t = systemText(c, roomId, item.ev)
      if (t)
        rendered.push(
          <div className="system-line" key={item.ev.id}>
            {t}
          </div>,
        )
      lastAuthor = ''
      continue
    }
    const first = item.ev.pubkey !== lastAuthor || item.ev.ms - lastMs > 5 * 60_000 || !!item.reply
    lastAuthor = item.ev.pubkey
    lastMs = item.ev.ms
    rendered.push(
      <MessageRow
        key={item.ev.id}
        item={item}
        first={first}
        roomId={roomId}
        st={st}
        names={names}
        mine={item.ev.pubkey === s.pk}
        onReply={() => setReply(item.ev)}
        onActions={() => setActions(item)}
        onReact={(e, on) => c.react(roomId, item.ev.id, e, !on)}
        onImage={setLightbox}
        online={online.has(item.ev.pubkey) || c.onlinePeople(roomId).has(item.ev.pubkey)}
      />,
    )
  }

  return (
    <div className="chat" style={{ overflow: 'hidden' }}>
      <div
        ref={layer}
        className="drag-layer"
        onTouchStart={(e) => {
          const t = e.touches[0]
          g.current = { x: t.clientX, y: t.clientY, edge: t.clientX < 28 }
        }}
        onTouchMove={(e) => {
          const p = g.current
          if (!p || desktop || panelOpen || !layer.current) return
          const dx = e.touches[0].clientX - p.x
          const dy = e.touches[0].clientY - p.y
          if (!p.lock && Math.abs(dx) + Math.abs(dy) > 12) p.lock = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'h' : 'v'
          if (p.lock !== 'h') return
          if (dx > 0 && p.edge) layer.current.style.transform = `translateX(${dx}px)`
          if (dx < 0 && !p.edge) layer.current.style.transform = `translateX(${Math.max(dx, -120) / 3}px)`
        }}
        onTouchEnd={(e) => {
          const p = g.current
          g.current = null
          if (!p || !layer.current) return
          const dx = e.changedTouches[0].clientX - p.x
          layer.current.style.transition = 'transform .2s'
          layer.current.style.transform = ''
          setTimeout(() => layer.current && (layer.current.style.transition = ''), 220)
          if (p.lock !== 'h' || desktop || panelOpen) return
          if (p.edge && dx > 90) go('')
          else if (!p.edge && dx < -70) onPeople()
        }}
      >
        <div className="topbar">
          <button className="icon-btn mobile-only" onClick={() => go('')} aria-label="Back">
            <Icon name="back" />
          </button>
          <button className="title-btn grow" onClick={() => (admin ? go(`r/${roomId}/rename`) : onPeople())}>
            <RoomAvatar emoji={st.emoji} color={st.color} size="sm" />
            <div style={{ minWidth: 0 }}>
              <div className="name">{st.name}</div>
              <div className="sub">
                {people} {people === 1 ? 'person' : 'people'} · {agents} {agents === 1 ? 'agent' : 'agents'}
              </div>
            </div>
          </button>
          <button className="icon-btn" onClick={onPeople} aria-label="People & agents">
            <Icon name="people" />
            {lobby.length > 0 && <span className="badge">{lobby.length}</span>}
          </button>
          {!st.closed && (
            <button className="btn small primary desktop-only" onClick={() => go(`r/${roomId}/invite`)}>
              Invite
            </button>
          )}
          {!st.closed && (
            <button className="icon-btn mobile-only" onClick={() => go(`r/${roomId}/invite`)} aria-label="Invite">
              <Icon name="invite" />
            </button>
          )}
        </div>
        {st.closed && <div className="banner-closed">This room was closed by its admin.</div>}
        {lobby.slice(0, 2).map((k) => (
          <div className="notice" key={k.pubkey}>
            <Avatar pk={k.pubkey} name={(k.payload as any).name} size="sm" />
            <div className="main">
              <div className="t">{(k.payload as any).name} wants to join</div>
              <div className="s">Waiting in the lobby</div>
            </div>
            <button className="btn small ghost" onClick={() => c.deny(roomId, k.pubkey)}>
              Deny
            </button>
            <button className="btn small primary" onClick={() => c.admit(roomId, k.pubkey, (k.payload as any).name).catch((e) => s.toast(e.message, 'error'))}>
              Admit
            </button>
          </div>
        ))}
        <div className="messages" ref={scroller} onScroll={onScroll}>
          {welcome && (
            <div className="card welcome-card">
              <h3 style={{ margin: '0 0 4px' }}>You’re in. Bring your agents.</h3>
              <AgentLinkCard roomId={roomId} compact />
              <div className="row end" style={{ marginTop: 10 }}>
                <button
                  className="btn ghost small"
                  onClick={() => {
                    localStorage.setItem(welcomeKey, '1')
                    setWelcome(false)
                  }}
                >
                  Maybe later
                </button>
                <button className="btn small primary" onClick={() => go(`r/${roomId}/invite/agent`)}>
                  Connect an agent
                </button>
              </div>
            </div>
          )}
          {rendered.length === 0 && !welcome && (
            <div className="empty">
              <div style={{ fontSize: 40 }}>{st.emoji}</div>
              <p>
                This is the start of <b>{st.name}</b>.<br />
                <span className="small">Invite people, bring agents, and @mention an agent to get it talking.</span>
              </p>
            </div>
          )}
          {rendered}
          {streams.map((x) => (
            <div className="msg agent first" key={x.sid}>
              <div className="gutter">
                <Avatar pk={x.pubkey} name={c.nameOf(roomId, x.pubkey)} emoji={st.agents[x.pubkey]?.emoji} agent size="sm" />
              </div>
              <div className="body">
                <div className="meta">
                  <span className="who">{c.nameOf(roomId, x.pubkey)}</span>
                  <span className="tag agent">Agent</span>
                  <span className="status-pill">
                    <span className="dots">
                      <i />
                      <i />
                      <i />
                    </span>
                    {x.status ?? 'Writing…'}
                  </span>
                </div>
                {x.text && (
                  <div className="bubble">
                    <Markdown text={x.text} names={names} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="typing">{typing.length ? `${typing.join(', ')} ${typing.length > 1 ? 'are' : 'is'} typing…` : ''}</div>
        {showJump && (
          <button
            className="btn small"
            style={{ position: 'absolute', right: 16, bottom: 120, zIndex: 4, boxShadow: 'var(--shadow)' }}
            onClick={() => {
              atBottom.current = true
              scroller.current!.scrollTop = scroller.current!.scrollHeight
            }}
          >
            ↓ Latest
          </button>
        )}
        {!st.closed && st.members[s.pk] ? (
          <Composer
            roomId={roomId}
            st={st}
            reply={reply}
            editing={editing}
            onClearReply={() => setReply(null)}
            onClearEdit={() => setEditing(null)}
            onSent={() => {
              atBottom.current = true
            }}
          />
        ) : (
          <div className="composer">
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn" onClick={() => s.client.leave(roomId, { wipe: false }).then(() => go(''))}>
                Remove from my list
              </button>
            </div>
          </div>
        )}
      </div>
      {actions && (
        <Sheet onClose={() => setActions(null)} className="action-sheet">
          <div className="quick">
            {QUICK.map((e) => (
              <button
                key={e}
                onClick={() => {
                  const on = actions.reactions.find(([x]) => x === e)?.[1].includes(s.pk)
                  c.react(roomId, actions.ev.id, e, !!on)
                  setActions(null)
                }}
              >
                {e}
              </button>
            ))}
          </div>
          <button
            className="act"
            onClick={() => {
              setReply(actions.ev)
              setActions(null)
            }}
          >
            <Icon name="reply" /> Reply
          </button>
          <button
            className="act"
            onClick={() => {
              copyText(actions.text)
              setActions(null)
            }}
          >
            <Icon name="copy" /> Copy text
          </button>
          {actions.ev.pubkey === s.pk && !actions.deleted && (
            <>
              <button
                className="act"
                onClick={() => {
                  setEditing(actions)
                  setActions(null)
                }}
              >
                <Icon name="edit" /> Edit
              </button>
              <button
                className="act danger"
                onClick={() => {
                  c.deleteMessage(roomId, actions.ev.id)
                  setActions(null)
                }}
              >
                <Icon name="trash" /> Delete
              </button>
            </>
          )}
        </Sheet>
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  )
}

const MessageRow = memo(function MessageRow({
  item,
  first,
  roomId,
  st,
  names,
  mine,
  onReply,
  onActions,
  onReact,
  onImage,
  online,
}: {
  item: ViewMsg
  first: boolean
  roomId: string
  st: RoomState
  names: MentionName[]
  mine: boolean
  onReply: () => void
  onActions: () => void
  onReact: (emoji: string, on: boolean) => void
  onImage: (url: string) => void
  online: boolean
}) {
  const s = useStore()
  const c = s.client
  const ev = item.ev
  const agent = st.agents[ev.pubkey]
  const name = mine ? 'You' : c.nameOf(roomId, ev.pubkey)
  const ownerName = agent ? (agent.owner === s.pk ? 'Your agent' : `${c.nameOf(roomId, agent.owner)}’s agent`) : ''
  const ref = useRef<HTMLDivElement>(null)
  const t = useRef<{ x: number; y: number; timer: any; lock?: 'h' | 'v'; long?: boolean } | null>(null)
  const files = (ev.payload as any).files as FileRef[] | undefined

  return (
    <div
      ref={ref}
      id={'m-' + ev.id}
      className={`msg ${first ? 'first' : ''} ${mine ? 'mine' : ''} ${agent ? 'agent' : ''} ${item.deleted ? 'deleted' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onActions()
      }}
      onTouchStart={(e) => {
        const p: { x: number; y: number; timer: any; long?: boolean } = { x: e.touches[0].clientX, y: e.touches[0].clientY, timer: 0 }
        p.timer = setTimeout(() => {
          p.long = true
          navigator.vibrate?.(10)
          onActions()
        }, 480)
        t.current = p
      }}
      onTouchMove={(e) => {
        const p = t.current
        if (!p || !ref.current) return
        const dx = e.touches[0].clientX - p.x
        const dy = e.touches[0].clientY - p.y
        if (Math.abs(dx) + Math.abs(dy) > 8) clearTimeout(p.timer)
        if (!p.lock && Math.abs(dx) + Math.abs(dy) > 10) p.lock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
        if (p.lock === 'h' && dx > 0 && p.x > 28) {
          e.stopPropagation()
          ref.current.style.transform = `translateX(${Math.min(dx, 90)}px)`
        }
      }}
      onTouchEnd={(e) => {
        const p = t.current
        t.current = null
        if (!p || !ref.current) return
        clearTimeout(p.timer)
        const dx = e.changedTouches[0].clientX - p.x
        ref.current.style.transition = 'transform .18s'
        ref.current.style.transform = ''
        setTimeout(() => ref.current && (ref.current.style.transition = ''), 200)
        if (p.lock === 'h' && dx > 60 && p.x > 28 && !item.deleted) {
          e.stopPropagation()
          navigator.vibrate?.(8)
          onReply()
        }
      }}
    >
      <div className="gutter">{first && <Avatar pk={ev.pubkey} name={c.nameOf(roomId, ev.pubkey)} emoji={agent?.emoji} agent={!!agent} size="sm" online={agent ? online : undefined} />}</div>
      <div className="body">
        {first && (
          <div className="meta">
            <span className="who">{name}</span>
            {agent && <span className="tag agent">Agent</span>}
            {agent && <span className="tiny muted">{ownerName}</span>}
            <span className="time">{clock(ev.ms)}</span>
          </div>
        )}
        {item.reply && (
          <div className="reply-ref" onClick={() => document.getElementById('m-' + item.reply!.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
            ↪ {c.nameOf(roomId, item.reply.pubkey)}: {(item.reply.payload as any).text?.slice(0, 120)}
          </div>
        )}
        <div className="bubble">
          {item.deleted ? 'Message deleted' : <Markdown text={item.text} names={names} />}
          {item.edited && !item.deleted && <span className="edited">(edited)</span>}
          {!item.deleted && files?.length ? (
            <div className="files">
              {files.map((f) => (
                <FileView key={f.sha256} f={f} onImage={onImage} />
              ))}
            </div>
          ) : null}
        </div>
        {item.reactions.length > 0 && (
          <div className="reactions">
            {item.reactions.map(([e, who]) => {
              const on = who.includes(s.pk)
              return (
                <button key={e} className={`reaction ${on ? 'me' : ''}`} title={who.map((p) => c.nameOf(roomId, p)).join(', ')} onClick={() => onReact(e, on)}>
                  {e} {who.length}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <button className="icon-btn desktop-only" style={{ opacity: 0.4, width: 30, height: 30 }} onClick={onActions} aria-label="Message actions">
        <Icon name="more" size={18} />
      </button>
    </div>
  )
})

const blobCache = new Map<string, string>()
function FileView({ f, onImage }: { f: FileRef; onImage: (u: string) => void }) {
  const [url, setUrl] = useState(blobCache.get(f.sha256) ?? '')
  const [err, setErr] = useState('')
  const isImg = f.mime.startsWith('image/')
  const load = async () => {
    if (blobCache.has(f.sha256)) return blobCache.get(f.sha256)!
    const data = await downloadDecrypted(f)
    const u = URL.createObjectURL(new Blob([data as BlobPart], { type: f.mime }))
    blobCache.set(f.sha256, u)
    return u
  }
  useEffect(() => {
    if (isImg && !url) load().then(setUrl).catch((e) => setErr(String(e.message ?? e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.sha256])
  if (isImg && url) return <img className="file-img" src={url} alt={f.name} onClick={() => onImage(url)} />
  return (
    <button
      className="file-chip"
      onClick={async () => {
        try {
          const u = await load()
          const a = document.createElement('a')
          a.href = u
          a.download = f.name
          a.click()
        } catch (e: any) {
          setErr(e.message)
        }
      }}
    >
      <Icon name={err ? 'close' : 'file'} size={18} />
      <span>{f.name}</span>
      <span className="faint tiny">{err || `${Math.max(1, Math.round(f.size / 1024))} KB`}</span>
    </button>
  )
}

// ------------------------------------------------------------------ composer
function Composer({
  roomId,
  st,
  reply,
  editing,
  onClearReply,
  onClearEdit,
  onSent,
}: {
  roomId: string
  st: RoomState
  reply: Decoded | null
  editing: ViewMsg | null
  onClearReply: () => void
  onClearEdit: () => void
  onSent: () => void
}) {
  const s = useStore()
  const c = s.client
  const desktop = useDesktop()
  const draftKey = 'bh-draft-' + roomId
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? '')
  const [files, setFiles] = useState<FileRef[]>([])
  const [uploading, setUploading] = useState(0)
  const [sel, setSel] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileIn = useRef<HTMLInputElement>(null)
  const lastTyping = useRef(0)

  useEffect(() => {
    if (editing) {
      setText(editing.text)
      ta.current?.focus()
    }
  }, [editing])
  useEffect(() => {
    if (reply) ta.current?.focus()
  }, [reply])
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(160, el.scrollHeight) + 'px'
  }, [text])
  useEffect(() => {
    if (!editing) localStorage.setItem(draftKey, text)
  }, [text, editing, draftKey])

  // @mention autocomplete
  const caret = ta.current?.selectionStart ?? text.length
  const before = text.slice(0, caret)
  const m = before.match(/(?:^|\s)@([\w-]*)$/)
  const candidates = m
    ? [
        ...Object.entries(st.agents).map(([pk, a]) => ({ pk, name: a.name, agent: true, emoji: a.emoji, sub: a.owner === s.pk ? 'Your agent' : `${c.nameOf(roomId, a.owner)}’s agent` })),
        ...Object.entries(st.members)
          .filter(([pk]) => pk !== s.pk)
          .map(([pk, mm]) => ({ pk, name: mm.name, agent: false, emoji: undefined as string | undefined, sub: 'Person' })),
      ]
        .filter((x) => x.name.toLowerCase().replace(/\s+/g, '').startsWith(m[1].toLowerCase()))
        .slice(0, 6)
    : []
  const pick = (name: string) => {
    const start = caret - (m ? m[1].length + 1 : 0)
    const next = text.slice(0, start) + '@' + name + ' ' + text.slice(caret)
    setText(next)
    setSel(0)
    requestAnimationFrame(() => {
      const pos = start + name.length + 2
      ta.current?.setSelectionRange(pos, pos)
      ta.current?.focus()
    })
  }

  const send = async () => {
    const t = text.trim()
    if ((!t && !files.length) || uploading) return
    try {
      if (editing) {
        await c.edit(roomId, editing.ev.id, t)
        onClearEdit()
      } else {
        await c.sendMessage(roomId, t, { reply: reply?.id, files })
        onClearReply()
      }
      setText('')
      setFiles([])
      localStorage.removeItem(draftKey)
      onSent()
    } catch (e: any) {
      s.toast(e?.message ?? String(e), 'error')
    }
  }

  const attach = async (list: FileList | null) => {
    if (!list) return
    for (const f of Array.from(list)) {
      if (f.size > 20 * 1024 * 1024) {
        s.toast(`${f.name} is over 20 MB`, 'error')
        continue
      }
      setUploading((n) => n + 1)
      try {
        const ref = await uploadEncrypted(s.settings.blossom, s.sk, { name: f.name, mime: f.type || guessMime(f.name), data: new Uint8Array(await f.arrayBuffer()) })
        setFiles((x) => [...x, ref])
      } catch (e: any) {
        s.toast(e?.message ?? String(e), 'error')
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  return (
    <div className="composer">
      {candidates.length > 0 && (
        <div className="mention-pop">
          {candidates.map((x, i) => (
            <button key={x.pk} className={i === sel ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(x.name)}>
              <Avatar pk={x.pk} name={x.name} emoji={x.emoji} agent={x.agent} size="xs" />
              <b>{x.name}</b>
              <span className="small muted">{x.sub}</span>
            </button>
          ))}
        </div>
      )}
      {(reply || editing) && (
        <div className="ctx">
          <Icon name={editing ? 'edit' : 'reply'} size={16} />
          <span className="grow">{editing ? 'Editing message' : `Replying to ${c.nameOf(roomId, reply!.pubkey)}: ${(reply!.payload as any).text?.slice(0, 80)}`}</span>
          <button
            className="icon-btn"
            style={{ width: 28, height: 28 }}
            onClick={() => {
              if (editing) {
                onClearEdit()
                setText('')
              } else onClearReply()
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {(files.length > 0 || uploading > 0) && (
        <div className="files" style={{ padding: '0 4px 8px' }}>
          {files.map((f) => (
            <span key={f.sha256} className="file-chip">
              <Icon name="file" size={16} />
              <span>{f.name}</span>
              <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setFiles((x) => x.filter((y) => y !== f))}>
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
          {uploading > 0 && <span className="file-chip">Encrypting & uploading…</span>}
        </div>
      )}
      <div className="bar">
        <button className="icon-btn" onClick={() => fileIn.current?.click()} aria-label="Attach file">
          <Icon name="attach" />
        </button>
        <input ref={fileIn} type="file" multiple hidden onChange={(e) => attach(e.target.files).then(() => (e.target.value = ''))} />
        <textarea
          ref={ta}
          rows={1}
          placeholder="Message"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (Date.now() - lastTyping.current > 3000) {
              lastTyping.current = Date.now()
              c.typingPing(roomId)
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault()
              attach(e.clipboardData.files)
            }
          }}
          onKeyDown={(e) => {
            if (candidates.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((x) => (x + 1) % candidates.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((x) => (x - 1 + candidates.length) % candidates.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pick(candidates[Math.min(sel, candidates.length - 1)].name)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && desktop) {
              e.preventDefault()
              send()
            }
            if (e.key === 'Escape') {
              onClearReply()
              if (editing) {
                onClearEdit()
                setText('')
              }
            }
          }}
        />
        <button className="send" disabled={(!text.trim() && !files.length) || uploading > 0} onClick={send} aria-label="Send">
          <Icon name={editing ? 'check' : 'send'} size={20} />
        </button>
      </div>
    </div>
  )
}
