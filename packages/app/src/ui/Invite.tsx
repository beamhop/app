import { useEffect, useState } from 'react'
import { agentInviteUrl, humanInviteUrl, isAdmin } from '@beamhop/shared'
import { useStore, go, copyText } from './hooks'
import { Avatar, CopyBox, QR, Sheet } from './components'
import { Icon } from './icons'

export const appBase = () => location.origin + location.pathname

export function bridgeCommands(link: string) {
  const q = `"${link}"`
  const pkg = 'github:beamhop/app#dist'
  return [
    { id: 'fx', label: 'fx', cmd: `npx -y ${pkg} ${q} --agent fx`, note: 'Runs the fx CLI on your machine (fx login codex for a ChatGPT plan).' },
    { id: 'claude', label: 'Claude Code', cmd: `npx -y ${pkg} ${q} --agent claude`, note: 'Runs Claude Code (through its ACP adapter) with your Claude plan.' },
    { id: 'gemini', label: 'Gemini CLI', cmd: `npx -y ${pkg} ${q} --agent gemini`, note: 'Runs Gemini CLI with your Google account.' },
    { id: 'codex', label: 'Codex', cmd: `npx -y ${pkg} ${q} --agent codex`, note: 'Runs Codex CLI (through its ACP adapter) with your ChatGPT plan.' },
    {
      id: 'mcp',
      label: 'MCP (Cursor…)',
      cmd: `claude mcp add beamhop -- npx -y ${pkg} mcp ${q}`,
      note: 'Gives Claude Code, Cursor or any MCP client tools to read and post in this room. For Cursor, add the same command as a stdio MCP server.',
    },
  ]
}

export function AgentLinkCard({ roomId, compact }: { roomId: string; compact?: boolean }) {
  const s = useStore()
  const inv = s.client.agentInvite(roomId)
  const [waiting, setWaiting] = useState(false)
  useEffect(() => s.client.on('agent-joined', (e) => e.roomId === roomId && setWaiting(false)), [s, roomId])
  if (!inv) return null
  const url = agentInviteUrl(appBase(), inv)
  return (
    <div>
      <div className="label" style={{ margin: '10px 0 6px' }}>
        Your agent link
      </div>
      <CopyBox value={url} onCopy={() => setWaiting(true)} />
      <p className="hint">
        Open it here to add a browser agent, or paste it into Claude Code, Cursor, fx or your own agent with the Beamhop bridge. The agent reads it, joins this room and shows up as yours. One link works for all your agents.
      </p>
      {waiting && (
        <div className="row small muted">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          Waiting for an agent to use the link…
        </div>
      )}
      {compact ? null : null}
    </div>
  )
}

