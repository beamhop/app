// The Linux machine in the tab, in the UI: setting a harness up, signing in through a terminal,
// and the machine's settings (network relay, storage).
import { useEffect, useRef, useState } from 'react'
import { HARNESSES, type HarnessId } from '@beamhop/shared'
import { useStore } from './hooks'
import { Sheet, Switch } from './components'
import { Icon } from './icons'
import { machine, machineSupported, type MachineConfig } from '../machine/machine'
import type { AgentDef } from '../core/types'

/** Re-render when the machine's state changes. */
function useMachine() {
  const [, set] = useState(0)
  useEffect(() => machine.onChange(() => set((x) => x + 1)), [])
  return machine
}

export function machineNetLabel(c: MachineConfig) {
  return c.net.kind === 'none' ? 'No network' : c.net.kind === 'wisp' ? `Wisp: ${c.net.url}` : `Beamhop proxy: ${c.net.url}`
}

/** Set up `harness` in this device's machine, add an API key, or sign in through a terminal. */
export function HarnessSetup({ harness, customCommand }: { harness: HarnessId; customCommand?: string }) {
  const s = useStore()
  const m = useMachine()
  const h = HARNESSES[harness]
  const sup = machineSupported()
  const [ready, setReady] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [term, setTerm] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    machine.harnessReady(harness).then((r) => live && setReady(r))
    machine.harnessKey(harness).then((k) => live && setHasKey(!!k))
    setLines([])
    setErr('')
    return () => {
      live = false
    }
  }, [harness, m.state])

  if (!sup.ok) return <div className="card small warn-card">{sup.why}</div>

  const setup = async () => {
    setBusy(true)
    setErr('')
    setLines([])
    try {
      await machine.setupHarness(harness, (l) => setLines((x) => [...x, l]), customCommand)
      setReady(true)
      await s.runner.refreshCapabilities()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card stack">
      <div className="row between">
        <div>
          <div style={{ fontWeight: 600 }}>{h.label} on this device</div>
          <div className="small muted">
            {ready ? 'Installed in this browser’s Linux machine.' : 'Not set up on this device yet.'}
            {m.state === 'booting' && ` ${m.stage}…`}
          </div>
        </div>
        <button className={`btn small ${ready ? '' : 'primary'}`} onClick={setup} disabled={busy}>
          {busy ? 'Setting up…' : ready ? 'Reinstall' : 'Set up'}
        </button>
      </div>
      {m.config.net.kind === 'none' && harness !== 'custom' && (
        <div className="small warn-card">
          The machine has no network yet, so it can’t download {h.label} or reach a model. Add a relay under Settings → Linux machine.
        </div>
      )}
      {lines.length > 0 && <pre className="setup-log">{lines.join('\n')}</pre>}
      {err && <pre className="setup-log error">{err}</pre>}
      {h.keyEnv && (
        <div className="field" style={{ margin: 0 }}>
          <label>
            {h.keyEnv.label} <span className="muted small">(optional, stays on this device)</span>
          </label>
          <div className="row">
            <input className="input grow" type="password" value={key} placeholder={hasKey ? '•••••••• saved' : h.keyEnv.placeholder} onChange={(e) => setKey(e.target.value)} />
            <button
              className="btn small"
              disabled={!key && !hasKey}
              onClick={async () => {
                await machine.setHarnessKey(harness, key.trim())
                setHasKey(!!key.trim())
                setKey('')
                s.toast(key.trim() ? 'Key saved on this device' : 'Key removed')
              }}
            >
              {key || !hasKey ? 'Save' : 'Remove'}
            </button>
          </div>
        </div>
      )}
      {h.login && (
        <div className="row between">
          <div className="small muted">Or sign in with your {h.label} account in the machine’s terminal.</div>
          <button className="btn small" disabled={!ready} onClick={() => setTerm(h.login!)}>
            <Icon name="key" size={16} /> Sign in
          </button>
        </div>
      )}
      {term !== null && <TerminalSheet command={term} onClose={() => setTerm(null)} />}
    </div>
  )
}

/**
 * The Linux machine an agent runs in, for its owner: status, the agent's folder, and a terminal
 * there (to look at its files, run commands, or sign the harness in again).
 */
