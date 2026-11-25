import { useEffect, useState } from 'react'
import { DEFAULT_CAPS, HARNESSES, HARNESS_ORDER, agentInviteUrl, uniqueName, type AgentMode, type HarnessId, type Instructors } from '@beamhop/shared'
import { useStore, go } from './hooks'
import { Avatar, Radio, Switch, TopBar } from './components'
import { Icon } from './icons'
import { PROVIDERS, providerInfo, hasCreds, getCreds, setCreds, clearCreds, listModels, onCredsChange, type ProviderId } from '../agents/providers'
import { startOpenRouterSignIn } from '../agents/openrouter'
import { startGeminiSignIn, finishGeminiSignIn, captureGeminiCode, type GeminiSignIn } from '../agents/gemini'
import { startCopilotSignIn, pollCopilotSignIn, type CopilotDevice } from '../agents/copilot'
import { extCaptureRedirect, extFetch } from '../core/extension'
import { kv } from '../core/kv'
import type { Usage } from '../core/types'
import { ExtensionHelp } from './Settings'
import { AgentMachineCard, HarnessSetup } from './Machine'
import { appBase, bridgeCommand } from './Invite'
import { CopyBox } from './components'
import { copyText } from './hooks'

const EMOJIS = ['🤖', '🦊', '🦉', '🐙', '🧠', '🛰️', '🧪', '📚', '🎨', '🛠️', '🌱', '⚡️', '🐝', '🦄', '🧭', '🎧']