export function InviteSheet({ roomId, tab: initial, onClose }: { roomId: string; tab: 'human' | 'agent'; onClose: () => void }) {
  const s = useStore()
  const c = s.client
  const st = c.state(roomId)!
  const [tab, setTab] = useState(initial)
  const [qr, setQr] = useState(false)
  const [cli, setCli] = useState('fx')
  const admin = isAdmin(st, s.pk)
  const human = c.humanInvite(roomId)
  const humanUrl = human ? humanInviteUrl(appBase(), human) : ''
  const agentInv = c.agentInvite(roomId)
  const agentUrl = agentInv ? agentInviteUrl(appBase(), agentInv) : ''
  const mine = Object.entries(st.agents).filter(([, a]) => a.owner === s.pk)
  const available = s.liveAgents().filter((a) => !st.agents[a.pk])
  const cmds = bridgeCommands(agentUrl)
  const cmd = cmds.find((x) => x.id === cli)!

  return (
    <Sheet onClose={onClose}>
      <div className="row between">
        <h3>{tab === 'human' ? 'Invite your crew.' : 'Bring your agents.'}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="seg" style={{ margin: '8px 0 6px' }}>
        <button className={tab === 'human' ? 'on' : ''} onClick={() => setTab('human')}>
          Human
        </button>
        <button className={tab === 'agent' ? 'on' : ''} onClick={() => setTab('agent')}>
          Agent
        </button>
      </div>

      {tab === 'human' && (
        <>
          <div className="label" style={{ margin: '12px 0 6px' }}>
            Room link
          </div>
          <CopyBox value={humanUrl} />
          <p className="hint">Send this to people you want in the room. They wait in the lobby until {admin ? 'you let them in' : 'an admin lets them in'}.</p>
          <div className="row wrap">
            {'share' in navigator && (
              <button className="btn" onClick={() => navigator.share({ title: `Join ${st.name} on Beamhop`, url: humanUrl }).catch(() => {})}>
                <Icon name="share" size={18} /> Share
              </button>
            )}
            <button className="btn" onClick={() => setQr(!qr)}>
              <Icon name="qr" size={18} /> {qr ? 'Hide QR' : 'QR code'}
            </button>
            {admin && (
              <button
                className="btn ghost"
                onClick={async () => {
                  await c.regenerateLobby(roomId)
                  s.toast('New link created. The old one stopped working.')
                }}
              >
                Reset link
              </button>
            )}
          </div>
          {qr && (
            <div style={{ textAlign: 'center', marginTop: 14 }}>
              <QR value={humanUrl} />
            </div>
          )}
        </>
      )}

      {tab === 'agent' && (
        <>
          <AgentLinkCard roomId={roomId} />
          <div className="section-title">Add a browser agent</div>
          <p className="hint" style={{ marginTop: 0 }}>
            Runs fx in this browser with your own sign-in: ChatGPT, Copilot, Gemini, OpenRouter or an API key.
          </p>
          {available.length > 0 && (
            <div className="list" style={{ marginBottom: 8 }}>
              {available.map((a) => (
                <div key={a.id} className="list-item" style={{ cursor: 'default' }}>
                  <Avatar pk={a.pk} name={a.name} emoji={a.emoji} agent size="sm" />
                  <div className="main">
                    <div className="t">{a.name}</div>
                    <div className="s">{a.model || a.provider}</div>
                  </div>
                  <button
                    className="btn small primary"
                    onClick={async () => {
                      try {
                        await s.addAgentToRoom(roomId, a)
                        s.toast(`${a.name} joined`)
                      } catch (e: any) {
                        s.toast(e.message, 'error')
                      }
                    }}
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn block" onClick={() => go(`agents/new/${roomId}`)}>
            <Icon name="plus" size={16} /> Create a browser agent
          </button>

          <div className="section-title">From your computer</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {cmds.map((x) => (
              <button key={x.id} className={`btn small ${cli === x.id ? 'primary' : ''}`} onClick={() => setCli(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
          <div className="code" style={{ marginTop: 10 }}>
            <div className="code-head">
              <span>terminal</span>
              <button className="btn small ghost" onClick={() => copyText(cmd.cmd)}>
                Copy
              </button>
            </div>
            <pre>
              <code>{cmd.cmd}</code>
            </pre>
          </div>
          <p className="hint">{cmd.note} Needs Node.js 22+. Keep the terminal open while the agent should be online.</p>

          {mine.length > 0 && (
            <>
              <div className="section-title">Your agents ({mine.length})</div>
              {mine.map(([pk, a]) => (
                <div className="person" key={pk}>
                  <Avatar pk={pk} name={a.name} emoji={a.emoji ?? '🤖'} agent size="sm" online={c.onlineAgents(roomId).has(pk)} />
                  <div className="main">
                    <div className="n">{a.name}</div>
                    <div className="s">{a.mode === 'owner' ? 'Speaks when you tell it to' : 'Speaks when @mentioned'}</div>
                  </div>
                  <button className="btn small" onClick={() => go(`r/${roomId}/agent/${pk}`)}>
                    Settings
                  </button>
                </div>
              ))}
            </>
          )}
          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="btn ghost danger small"
              onClick={() => {
                c.revokeAgentLink(roomId)
                s.toast('Agent link revoked. A new one was created.')
              }}
            >
              Revoke agent link
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
