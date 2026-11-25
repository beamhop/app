import { useEffect, useState } from 'react'
import { isAdmin, type AgentMode, type Instructors } from '@beamhop/shared'
import { useStore, go } from './hooks'
import { Avatar, Radio, TopBar } from './components'
import { Icon } from './icons'
import { kv } from '../core/kv'
import type { Usage } from '../core/types'
import { providerInfo } from '../agents/providers'

export function PeoplePanel({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const s = useStore()
  const c = s.client
  const st = c.state(roomId)!
  const admin = isAdmin(st, s.pk)
  const lobby = admin ? c.lobby(roomId) : []
  const onlinePeople = c.onlinePeople(roomId)
  const onlineAgents = c.onlineAgents(roomId)
  const members = Object.entries(st.members).sort(([a], [b]) => (a === s.pk ? -1 : b === s.pk ? 1 : st.admins.includes(b) ? 1 : st.admins.includes(a) ? -1 : 0))
  const agentsOf = (owner: string) => Object.entries(st.agents).filter(([, a]) => a.owner === owner)
  const [confirm, setConfirm] = useState<{ pk: string; name: string; agent?: boolean } | null>(null)

  return (
    <div className="panel">
      <TopBar title="People & agents" onBack={onClose}>
        {!st.closed && (
          <button className="btn small" onClick={() => go(`r/${roomId}/invite`)}>
            Invite
          </button>
        )}
      </TopBar>
      <div className="panel-body">
        {admin && lobby.length > 0 && (
          <>
            <div className="section-title">Lobby ({lobby.length})</div>
            {lobby.map((k) => (
              <div className="person" key={k.pubkey}>
                <Avatar pk={k.pubkey} name={(k.payload as any).name} size="sm" />
                <div className="main">
                  <div className="n">{(k.payload as any).name}</div>
                  <div className="s">Waiting to join</div>
                </div>
                <div className="acts">
                  <button className="btn small ghost" onClick={() => c.deny(roomId, k.pubkey)}>
                    Deny
                  </button>
                  <button className="btn small primary" onClick={() => c.admit(roomId, k.pubkey, (k.payload as any).name).catch((e) => s.toast(e.message, 'error'))}>
                    Admit
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
        <div className="section-title">People & agents</div>
        {members.map(([pk, m]) => (
          <div key={pk}>
            <div className="person">
              <Avatar pk={pk} name={m.name} size="sm" online={onlinePeople.has(pk)} />
              <div className="main">
                <div className="n">
                  {m.name}
                  {pk === s.pk && <span className="muted small">(you)</span>}
                  {st.admins.includes(pk) && <span className="tag admin">Admin</span>}
                </div>
              </div>
              <div className="acts">
                {pk !== s.pk && (
                  <button className="icon-btn" style={{ width: 32, height: 32 }} title="Message" onClick={() => go(`dm/${s.pk}/${pk}`)}>
                    <Icon name="chat" size={18} />
                  </button>
                )}
                {admin && pk !== s.pk && !st.closed && (
                  <>
                    {!st.admins.includes(pk) && (
                      <button className="btn small ghost" onClick={() => c.stateOp(roomId, { op: 'promote', pubkey: pk })}>
                        Make admin
                      </button>
                    )}
                    <button className="btn small danger" onClick={() => setConfirm({ pk, name: m.name })}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            </div>
            {agentsOf(pk).map(([apk, a]) => {
              const mine = a.owner === s.pk
              const def = mine ? s.agentByPk(apk) : undefined
              const on = onlineAgents.has(apk)
              const status = s.runner.status.get(apk)
              return (
                <div className="person sub" key={apk}>
                  <Avatar pk={apk} name={a.name} emoji={a.emoji ?? '🤖'} agent size="sm" online={on} />
                  <div className="main">
                    <div className="n">
                      {a.name} <span className="tag agent">Agent</span>
                    </div>
                    <div className="s">
                      {status ?? (on ? (a.mode === 'owner' ? 'Speaks when its owner asks' : 'Speaks when @mentioned') : 'Offline')}
                      {mine && def && !s.runner.canRunHere(def) && ' · not set up on this device'}
                    </div>
                  </div>
                  <div className="acts">
                    {mine && (
                      <button className="btn small" onClick={() => go(`r/${roomId}/agent/${apk}`)}>
                        Settings
                      </button>
                    )}
                    {!mine && admin && !st.closed && (
                      <button className="btn small danger" onClick={() => setConfirm({ pk: apk, name: a.name, agent: true })}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {pk === s.pk && agentsOf(pk).length === 0 && !st.closed && <div className="person sub s muted small">No agents yet</div>}
          </div>
        ))}
        {!st.closed && (
          <button className="btn block" style={{ marginTop: 14 }} onClick={() => go(`r/${roomId}/invite/agent`)}>
            <Icon name="plus" size={16} /> Connect an agent
          </button>
        )}
        <div className="foot-note">Removing a person also removes their agents. Members only see Settings on their own agents.</div>
        <div className="hr" />
        <button className="btn block danger" onClick={() => go(`r/${roomId}/leave`)}>
          <Icon name="logout" size={16} /> Leave room
        </button>
      </div>
      {confirm && (
        <div className="sheet-backdrop" onClick={() => setConfirm(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="grab" />
            <h3>Remove {confirm.name}?</h3>
            <p className="muted">{confirm.agent ? 'The agent leaves the room.' : 'They and their agents leave the room and can’t read new messages.'}</p>
            <div className="row end">
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn danger solid"
                onClick={async () => {
                  const x = confirm
                  setConfirm(null)
                  try {
                    if (x.agent) await c.removeAgent(roomId, x.pk)
                    else await c.removeMember(roomId, x.pk)
                  } catch (e: any) {
                    s.toast(e.message, 'error')
                  }
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function AgentSettingsPanel({ roomId, agentPk, onBack }: { roomId: string; agentPk: string; onBack: () => void }) {
  const s = useStore()
  const c = s.client
  const st = c.state(roomId)!
  const a = st.agents[agentPk]
  const def = s.agentByPk(agentPk)
  const [mode, setMode] = useState<AgentMode>(a?.mode ?? 'mention')
  const [instr, setInstr] = useState<Instructors>(a?.instructors ?? 'everyone')
  const [selected, setSelected] = useState<string[]>(a?.selected ?? [])
  const [usage, setUsage] = useState<Usage | null>(null)
  useEffect(() => {
    if (def) kv.get<Usage>('usage:' + def.id).then((u) => setUsage(u ?? null))
  }, [def])
  if (!a)
    return (
      <div className="panel">
        <TopBar title="Agent" onBack={onBack} />
        <div className="empty">This agent is no longer in the room.</div>
      </div>
    )
  const mine = a.owner === s.pk
  const others = Object.entries(st.members).filter(([pk]) => pk !== s.pk)
  const save = async () => {
    await c.stateOp(roomId, { op: 'agent-update', pubkey: agentPk, mode, instructors: instr, selected })
    s.toast('Saved')
    onBack()
  }
  return (
    <div className="panel">
      <TopBar title={a.name} onBack={onBack} sub={<span className="tag agent">Agent</span>} />
      <div className="panel-body">
        <div className="person">
          <Avatar pk={agentPk} name={a.name} emoji={a.emoji ?? '🤖'} agent online={c.onlineAgents(roomId).has(agentPk)} />
          <div className="main">
            <div className="n">
              {a.name} <span className="tag agent">Agent</span>
            </div>
            <div className="s">
              {mine ? 'Your agent' : `${c.nameOf(roomId, a.owner)}’s agent`} · {a.kind === 'bridge' ? 'runs on a computer (bridge)' : def ? `${providerInfo(def.provider).label}${def.model ? ' · ' + def.model : ''}` : 'runs in a browser'}
            </div>
          </div>
        </div>
        {mine && (
          <>
            <div className="section-title">When it speaks</div>
            <Radio on={mode === 'mention'} title="Only when @mentioned" desc={`Replies when someone writes @${a.name}`} onClick={() => setMode('mention')} />
            <Radio on={mode === 'owner'} title="Only when I tell it to" desc="Stays quiet until you prompt it" onClick={() => setMode('owner')} />
            {mode === 'mention' && (
              <>
                <div className="section-title">Who can give it instructions</div>
                <Radio on={instr === 'everyone'} title="Everyone in the room" extra={<span className="tag">Default</span>} onClick={() => setInstr('everyone')} />
                <Radio on={instr === 'owner'} title="Only me" onClick={() => setInstr('owner')} />
                <Radio on={instr === 'selected'} title="Selected people" onClick={() => setInstr('selected')} />
                {instr === 'selected' && (
                  <div className="card" style={{ padding: '6px 12px' }}>
                    {others.length === 0 && <div className="muted small">No one else is here yet.</div>}
                    {others.map(([pk, m]) => (
                      <label key={pk} className="row" style={{ padding: '6px 0' }}>
                        <input
                          type="checkbox"
                          checked={selected.includes(pk)}
                          onChange={(e) => setSelected((x) => (e.target.checked ? [...x, pk] : x.filter((y) => y !== pk)))}
                        />
                        {m.name}
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
            {def && (
              <>
                <div className="section-title">This agent</div>
                <div className="card small">
                  {s.runner.canRunHere(def) ? <span className="ok">Ready on this device.</span> : <span className="err">Not set up on this device. Open the agent to sign in.</span>}
                  {usage && (
                    <div className="muted" style={{ marginTop: 6 }}>
                      {usage.turns} replies · {usage.input.toLocaleString()} input / {usage.output.toLocaleString()} output tokens on this device
                    </div>
                  )}
                  <div className="row wrap" style={{ marginTop: 10 }}>
                    <button className="btn small" onClick={() => go(`agents/${def.id}/${roomId}`)}>
                      Model, instructions & tools
                    </button>
                    <button className="btn small" onClick={() => go(`dm/${def.pk}/${s.pk}`)}>
                      Chat privately
                    </button>
                  </div>
                </div>
              </>
            )}
            <div className="row between" style={{ marginTop: 22 }}>
              <button
                className="btn danger"
                onClick={async () => {
                  await c.removeAgent(roomId, agentPk)
                  onBack()
                }}
              >
                Disconnect agent
              </button>
              <button className="btn primary" onClick={save}>
                Save
              </button>
            </div>
          </>
        )}
        {!mine && (
          <p className="muted small" style={{ marginTop: 16 }}>
            {a.mode === 'owner' ? 'Only its owner can prompt it.' : a.instructors === 'everyone' ? `Anyone can @mention ${a.name}.` : a.instructors === 'owner' ? 'Only its owner can instruct it.' : 'Only selected people can instruct it.'}
          </p>
        )}
      </div>
    </div>
  )
}
