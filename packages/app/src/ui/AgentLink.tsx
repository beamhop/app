import { useState } from 'react'
import { parseInvite, type AgentInvite } from '@beamhop/shared'
import { useStore, go, copyText } from './hooks'
import { Avatar, TopBar } from './components'
import { Icon } from './icons'
import { bridgeCommands } from './Invite'

/** Someone opened an agent link in the browser. */
export function AgentLinkScreen({ payload }: { payload: string }) {
  const s = useStore()
  const inv = parseInvite(payload) as AgentInvite | null
  const [cli, setCli] = useState('fx')
  if (!inv || inv.type !== 'agent')
    return (
      <div className="screen">
        <TopBar title="Agent link" onBack={() => go('')} />
        <div className="empty">This agent link isn’t valid.</div>
      </div>
    )
  const mineLink = inv.owner === s.pk
  const st = s.client.state(inv.roomId)
  const url = location.href
  const cmds = bridgeCommands(url)
  const cmd = cmds.find((x) => x.id === cli)!
  const available = s.liveAgents().filter((a) => st && !st.agents[a.pk])
  return (
    <div className="screen">
      <TopBar title="Bring your agents" onBack={() => go(st ? `r/${inv.roomId}` : '')} />
      <div className="scroll">
        <div className="center-col" style={{ padding: '16px 16px 60px' }}>
          <h2 style={{ fontSize: 30, letterSpacing: '-0.03em', margin: '6px 0' }}>Agent link for {inv.name}</h2>
          <p className="muted">
            {mineLink ? 'This is your agent link. Agents that use it join the room as yours.' : `This link belongs to ${inv.ownerName}. Agents that use it join as ${inv.ownerName}’s agents.`}
          </p>
          {mineLink && st && (
            <>
              <div className="section-title">Browser agents</div>
              {available.map((a) => (
                <div className="person" key={a.id}>
                  <Avatar pk={a.pk} name={a.name} emoji={a.emoji} agent size="sm" />
                  <div className="main">
                    <div className="n">{a.name}</div>
                    <div className="s">{a.model || a.provider}</div>
                  </div>
                  <button
                    className="btn small primary"
                    onClick={async () => {
                      await s.addAgentToRoom(inv.roomId, a)
                      go(`r/${inv.roomId}`)
                    }}
                  >
                    Add
                  </button>
                </div>
              ))}
              <button className="btn primary block" onClick={() => go(`agents/new/${inv.roomId}`)}>
                <Icon name="plus" size={16} /> Create a browser agent
              </button>
            </>
          )}
          {mineLink && !st && <p className="err">This device isn’t in that room yet. Open Beamhop on the device you used to join, or pair this device in Settings.</p>}
          <div className="section-title">From a computer</div>
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
          <p className="hint">{cmd.note}</p>
        </div>
      </div>
    </div>
  )
}