export function AgentMachineCard({ def }: { def: AgentDef }) {
  const m = useMachine()
  const sup = machineSupported()
  const [term, setTerm] = useState<{ command?: string } | null>(null)
  const h = HARNESSES[def.harness ?? 'claude']
  const dir = machine.workDir(def.id)
  return (
    <div className="card stack">
      <div>
        <div style={{ fontWeight: 600 }}>Linux machine</div>
        <div className="small muted">
          {m.state === 'ready' ? 'Running' : m.state === 'booting' ? `${m.stage}…` : m.state === 'error' ? `Error: ${m.error}` : 'Off (starts when needed)'} · {def.name}’s files
          are in <code>{dir}</code>
        </div>
      </div>
      {!sup.ok && <div className="small warn-card">{sup.why}</div>}
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn small" disabled={!sup.ok} onClick={() => setTerm({})}>
          <Icon name="terminal" size={16} /> Open terminal
        </button>
        {h.login && (
          <button className="btn small" disabled={!sup.ok} onClick={() => setTerm({ command: h.login })}>
            <Icon name="key" size={16} /> Sign in to {h.label}
          </button>
        )}
      </div>
      {term && <TerminalSheet cwd={dir} command={term.command} title={`${def.name} · Linux machine`} onClose={() => setTerm(null)} />}
    </div>
  )
}

/**
 * A terminal on the machine (xterm.js on a login shell's pty). Starts in `cwd` (created if missing)
 * and runs `command` first, if given.
 */
export function TerminalSheet({ command, cwd, title = 'Linux machine', onClose }: { command?: string; cwd?: string; title?: string; onClose: () => void }) {
  const el = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let closed = false
    let cleanup = () => {}
    ;(async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      await import('@xterm/xterm/css/xterm.css')
      if (closed || !el.current) return
      const term = new Terminal({ fontSize: 13, cursorBlink: true, convertEol: false, theme: { background: '#111318' } })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(el.current)
      fit.fit()
      term.write('Starting the Linux machine…\r\n')
      const pty = await machine.pty(term.cols, term.rows)
      if (closed) return pty.close()
      pty.onData = (d) => term.write(d)
      pty.onExit = () => term.write('\r\n[session ended]\r\n')
      const sub = term.onData((d) => pty.write(d))
      const onResize = () => {
        fit.fit()
        pty.resize(term.cols, term.rows)
      }
      window.addEventListener('resize', onResize)
      if (cwd) pty.write(`mkdir -p '${cwd}' && cd '${cwd}' && clear\n`)
      if (command) pty.write(command + '\n')
      term.focus()
      cleanup = () => {
        window.removeEventListener('resize', onResize)
        sub.dispose()
        pty.close()
        term.dispose()
      }
    })().catch((e) => setErr(e?.message ?? String(e)))
    return () => {
      closed = true
      cleanup()
    }
  }, [command, cwd])
  return (
    <Sheet onClose={onClose} className="terminal-sheet">
      <div className="row between">
        <h3>{title}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        A shell (as root) in this browser’s Linux machine{cwd ? (
          <>
            , in <code>{cwd}</code>
          </>
        ) : null}
        . Sign-ins and files are kept on this device. Type <code>exit</code> or close this when you’re done.
      </p>
      {err && <div className="small warn-card">{err}</div>}
      <div ref={el} className="terminal" />
    </Sheet>
  )
}

