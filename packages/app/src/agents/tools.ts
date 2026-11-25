import { formatTranscript, uploadEncrypted, type FileRef } from '@beamhop/shared'
import { extFetch, extensionVersion } from '../core/extension'
import { formatRun, sandboxFor } from './sandbox'
import type { Store } from '../core/store'
import type { AgentDef } from '../core/types'

export interface ToolCtx {
  roomId?: string
  dm?: boolean
}

function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,noscript,svg,iframe,nav,footer').forEach((n) => n.remove())
  const title = doc.title ? `# ${doc.title}\n\n` : ''
  return title + (doc.body?.innerText || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
}

export async function webFetchText(url: string): Promise<string> {
  if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs')
  if (extensionVersion()) {
    const r = await extFetch(url, { headers: { accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' } })
    const type = r.headers.get('content-type') ?? ''
    const body = await r.text()
    const text = type.includes('html') ? htmlToText(body) : body
    return `HTTP ${r.status}\n\n` + text.slice(0, 20000)
  }
  const r = await fetch('https://r.jina.ai/' + url, { headers: { accept: 'text/plain' } })
  return (await r.text()).slice(0, 20000)
}

export async function webSearch(query: string): Promise<string> {
  const q = encodeURIComponent(query)
  if (extensionVersion()) {
    const r = await extFetch(`https://html.duckduckgo.com/html/?q=${q}`, { headers: { accept: 'text/html' } })
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html')
    const out: string[] = []
    doc.querySelectorAll('.result').forEach((el) => {
      if (out.length >= 8) return
      const a = el.querySelector('a.result__a') as HTMLAnchorElement | null
      if (!a) return
      let href = a.getAttribute('href') ?? ''
      const m = href.match(/[?&]uddg=([^&]+)/)
      if (m) href = decodeURIComponent(m[1])
      const snip = el.querySelector('.result__snippet')?.textContent?.trim() ?? ''
      out.push(`- ${a.textContent?.trim()}\n  ${href}\n  ${snip}`)
    })
    if (out.length) return out.join('\n')
  }
  const r = await fetch('https://r.jina.ai/https://html.duckduckgo.com/html/?q=' + q, { headers: { accept: 'text/plain' } })
  return (await r.text()).slice(0, 12000)
}

/** libfx tools for one agent. Per-call context carries the room. */
export function makeTools(store: Store, def: AgentDef, pendingFiles: Map<string, FileRef[]>) {
  const tools: any[] = []
  const ws = (ctx: ToolCtx) => sandboxFor(`${def.id}:${ctx.roomId ?? 'dm'}`)
  const ctxOf = (c: any): ToolCtx => (c?.context ?? {}) as ToolCtx

  tools.push({
    name: 'read_room_history',
    description: 'Read the most recent messages in the current room (people and agents), oldest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'How many messages, up to 200. Default 50.' } } },
    idempotent: true,
    writes: false,
    async execute(input: any, c: any) {
      const { roomId } = ctxOf(c)
      if (!roomId) return 'Not in a room (this is a direct message).'
      const st = store.client.state(roomId)!
      return formatTranscript(st, store.client.messages(roomId), def.pk, Math.min(200, Number(input?.limit) || 50)) || '(no messages)'
    },
  })

  if (def.tools.web) {
    if (def.provider === 'gateway') tools.push({ name: 'web_search', providerExecuted: true })
    else
      tools.push({
        name: 'web_search',
        description: 'Search the web. Returns titles, links and snippets.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        idempotent: true,
        writes: false,
        execute: (i: any) => webSearch(String(i.query)),
      })
    tools.push({
      name: 'web_fetch',
      description: 'Fetch a web page or API URL and return its text content.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      idempotent: true,
      writes: false,
      execute: (i: any) => webFetchText(String(i.url)),
    })
  }

  if (def.tools.sandbox) {
    tools.push(
      {
        name: 'list_files',
        description: 'List files in your workspace for this room.',
        inputSchema: { type: 'object', properties: {} },
        idempotent: true,
        writes: false,
        async execute(_: any, c: any) {
          const l = await ws(ctxOf(c)).list()
          return l.length ? l.map((f) => `${f.path} (${f.size} chars)`).join('\n') : '(empty workspace)'
        },
      },
      {
        name: 'read_file',
        description: 'Read a text file from your workspace.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        idempotent: true,
        writes: false,
        execute: async (i: any, c: any) => (await ws(ctxOf(c)).read(String(i.path))).slice(0, 50000),
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a text file in your workspace.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        idempotent: true,
        writes: true,
        async execute(i: any, c: any) {
          await ws(ctxOf(c)).write(String(i.path), String(i.content))
          return `Wrote ${i.path}`
        },
      },
      {
        name: 'run_javascript',
        description:
          'Run JavaScript in an isolated worker. Top-level await works. `console.log` output is returned. Workspace files: fs.readFile(path), fs.writeFile(path, text), fs.listFiles(). `return` a value to see it.',
        inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
        idempotent: false,
        writes: true,
        execute: async (i: any, c: any) => formatRun(await ws(ctxOf(c)).runJs(String(i.code))),
      },
      {
        name: 'run_python',
        description: 'Run Python 3 (Pyodide) in an isolated worker. print() output is returned. The working directory holds your workspace files; files you write there are saved. Common packages (numpy, pandas…) load on import.',
        inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
        idempotent: false,
        writes: true,
        execute: async (i: any, c: any) => formatRun(await ws(ctxOf(c)).runPython(String(i.code))),
      },
      {
        name: 'share_file',
        description: 'Attach a workspace file to your next message in the room (encrypted upload).',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        idempotent: false,
        writes: true,
        async execute(i: any, c: any) {
          const ctx = ctxOf(c)
          if (!ctx.roomId) return 'Files can only be shared in rooms.'
          const path = String(i.path)
          const data = await ws(ctx).read(path)
          const ref = await uploadEncrypted(store.settings.blossom, store.client.signerFor(def.pk), {
            name: path.split('/').pop()!,
            mime: guessMime(path),
            data: new TextEncoder().encode(data),
          })
          const list = pendingFiles.get(ctx.roomId) ?? []
          list.push(ref)
          pendingFiles.set(ctx.roomId, list)
          return `Attached ${path}; it will be included with your reply.`
        },
      },
    )
  }
  return tools
}

export function guessMime(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const m: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', js: 'text/javascript', ts: 'text/plain', py: 'text/x-python', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  }
  return m[ext] ?? 'application/octet-stream'
}