export function AgentsScreen() {
  const s = useStore()
  const agents = s.liveAgents()
  const [ready, setReady] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const f = () => Promise.all(agents.map(async (a) => [a.id, await hasCreds(a.provider)] as const)).then((l) => setReady(Object.fromEntries(l)))
    f()
    return onCredsChange(f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length])
  return (
    <div className="screen">
      <TopBar title="Your agents" onBack={() => go('')}>
        <button className="btn small primary" onClick={() => go('agents/new')}>
          <Icon name="plus" size={16} /> New
        </button>
      </TopBar>
      <div className="scroll">
        <div className="center-col" style={{ paddingBottom: 60 }}>
          <p className="muted small" style={{ marginTop: 16 }}>
            Agents you create run in this browser: fx with your own sign-in, or a coding agent like Claude Code or Codex in a Linux machine inside the tab. Add them to any room. Agents connected from a computer through the bridge show up in the rooms they joined.
          </p>
          {agents.length === 0 ? (
            <div className="empty">
              <div style={{ fontSize: 44 }}>🤖</div>
              <p>No agents yet.</p>
              <button className="btn primary" onClick={() => go('agents/new')}>
                Create your first agent
              </button>
            </div>
          ) : (
            <div className="list">
              {agents.map((a) => {
                const p = providerInfo(a.provider)
                const runs = s.runner.canRunHere(a)
                const onMachine = a.runtime === 'machine'
                return (
                  <button key={a.id} className="list-item" onClick={() => go(`agents/${a.id}`)}>
                    <Avatar pk={a.pk} name={a.name} emoji={a.emoji} agent />
                    <div className="main">
                      <div className="t">{a.name}</div>
                      <div className="s">
                        {onMachine ? `${HARNESSES[a.harness ?? 'claude'].label} · Linux machine` : p.label}
                        {!onMachine && a.model ? ` · ${a.model}` : ''}
                      </div>
                    </div>
                    {runs ? <span className="tag" style={{ color: 'var(--ok)' }}>Ready</span> : onMachine ? <span className="tag warn">Set up</span> : ready[a.id] && p.needsExtension ? <span className="tag warn">Needs extension</span> : <span className="tag warn">Sign in</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function AgentEditor({ id, roomId }: { id: string; roomId?: string }) {
  const s = useStore()
  const isNew = id === 'new'
  const existing = isNew ? undefined : s.agents.find((a) => a.id === id && !a.deleted)
  const [name, setName] = useState(existing?.name ?? 'Claude')
  const [emoji, setEmoji] = useState(existing?.emoji ?? '🤖')
  const [runtime, setRuntime] = useState<'tab' | 'machine' | 'computer'>(existing?.runtime ?? 'tab')
  const [harness, setHarness] = useState<HarnessId>(existing?.harness ?? 'claude')
  const [customCommand, setCustomCommand] = useState(existing?.customCommand ?? '')
  const [provider, setProvider] = useState<ProviderId>(existing?.provider ?? 'openrouter')
  const [model, setModel] = useState(existing?.model ?? providerInfo('openrouter').defaultModel)
  const [instructions, setInstructions] = useState(existing?.instructions ?? '')
  const [web, setWeb] = useState(existing?.tools.web ?? true)
  const [sandbox, setSandbox] = useState(existing?.tools.sandbox ?? true)
  const [mode, setMode] = useState<AgentMode>(existing?.mode ?? 'mention')
  const [instructors, setInstructors] = useState<Instructors>(existing?.instructors ?? 'everyone')
  const [perHour, setPerHour] = useState(existing?.caps.perHour ?? DEFAULT_CAPS.perHour)
  const [maxHops, setMaxHops] = useState(existing?.caps.maxHops ?? DEFAULT_CAPS.maxHops)
  const [models, setModels] = useState<string[]>(providerInfo(provider).models)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [credsTick, setCredsTick] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => onCredsChange(() => setCredsTick((x) => x + 1)), [])
  useEffect(() => {
    let live = true
    setModels(providerInfo(provider).models)
    listModels(provider).then((l) => live && l.length && setModels(l))
    return () => {
      live = false
    }
  }, [provider, credsTick])
  useEffect(() => {
    if (existing) kv.get<Usage>('usage:' + existing.id).then((u) => setUsage(u ?? null))
  }, [existing])

  if (!isNew && !existing)
    return (
      <div className="screen">
        <TopBar title="Agent" onBack={() => go('agents')} />
        <div className="empty">Agent not found.</div>
      </div>
    )

  const pickProvider = (p: ProviderId) => {
    setProvider(p)
    if (!existing || existing.provider !== p) setModel(providerInfo(p).defaultModel)
  }

  const save = async () => {
    setBusy(true)
    try {
      if (runtime === 'computer') return go(roomId ? `r/${roomId}` : 'agents')
      if (runtime === 'machine' && harness === 'custom' && !customCommand.trim()) throw new Error('Enter the command that starts your ACP agent.')
      const patch = {
        name: name.trim() || 'Agent',
        emoji,
        runtime,
        harness: runtime === 'machine' ? harness : undefined,
        customCommand: runtime === 'machine' && harness === 'custom' ? customCommand.trim() : undefined,
        provider,
        model: runtime === 'machine' ? (existing?.model ?? '') : model.trim(),
        instructions,
        tools: { web, sandbox },
        mode,
        instructors,
        caps: { perHour, maxHops },
      }
      if (existing) {
        await s.updateAgent(existing.id, patch)
        // keep room-visible metadata in sync
        for (const rid of s.client.rooms.keys()) {
          const st = s.client.state(rid)
          const cur = st?.agents[existing.pk]
          if (!cur) continue
          // keep the room's name for the agent unique among the room's other people and agents
          const others = { ...st!, agents: Object.fromEntries(Object.entries(st!.agents).filter(([pk]) => pk !== existing.pk)) }
          // only when the user actually renamed it; a room may have given it a numbered name
          const name = patch.name === existing.name ? undefined : uniqueName(others, patch.name)
          const roomModel = runtime === 'machine' ? HARNESSES[harness].label : patch.model
          await s.client.stateOp(rid, { op: 'agent-update', pubkey: existing.pk, emoji, model: roomModel, ...(name ? { name } : {}) }).catch(() => {})
        }
        s.toast('Saved')
        go(roomId ? `r/${roomId}/agent/${existing.pk}` : 'agents')
      } else {
        const def = await s.createAgent(patch)
        if (roomId && s.client.state(roomId)) {
          await s.addAgentToRoom(roomId, def)
          s.toast(`${def.name} joined the room`)
          go(`r/${roomId}`)
        } else go('agents')
      }
    } catch (e: any) {
      s.toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const groups: [string, ProviderId[]][] = [
    ['Your subscriptions', PROVIDERS.filter((p) => p.group === 'subscription').map((p) => p.id)],
    ['API keys', PROVIDERS.filter((p) => p.group === 'key').map((p) => p.id)],
    ['Local & other', PROVIDERS.filter((p) => p.group === 'local').map((p) => p.id)],
  ]

  return (
    <div className="screen">
      <TopBar title={isNew ? 'New agent' : existing!.name} onBack={() => go(roomId ? `r/${roomId}` : 'agents')}>
        <button className="btn small primary" onClick={save} disabled={busy}>
          {runtime === 'computer' ? 'Done' : isNew ? (roomId ? 'Create & add' : 'Create') : 'Save'}
        </button>
      </TopBar>
      <div className="scroll">
        <div className="center-col" style={{ paddingBottom: 80 }}>
          <div className="field">
            <label>Name</label>
            <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value.replace(/\s+/g, ' '))} placeholder="Claude" />
            <div className="hint">People @mention it by this name.</div>
          </div>
          <div className="emoji-row">
            {EMOJIS.map((e) => (
              <button key={e} className={e === emoji ? 'on' : ''} onClick={() => setEmoji(e)}>
                {e}
              </button>
            ))}
          </div>

          <div className="section-title">Where it runs</div>
          <div className="runtime-grid">
            {(
              [
                ['tab', 'In this tab', 'fx in WebAssembly. Starts instantly, works on phones. Sign in with ChatGPT, Copilot, Gemini, OpenRouter or a key.'],
                ['machine', 'Linux machine in this tab', 'Claude Code, Codex, Gemini CLI, OpenCode or fx, unmodified, in a Linux machine inside this browser. Nothing to install.'],
                ['computer', 'On my computer', 'The same agents, run from a terminal on your computer through the Beamhop bridge.'],
              ] as const
            )
              .filter(([k]) => !existing || k !== 'computer')
              .map(([k, t, d]) => (
                <button key={k} className={`provider ${runtime === k ? 'on' : ''}`} onClick={() => setRuntime(k)}>
                  <div className="t">{t}</div>
                  <div className="d">{d}</div>
                </button>
              ))}
          </div>

          {runtime !== 'tab' && (
            <>
              <div className="section-title">Agent</div>
              <div className="provider-grid" style={{ marginBottom: 10 }}>
                {HARNESS_ORDER.map((hid) => (
                  <button key={hid} className={`provider ${harness === hid ? 'on' : ''}`} onClick={() => setHarness(hid)}>
                    <div className="t">{HARNESSES[hid].label}</div>
                    <div className="d">{HARNESSES[hid].blurb}</div>
                  </button>
                ))}
              </div>
              {harness === 'custom' && (
                <div className="field">
                  <label>Command</label>
                  <input className="input mono" value={customCommand} onChange={(e) => setCustomCommand(e.target.value)} placeholder="my-agent --acp" />
                  <div className="hint">Starts a program that speaks the Agent Client Protocol on stdin/stdout.</div>
                </div>
              )}
            </>
          )}

          {runtime === 'machine' && <HarnessSetup harness={harness} customCommand={customCommand} key={harness} />}
          {runtime === 'machine' && existing?.runtime === 'machine' && <AgentMachineCard def={existing} />}

          {runtime === 'computer' && <BridgeCommand roomId={roomId} harness={harness} customCommand={customCommand} />}

          {runtime === 'tab' && (
          <>
          <div className="section-title">Model provider</div>
          {groups.map(([title, ids]) => (
            <div key={title} style={{ marginBottom: 10 }}>
              <div className="small muted" style={{ margin: '6px 2px' }}>
                {title}
              </div>
              <div className="provider-grid">
                {ids.map((pid) => {
                  const p = providerInfo(pid)
                  return (
                    <button key={pid} className={`provider ${provider === pid ? 'on' : ''}`} onClick={() => pickProvider(pid)}>
                      <div className="t">
                        {p.label} {p.needsExtension && <Icon name="puzzle" size={14} />}
                      </div>
                      <div className="d">{p.blurb}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          <ProviderConnect provider={provider} key={provider + credsTick} />

          <div className="field">
            <label>Model</label>
            <input className="input" list="bh-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === 'gateway' ? 'Default model' : 'model id'} />
            <datalist id="bh-models">
              {models.slice(0, 300).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>

          </>
          )}

          {runtime !== 'computer' && (
          <>
          <div className="field">
            <label>Instructions</label>
            <textarea className="input" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="How should it behave? e.g. You are a concise senior engineer. Prefer code over prose." />
          </div>

          {runtime === 'tab' && (
          <>
          <div className="section-title">Tools</div>
          <div className="card stack">
            <div className="row between">
              <div>
                <div style={{ fontWeight: 600 }}>Web search & fetch</div>
                <div className="small muted">Looks things up and reads pages.{!s.hasExtension && provider !== 'gateway' && ' Without the extension, uses the r.jina.ai reader.'}</div>
              </div>
              <Switch checked={web} onChange={setWeb} />
            </div>
            <div className="row between">
              <div>
                <div style={{ fontWeight: 600 }}>Code sandbox</div>
                <div className="small muted">Runs JavaScript and Python in your browser, keeps files per room, shares them as attachments.</div>
              </div>
              <Switch checked={sandbox} onChange={setSandbox} />
            </div>
            <div className="small muted">It always gets the room’s recent messages for context.</div>
          </div>
          </>
          )}

          <div className="section-title">Defaults for new rooms</div>
          <Radio on={mode === 'mention'} title="Speaks when @mentioned" onClick={() => setMode('mention')} />
          <Radio on={mode === 'owner'} title="Only when I tell it to" onClick={() => setMode('owner')} />
          {mode === 'mention' && (
            <div className="row wrap" style={{ margin: '6px 0' }}>
              <span className="small muted">Who can instruct it:</span>
              <div className="seg">
                <button className={instructors === 'everyone' ? 'on' : ''} onClick={() => setInstructors('everyone')}>
                  Everyone
                </button>
                <button className={instructors === 'owner' ? 'on' : ''} onClick={() => setInstructors('owner')}>
                  Only me
                </button>
              </div>
            </div>
          )}

          <div className="section-title">Limits</div>
          <div className="card stack">
            <div className="row between">
              <span>Max replies per hour</span>
              <input className="input" style={{ width: 90 }} type="number" min={1} max={500} value={perHour} onChange={(e) => setPerHour(Math.max(1, Number(e.target.value) || 1))} />
            </div>
            <div className="row between">
              <span>Agent-to-agent hop limit</span>
              <input className="input" style={{ width: 90 }} type="number" min={0} max={10} value={maxHops} onChange={(e) => setMaxHops(Math.max(0, Number(e.target.value) || 0))} />
            </div>
          </div>

          </>
          )}

          {existing && (
            <>
              <div className="section-title">Usage on this device</div>
              <div className="card small">{usage ? `${usage.turns} replies · ${usage.input.toLocaleString()} input tokens · ${usage.output.toLocaleString()} output tokens` : 'No replies yet.'}</div>
              <div className="row wrap" style={{ marginTop: 18 }}>
                <button className="btn" onClick={() => go(`dm/${existing.pk}/${s.pk}`)}>
                  <Icon name="chat" size={18} /> Chat privately
                </button>
                <span className="spacer" />
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!confirm(`Delete ${existing.name}? It leaves every room.`)) return
                    await s.deleteAgent(existing.id)
                    go('agents')
                  }}
                >
                  Delete agent
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** The command that connects `harness` on the owner's computer to the room, through the bridge. */
function BridgeCommand({ roomId, harness, customCommand }: { roomId?: string; harness: HarnessId; customCommand: string }) {
  const s = useStore()
  const inv = roomId ? s.client.agentInvite(roomId) : null
  if (!inv)
    return (
      <div className="card small muted">
        Agents on your computer join one room at a time through its agent link. Open a room, then Invite → Agent → New agent, to get the command for that room.
      </div>
    )
  const link = agentInviteUrl(appBase(), inv)
  const cmd = bridgeCommand(link, harness, customCommand)
  return (
    <>
      <div className="code">
        <div className="code-head">
          <span>terminal</span>
          <button className="btn small ghost" onClick={() => copyText(cmd)}>
            Copy
          </button>
        </div>
        <pre>
          <code>{cmd}</code>
        </pre>
      </div>
      <p className="hint">
        Needs Node.js 22+ and {HARNESSES[harness].label} installed and signed in ({HARNESSES[harness].bridgeInstall}). Keep the terminal open while the agent should be online. It joins
        the room as yours; you set when it speaks from the room.
      </p>
      <div className="label" style={{ margin: '10px 0 6px' }}>
        Agent link
      </div>
      <CopyBox value={link} />
    </>
  )
}

function ProviderConnect({ provider }: { provider: ProviderId }) {
  const s = useStore()
  const p = providerInfo(provider)
  const [creds, setC] = useState<any>(undefined)
  const [key, setKey] = useState('')
  const [base, setBase] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [gem, setGem] = useState<GeminiSignIn | null>(null)
  const [code, setCode] = useState('')
  const [device, setDevice] = useState<CopilotDevice | null>(null)
  const [chatgptSignIn, setChatgptSignIn] = useState<any>(null)

  useEffect(() => {
    getCreds(provider).then((c) => {
      setC(c ?? null)
      setBase((b) => b || ((c as any)?.baseUrl ?? (provider === 'ollama' ? 'http://localhost:11434' : '')))
    })
  }, [provider])

  const run = async (f: () => Promise<void>) => {
    setErr('')
    setBusy(true)
    try {
      await f()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }
  const connected =
    creds &&
    ((provider === 'chatgpt' && creds.accessToken) ||
      (provider === 'copilot' && creds.githubToken) ||
      (provider === 'gemini' && creds.refreshToken) ||
      (['openrouter', 'openai', 'anthropic', 'gemini-key', 'gateway'].includes(provider) && creds.apiKey) ||
      (provider === 'custom' && creds.baseUrl) ||
      provider === 'ollama')

  const needsExt = p.needsExtension && !s.hasExtension
  return (
    <div className="card" style={{ margin: '10px 0' }}>
      <div className="row between">
        <div style={{ fontWeight: 650 }}>{p.label}</div>
        {connected && provider !== 'ollama' && (
          <span className="row small ok">
            <Icon name="check" size={16} /> Connected{creds?.email ? ` · ${creds.email}` : creds?.login ? ` · ${creds.login}` : ''}
          </span>
        )}
      </div>
      <div className="small muted" style={{ margin: '4px 0 8px' }}>
        {p.blurb} Credentials stay on this device.
      </div>
      {p.risk && <div className="small" style={{ color: 'var(--warn)', marginBottom: 8 }}>{p.risk}</div>}
      {needsExt && (
        <div style={{ marginBottom: 8 }}>
          <div className="small err">This needs the Beamhop Companion extension (desktop Chrome, Edge, Brave or Firefox).</div>
          <ExtensionHelp compact />
        </div>
      )}

      {provider === 'openrouter' && (
        <div className="stack">
          {!connected && (
            <button className="btn primary" onClick={() => startOpenRouterSignIn(location.hash)}>
              Sign in with OpenRouter
            </button>
          )}
          <KeyRow value={key} setValue={setKey} placeholder="…or paste an OpenRouter key (sk-or-…)" onSave={() => run(async () => { await setCreds(provider, { apiKey: key.trim() }); setC({ apiKey: key }) })} />
        </div>
      )}

      {['openai', 'anthropic', 'gemini-key', 'gateway'].includes(provider) && (
        <div className="stack">
          <KeyRow value={key} setValue={setKey} placeholder={connected ? 'Replace key' : 'Paste your API key'} onSave={() => run(async () => { await setCreds(provider, { apiKey: key.trim() }); setC({ apiKey: key }); setKey('') })} />
          {p.keyUrl && (
            <a className="small" href={p.keyUrl} target="_blank" rel="noreferrer">
              Get a key →
            </a>
          )}
        </div>
      )}

      {(provider === 'ollama' || provider === 'custom') && (
        <div className="stack">
          <input className="input" placeholder={provider === 'ollama' ? 'http://localhost:11434' : 'https://my-server.example/v1'} value={base} onChange={(e) => setBase(e.target.value)} />
          {provider === 'custom' && <input className="input" placeholder="API key (optional)" value={key} onChange={(e) => setKey(e.target.value)} />}
          <button
            className="btn"
            onClick={() =>
              run(async () => {
                const v = { baseUrl: base.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) }
                await setCreds(provider, v)
                setC(v)
                s.toast('Saved')
              })
            }
          >
            Save
          </button>
        </div>
      )}

      {provider === 'chatgpt' && !connected && !needsExt && (
        <div className="stack">
          {!chatgptSignIn ? (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const { startSignIn, finishSignIn } = await import('libfx/chatgpt')
                  const si = await startSignIn()
                  setChatgptSignIn(si)
                  const addr = await extCaptureRedirect(si.url, 'http://localhost:1455/auth/callback')
                  const c = await finishSignIn(si, addr, { fetch: extFetch as any })
                  await setCreds('chatgpt', c)
                  setC(c)
                  setChatgptSignIn(null)
                })
              }
            >
              Sign in with ChatGPT
            </button>
          ) : (
            <>
              <div className="small muted">Finish signing in in the tab that opened. If it didn’t close by itself, paste the address of the page it ended on:</div>
              <KeyRow
                value={code}
                setValue={setCode}
                placeholder="http://localhost:1455/auth/callback?code=…"
                onSave={() =>
                  run(async () => {
                    const { finishSignIn } = await import('libfx/chatgpt')
                    const c = await finishSignIn(chatgptSignIn, code, { fetch: extFetch as any })
                    await setCreds('chatgpt', c)
                    setC(c)
                    setChatgptSignIn(null)
                  })
                }
              />
            </>
          )}
        </div>
      )}

      {provider === 'copilot' && !connected && !needsExt && (
        <div className="stack">
          {!device ? (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const d = await startCopilotSignIn()
                  setDevice(d)
                  window.open(d.verification_uri, '_blank')
                  const c = await pollCopilotSignIn(d)
                  await setCreds('copilot', c)
                  setC(c)
                  setDevice(null)
                })
              }
            >
              Sign in with GitHub
            </button>
          ) : (
            <div className="card" style={{ textAlign: 'center' }}>
              <div className="small muted">Enter this code at</div>
              <a href={device.verification_uri} target="_blank" rel="noreferrer">
                {device.verification_uri}
              </a>
              <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '.12em', margin: '8px 0' }} className="mono">
                {device.user_code}
              </div>
              <div className="small muted row" style={{ justifyContent: 'center' }}>
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                Waiting for GitHub…
              </div>
            </div>
          )}
        </div>
      )}

      {provider === 'gemini' && !connected && (
        <div className="stack">
          {!gem ? (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const g = await startGeminiSignIn()
                  setGem(g)
                  if (s.hasExtension) {
                    const c0 = await captureGeminiCode(g)
                    const c = await finishGeminiSignIn(g, c0)
                    await setCreds('gemini', c)
                    setC(c)
                    setGem(null)
                  } else window.open(g.url, '_blank')
                })
              }
            >
              Sign in with Google
            </button>
          ) : (
            <>
              <div className="small muted">
                Sign in in the tab that opened. Google then shows an authorization code: copy it and paste it here.{' '}
                <a href={gem.url} target="_blank" rel="noreferrer">
                  Open the sign-in page again
                </a>
              </div>
              <KeyRow
                value={code}
                setValue={setCode}
                placeholder="Authorization code"
                onSave={() =>
                  run(async () => {
                    const c = await finishGeminiSignIn(gem, code)
                    await setCreds('gemini', c)
                    setC(c)
                    setGem(null)
                  })
                }
              />
            </>
          )}
        </div>
      )}

      {busy && <div className="small muted" style={{ marginTop: 6 }}>Working…</div>}
      {err && <div className="err" style={{ marginTop: 6 }}>{err}</div>}
      {connected && provider !== 'ollama' && (
        <button
          className="btn small ghost danger"
          style={{ marginTop: 8 }}
          onClick={async () => {
            await clearCreds(provider)
            setC(null)
          }}
        >
          Sign out
        </button>
      )}
    </div>
  )
}

function KeyRow({ value, setValue, placeholder, onSave }: { value: string; setValue: (v: string) => void; placeholder: string; onSave: () => void }) {
  return (
    <div className="copy-box">
      <input className="input" type="password" autoComplete="off" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value.trim() && onSave()} />
      <button className="btn" disabled={!value.trim()} onClick={onSave}>
        Save
      </button>
    </div>
  )
}