/** Settings → Linux machine. */
export function MachineSettings() {
  const s = useStore()
  const m = useMachine()
  const sup = machineSupported()
  const c = m.config
  const [kind, setKind] = useState(c.net.kind)
  const [url, setUrl] = useState(c.net.kind === 'none' ? '' : c.net.url)
  const [token, setToken] = useState(c.net.kind === 'beamhop' ? (c.net.token ?? '') : '')
  const [ca, setCa] = useState(c.extraCa)
  const [term, setTerm] = useState(false)

  const save = async () => {
    const u = url.trim()
    if (kind !== 'none' && !/^(wss?|https?):\/\//.test(u)) return s.toast('Enter the relay’s address (wss://… or https://…)', 'error')
    await machine.saveConfig({
      net: kind === 'none' ? { kind: 'none' } : kind === 'wisp' ? { kind: 'wisp', url: u } : { kind: 'beamhop', url: u, token: token.trim() || undefined },
      extraCa: ca,
    })
    s.toast(m.state === 'ready' ? 'Saved. Restart the machine to use it.' : 'Saved')
  }

  return (
    <>
      <div className="section-title">Linux machine</div>
      <div className="card stack">
        <div className="small muted">
          Coding agents (Claude Code, Codex, Gemini CLI, OpenCode, fx) run in a real Linux machine inside this tab, compiled to WebAssembly (
          <a href="https://unkernel.dev" target="_blank" rel="noreferrer">
            unkernel
          </a>
          ). It can’t see Beamhop’s keys or storage. Its files stay in this browser.
        </div>
        {!sup.ok && <div className="small warn-card">{sup.why}</div>}
        {m.storageError && <div className="small warn-card">The machine’s files aren’t being saved in this browser: {m.storageError}. Installed agents and sign-ins are lost when the tab closes.</div>}
        <div className="row between">
          <span className="small">
            Status: <b>{m.state === 'ready' ? 'Running' : m.state === 'booting' ? `${m.stage}…` : m.state === 'error' ? 'Error' : 'Off'}</b>
            {m.error && <span className="muted"> · {m.error}</span>}
          </span>
          <div className="row" style={{ gap: 6 }}>
            {m.state === 'ready' ? (
              <button className="btn small" onClick={() => machine.stop()}>
                Stop
              </button>
            ) : (
              <button className="btn small" disabled={!sup.ok || m.state === 'booting'} onClick={() => machine.ensure().catch((e) => s.toast(e.message, 'error'))}>
                Start
              </button>
            )}
            <button className="btn small" disabled={!sup.ok} onClick={() => setTerm(true)}>
              Terminal
            </button>
          </div>
        </div>

        <div className="label">Network relay</div>
        <div className="small muted" style={{ marginTop: -6 }}>
          Browsers can’t open network connections, so the machine’s traffic goes through a relay you choose. TLS stays inside the machine: the relay sees which hosts it
          connects to, not what it sends.
        </div>
        <div className="seg">
          {(['none', 'beamhop', 'wisp'] as const).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'none' ? 'None' : k === 'beamhop' ? 'Beamhop proxy' : 'Wisp server'}
            </button>
          ))}
        </div>
        {kind !== 'none' && (
          <>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={kind === 'wisp' ? 'wss://wisp.example/' : 'https://proxy.example'} />
            {kind === 'beamhop' && <input className="input mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Access token (if the proxy needs one)" />}
            <div className="hint" style={{ marginTop: -4 }}>
              {kind === 'beamhop'
                ? 'Run your own with packages/proxy (Node, Docker or Cloudflare Workers).'
                : 'Any Wisp v1 server. Public ones are run by third parties, who see the hosts the machine connects to.'}
            </div>
          </>
        )}
        <details>
          <summary className="small">Advanced</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <div className="label">Extra trusted certificates</div>
            <textarea className="input mono" rows={3} value={ca} onChange={(e) => setCa(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
            <div className="hint" style={{ marginTop: -4 }}>
              For networks that inspect TLS (some company networks). Leave empty otherwise.
            </div>
            <div className="row between">
              <span className="small">Keep the machine’s files after closing the tab</span>
              <Switch checked={c.persist} onChange={(v) => machine.saveConfig({ persist: v })} />
            </div>
          </div>
        </details>
        <div className="row">
          <button className="btn" onClick={save}>
            Save
          </button>
          <span className="spacer" />
          <button
            className="btn ghost danger small"
            onClick={async () => {
              if (!confirm('Erase the Linux machine? Installed agents, their sign-ins and files on this device are deleted.')) return
              await machine.reset()
              await s.runner.refreshCapabilities()
              s.toast('Machine erased')
            }}
          >
            Erase machine
          </button>
        </div>
      </div>
      {term && <TerminalSheet onClose={() => setTerm(false)} />}
    </>
  )
}
