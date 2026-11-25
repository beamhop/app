import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDesktop, useStore, go } from './hooks'
import { Avatar, TopBar, clock } from './components'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { peerDisplayName } from './Home'

export function DMScreen({ identity, peer }: { identity: string; peer: string }) {
  const s = useStore()
  const c = s.client
  const desktop = useDesktop()
  // A DM with my agent is stored under the agent's identity; show it from my side.
  const agent = s.agentByPk(identity) ?? s.agentByPk(peer)
  const me = s.pk
  const other = agent ? agent.pk : peer
  const thread = c.dmMessages(me, other)
  const name = agent ? agent.name : peerDisplayName(s, peer)
  const [text, setText] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const busy = agent ? s.runner.status.get(agent.pk) : undefined
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  })
  useEffect(() => {
    if (agent && !s.runner.canRunHere(agent)) s.toast(`${agent.name} isn’t set up on this device. Replies come from your device that has it.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id])
  const send = async () => {
    const t = text.trim()
    if (!t) return
    setText('')
    try {
      await c.sendDM(me, other, t)
    } catch (e: any) {
      s.toast(e.message, 'error')
    }
  }
  return (
    <div className="screen">
      <TopBar
        title={
          <div className="row">
            <Avatar pk={other} name={name} emoji={agent?.emoji} agent={!!agent} size="sm" />
            <div>
              <div className="name">{name}</div>
              <div className="sub">{agent ? 'Your agent · private chat' : 'Direct message · end-to-end encrypted'}</div>
            </div>
          </div>
        }
        onBack={desktop ? undefined : () => go('')}
      >
        {agent && (
          <button className="icon-btn" onClick={() => go(`agents/${agent.id}`)} aria-label="Agent settings">
            <Icon name="settings" />
          </button>
        )}
      </TopBar>
      <div className="chat">
        <div className="messages" ref={box}>
          {thread.length === 0 && <div className="empty small">{agent ? `Ask ${agent.name} anything. Only you can see this chat.` : 'Say hi.'}</div>}
          {thread.map((m, i) => {
            const mine = m.from === me
            const first = i === 0 || thread[i - 1].from !== m.from
            return (
              <div key={m.id} className={`msg ${first ? 'first' : ''} ${mine ? 'mine' : ''} ${!mine && agent ? 'agent' : ''}`}>
                <div className="gutter">{first && <Avatar pk={m.from} name={mine ? s.profile.name : name} emoji={!mine ? agent?.emoji : undefined} agent={!mine && !!agent} size="sm" />}</div>
                <div className="body">
                  {first && (
                    <div className="meta">
                      <span className="who">{mine ? 'You' : name}</span>
                      <span className="time">{clock(m.ms)}</span>
                    </div>
                  )}
                  <div className="bubble">
                    <Markdown text={m.text} />
                  </div>
                </div>
              </div>
            )
          })}
          {busy && (
            <div className="msg agent first">
              <div className="gutter" />
              <div className="status-pill">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                {busy}
              </div>
            </div>
          )}
        </div>
        <div className="composer">
          <div className="bar">
            <textarea
              rows={1}
              placeholder="Message"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && desktop) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <button className="send" disabled={!text.trim()} onClick={send} aria-label="Send">
              <Icon name="send" size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
