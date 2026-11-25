// Beamhop proxy, runtime-neutral core: configuration, access tokens, destination policy, per-token
// limits and the header encoding shared by the Node server, the Workers entry and the browser client.
// Nothing in this file may import a Node, Workers or DOM-only API. See PROTOCOL.md for the contract.

export const PROTOCOL_VERSION = 1
/** WebSocket subprotocol the server selects; the token rides in a second entry `bh1.<token>`. */
export const SUBPROTOCOL = 'bh1'
/** The server stops reading from TCP while the WebSocket send buffer is above this. */
export const WS_HIGH_WATER = 1024 * 1024

/** Close codes the server uses on an established tunnel (PROTOCOL.md does not assign any). */
export const CLOSE_NORMAL = 1000
export const CLOSE_GOING_AWAY = 1001
export const CLOSE_PROTOCOL = 1002
export const CLOSE_REFUSED = 1008
export const CLOSE_UPSTREAM = 1011
export const CLOSE_IDLE = 4001
export const CLOSE_LIMIT = 4002

/**
 * Failure codes. The first six are PROTOCOL.md's. `request` is an addition for malformed requests
 * (missing or invalid host, port, URL or header blob). `proxy` is client-side only: the proxy could
 * not be reached or did not speak the protocol.
 */
export type ProxyErrorCode = 'auth' | 'policy' | 'dns' | 'connect' | 'timeout' | 'limit' | 'request' | 'proxy'

export class ProxyError extends Error {
  readonly code: ProxyErrorCode
  constructor(code: ProxyErrorCode, message: string) {
    super(message)
    this.name = 'ProxyError'
    this.code = code
  }
}

export type Mode = 'tcp' | 'http'
export type HeaderPairs = [string, string][]
export interface PortRange { from: number; to: number }

export interface ProxyConfig {
  /** Accepted access tokens. Ignored when `open` is set. */
  tokens: string[]
  /** No token needed. Never on the public internet. */
  open: boolean
  /** Host patterns. Empty means every host (subject to the rest of the policy). */
  allowHosts: string[]
  denyHosts: string[]
  /** Port ranges. Empty allow list means every port. */
  allowPorts: PortRange[]
  denyPorts: PortRange[]
  /** Permit loopback, private and other non-public addresses. Local testing only. */
  allowPrivate: boolean
  /** Per token: concurrent tunnels plus in-flight plain requests. 0 = unlimited. */
  maxConnections: number
  /** Per token: bytes in both directions per clock minute. 0 = unlimited. */
  bytesPerMinute: number
  port: number
  host: string
  /** A connection with no bytes in either direction for this long is closed. */
  idleTimeoutMs: number
  /** DNS + TCP (+ TLS in plain mode) must finish within this. */
  connectTimeoutMs: number
  modes: Mode[]
  /** Workers only: DNS-over-HTTPS JSON endpoint used to resolve before connecting. */
  dohUrl: string
}

export const DEFAULT_CONFIG: ProxyConfig = {
  tokens: [],
  open: false,
  allowHosts: [],
  denyHosts: [],
  allowPorts: [],
  denyPorts: [{ from: 25, to: 25 }],
  allowPrivate: false,
  maxConnections: 64,
  bytesPerMinute: 0,
  port: 8787,
  host: '127.0.0.1',
  idleTimeoutMs: 300_000,
  connectTimeoutMs: 10_000,
  modes: ['tcp', 'http'],
  dohUrl: 'https://cloudflare-dns.com/dns-query',
}

// ---------------------------------------------------------------------------------------------
// Configuration from environment variables

type Env = Record<string, unknown>

function envStr(env: Env, name: string): string | undefined {
  const v = env[name]
  return typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined
}

function envBool(env: Env, name: string, dflt: boolean): boolean {
  const v = envStr(env, name)
  if (v === undefined || v === '') return dflt
  if (/^(1|true|yes|on)$/i.test(v)) return true
  if (/^(0|false|no|off)$/i.test(v)) return false
  throw new Error(`${name}: expected 1 or 0, got "${v}"`)
}

function envInt(env: Env, name: string, dflt: number, min: number, max: number): number {
  const v = envStr(env, name)
  if (v === undefined || v === '') return dflt
  if (!/^\d+$/.test(v)) throw new Error(`${name}: expected a whole number, got "${v}"`)
  const n = Number(v)
  if (n < min || n > max) throw new Error(`${name}: must be between ${min} and ${max}`)
  return n
}

function envList(env: Env, name: string): string[] | undefined {
  const v = envStr(env, name)
  if (v === undefined) return undefined
  return v.split(/[\s,]+/).filter(Boolean)
}

/** Tokens travel as a WebSocket subprotocol, so they are limited to characters valid there. */
export const TOKEN_RE = /^[A-Za-z0-9._~-]{1,256}$/

export function parsePorts(spec: string[], name = 'ports'): PortRange[] {
  return spec.map((s) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(s)
    const from = m ? Number(m[1]) : NaN
    const to = m ? Number(m[2] ?? m[1]) : NaN
    if (!m || from < 1 || to > 65535 || from > to) throw new Error(`${name}: bad port or range "${s}"`)
    return { from, to }
  })
}

function parsePatterns(spec: string[], name: string): string[] {
  return spec.map((raw) => {
    let p = raw.toLowerCase()
    if (p.startsWith('[') && p.endsWith(']')) p = p.slice(1, -1)
    if (p.endsWith('.') && p.length > 1) p = p.slice(0, -1)
    if (!/^(\*|(\*\.)?[a-z0-9_.:-]+)$/.test(p)) throw new Error(`${name}: bad host pattern "${raw}"`)
    return p
  })
}

/**
 * Builds a config from environment variables (Node `process.env`, Workers `env`). Throws with a
 * readable message on any invalid value, and when neither tokens nor open mode are configured.
 */
export function parseConfig(env: Env): ProxyConfig {
  const d = DEFAULT_CONFIG
  const tokens = envList(env, 'BH_PROXY_TOKENS') ?? []
  for (const t of tokens) {
    if (!TOKEN_RE.test(t)) throw new Error('BH_PROXY_TOKENS: tokens may only contain A-Z a-z 0-9 . _ ~ - (1 to 256 characters)')
  }
  const open = envBool(env, 'BH_PROXY_OPEN', false)
  if (!open && tokens.length === 0) {
    throw new Error('No access tokens configured. Set BH_PROXY_TOKENS, or BH_PROXY_OPEN=1 for a proxy that anyone who can reach it may use.')
  }
  const modeList = envList(env, 'BH_PROXY_MODES')
  const modes: Mode[] = []
  for (const m of modeList ?? d.modes) {
    if (m !== 'tcp' && m !== 'http') throw new Error(`BH_PROXY_MODES: unknown mode "${m}" (expected tcp, http)`)
    if (!modes.includes(m)) modes.push(m)
  }
  if (modes.length === 0) throw new Error('BH_PROXY_MODES: at least one of tcp, http')
  const denyPorts = envList(env, 'BH_PROXY_DENY_PORTS')
  return {
    tokens,
    open,
    allowHosts: parsePatterns(envList(env, 'BH_PROXY_ALLOW') ?? [], 'BH_PROXY_ALLOW'),
    denyHosts: parsePatterns(envList(env, 'BH_PROXY_DENY') ?? [], 'BH_PROXY_DENY'),
    allowPorts: parsePorts(envList(env, 'BH_PROXY_ALLOW_PORTS') ?? [], 'BH_PROXY_ALLOW_PORTS'),
    denyPorts: denyPorts ? parsePorts(denyPorts, 'BH_PROXY_DENY_PORTS') : d.denyPorts,
    allowPrivate: envBool(env, 'BH_PROXY_ALLOW_PRIVATE', false),
    maxConnections: envInt(env, 'BH_PROXY_MAX_CONNECTIONS', d.maxConnections, 0, 1_000_000),
    bytesPerMinute: envInt(env, 'BH_PROXY_BYTES_PER_MINUTE', d.bytesPerMinute, 0, Number.MAX_SAFE_INTEGER),
    port: envInt(env, 'BH_PROXY_PORT', d.port, 0, 65535),
    host: envStr(env, 'BH_PROXY_HOST') || d.host,
    idleTimeoutMs: envInt(env, 'BH_PROXY_IDLE_TIMEOUT_MS', d.idleTimeoutMs, 1, 86_400_000),
    connectTimeoutMs: envInt(env, 'BH_PROXY_CONNECT_TIMEOUT_MS', d.connectTimeoutMs, 1, 600_000),
    modes,
    dohUrl: envStr(env, 'BH_PROXY_DOH_URL') || d.dohUrl,
  }
}

// ---------------------------------------------------------------------------------------------
// Access tokens

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

export function checkToken(cfg: ProxyConfig, token: string | null | undefined): boolean {
  if (cfg.open) return true
  if (!token) return false
  let ok = false
  for (const t of cfg.tokens) if (constantTimeEqual(t, token)) ok = true
  return ok
}

/**
 * Checks the token and returns the key that limits are counted under: the token, or in open mode
 * the caller's address (`clientId`). Throws `auth`.
 */
export function authorize(cfg: ProxyConfig, token: string | null | undefined, clientId: string): string {
  if (!checkToken(cfg, token)) throw new ProxyError('auth', token ? 'unknown access token' : 'access token required')
  return cfg.open ? `open:${clientId}` : `token:${token}`
}

/** Reads `Sec-WebSocket-Protocol`: whether `bh1` was offered, and the token from `bh1.<token>`. */
export function parseSubprotocols(header: string | null | undefined): { offered: boolean; token: string | null } {
  let offered = false
  let token: string | null = null
  for (const p of (header ?? '').split(',')) {
    const s = p.trim()
    if (s === SUBPROTOCOL) offered = true
    else if (s.startsWith(SUBPROTOCOL + '.') && token === null) token = s.slice(SUBPROTOCOL.length + 1)
  }
  return { offered, token }
}

// ---------------------------------------------------------------------------------------------
// IP addresses

/** Strict dotted-decimal IPv4 (four parts, no leading zeros). Anything looser is not an address here. */
export function parseIPv4(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const part = m[i + 1]!
    if (part.length > 1 && part.startsWith('0')) return null
    const n = Number(part)
    if (n > 255) return null
    out[i] = n
  }
  return out
}

/** IPv6 text to 16 bytes. Accepts `::` compression and an IPv4 tail; rejects zone ids. */
export function parseIPv6(input: string): Uint8Array | null {
  let s = input
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return null
  let tail: Uint8Array | null = null
  if (s.includes('.')) {
    const i = s.lastIndexOf(':')
    tail = parseIPv4(s.slice(i + 1))
    if (!tail) return null
    s = s.slice(0, i + 1) + '0:0'
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = groups(halves[0]!)
  const rest = halves.length === 2 ? groups(halves[1]!) : []
  if (!head || !rest) return null
  let words: number[]
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length
    if (fill < 1) return null
    words = [...head, ...new Array<number>(fill).fill(0), ...rest]
  } else {
    if (head.length !== 8) return null
    words = head
  }
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    out[i * 2] = words[i]! >> 8
    out[i * 2 + 1] = words[i]! & 0xff
  }
  if (tail) out.set(tail, 12)
  return out
}

/** 4 if IPv4, 6 if IPv6, 0 if not an address literal. */
export function ipVersion(s: string): 0 | 4 | 6 {
  return parseIPv4(s) ? 4 : parseIPv6(s) ? 6 : 0
}

function v4Kind(b: Uint8Array): string | null {
  const [a, c, d] = [b[0]!, b[1]!, b[2]!]
  if (a === 0) return 'unspecified'
  if (a === 10) return 'private'
  if (a === 100 && c >= 64 && c <= 127) return 'CGNAT'
  if (a === 127) return 'loopback'
  if (a === 169 && c === 254) return 'link-local'
  if (a === 172 && c >= 16 && c <= 31) return 'private'
  if (a === 192 && c === 0 && d === 0) return 'reserved'
  if (a === 192 && c === 0 && d === 2) return 'reserved'
  if (a === 192 && c === 88 && d === 99) return 'reserved'
  if (a === 192 && c === 168) return 'private'
  if (a === 198 && (c === 18 || c === 19)) return 'private'
  if (a === 198 && c === 51 && d === 100) return 'reserved'
  if (a === 203 && c === 0 && d === 113) return 'reserved'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved'
  return null
}

function v6Kind(b: Uint8Array): string | null {
  const zero = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) if (b[i] !== 0) return false
    return true
  }
  if (zero(0, 16)) return 'unspecified'
  if (zero(0, 15) && b[15] === 1) return 'loopback'
  // Every IPv4-mapped address is refused, whatever it maps to: nothing public is reached that way,
  // and it is the classic route around an IPv4 filter.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return 'IPv4-mapped'
  if (zero(0, 12)) return 'IPv4-compatible'
  if (b[0] === 0xff) return 'multicast'
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link-local'
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return 'private'
  if ((b[0]! & 0xfe) === 0xfc) return 'private'
  // Addresses that embed an IPv4 address are judged by the address they embed.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return zero(4, 12) ? (v4Kind(b.subarray(12, 16)) ?? null) : 'reserved' // NAT64 64:ff9b::/96, local 64:ff9b:1::/48
  }
  if (b[0] === 0x20 && b[1] === 0x02) return v4Kind(b.subarray(2, 6)) // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return 'reserved' // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'reserved' // documentation
  if (b[0] === 0x01 && zero(1, 8)) return 'reserved' // discard 100::/64
  return null
}

/**
 * Why an address must not be dialled (`"loopback"`, `"private"`, `"link-local"`, `"CGNAT"`,
 * `"multicast"`, `"unspecified"`, `"IPv4-mapped"`, `"reserved"`, `"invalid"`), or null if it is an
 * ordinary public address.
 */
export function addressKind(addr: string): string | null {
  const v4 = parseIPv4(addr)
  if (v4) return v4Kind(v4)
  const v6 = parseIPv6(addr)
  if (v6) return v6Kind(v6)
  return 'invalid'
}

// ---------------------------------------------------------------------------------------------
// Destination policy

/**
 * Canonical form of a destination host: lower case, no brackets, no trailing dot. Throws `request`
 * for anything that is neither a DNS name nor a strict address literal, including the loose numeric
 * forms (`0x7f.1`, `2130706433`, `010.0.0.1`) that resolvers read as addresses.
 */
export function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.includes(':')) {
    if (!parseIPv6(h)) throw new ProxyError('request', 'invalid IPv6 address')
    return h
  }
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (h === '' || h.length > 253) throw new ProxyError('request', 'missing or over-long host')
  const labels = h.split('.')
  const last = labels[labels.length - 1]!
  if (/^(\d+|0x[0-9a-f]*)$/.test(last)) {
    if (!parseIPv4(h)) throw new ProxyError('request', 'invalid IPv4 address')
    return h
  }
  for (const l of labels) {
    if (!/^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l)) throw new ProxyError('request', 'invalid host name')
  }
  return h
}

export function parsePort(raw: string | null | undefined): number {
  if (!raw || !/^\d{1,5}$/.test(raw)) throw new ProxyError('request', 'missing or invalid port')
  const n = Number(raw)
  if (n < 1 || n > 65535) throw new ProxyError('request', 'port out of range')
  return n
}

/**
 * `*` matches every host; `*.example.com` matches any subdomain of example.com but not example.com
 * itself; anything else must equal the host. Both sides are expected in canonical form.
 */
export function hostMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) return host.length > pattern.length - 1 && host.endsWith(pattern.slice(1))
  return host === pattern
}

function portIn(ranges: PortRange[], port: number): boolean {
  return ranges.some((r) => port >= r.from && port <= r.to)
}

/** The part of the policy that needs no DNS: host patterns and ports. Throws `policy`. */
export function checkHostPort(cfg: ProxyConfig, host: string, port: number): void {
  if (cfg.denyHosts.some((p) => hostMatches(p, host))) throw new ProxyError('policy', `host ${host} is on the deny list`)
  if (cfg.allowHosts.length > 0 && !cfg.allowHosts.some((p) => hostMatches(p, host))) {
    throw new ProxyError('policy', `host ${host} is not on the allow list`)
  }
  if (portIn(cfg.denyPorts, port)) throw new ProxyError('policy', `port ${port} is on the deny list`)
  if (cfg.allowPorts.length > 0 && !portIn(cfg.allowPorts, port)) throw new ProxyError('policy', `port ${port} is not on the allow list`)
}

/** Resolves a host name to address strings. Rejects (any error) when the name does not resolve. */
export type Lookup = (host: string) => Promise<string[]>

/**
 * Resolves `host` (canonical form) and applies the address policy to the result. Returns the
 * addresses that may be dialled, in resolver order; the caller must connect to one of these and
 * never to the name, so a second DNS answer cannot change the destination. Throws `dns` or `policy`.
 */
export async function resolveDestination(cfg: ProxyConfig, host: string, lookup: Lookup): Promise<string[]> {
  let addrs: string[]
  if (ipVersion(host)) {
    addrs = [host]
  } else {
    try {
      addrs = await lookup(host)
    } catch (e) {
      if (e instanceof ProxyError) throw e
      throw new ProxyError('dns', `could not resolve ${host}`)
    }
    if (addrs.length === 0) throw new ProxyError('dns', `could not resolve ${host}`)
  }
  if (cfg.allowPrivate) {
    const valid = addrs.filter((a) => ipVersion(a))
    if (valid.length === 0) throw new ProxyError('dns', `could not resolve ${host}`)
    return valid
  }
  let kind = 'invalid'
  const ok: string[] = []
  for (const a of addrs) {
    const k = addressKind(a)
    if (k === null) ok.push(a)
    else kind = k
  }
  if (ok.length === 0) throw new ProxyError('policy', `${host} is a${/^[aeiouI]/.test(kind) ? 'n' : ''} ${kind} address, which this proxy does not connect to`)
  return ok
}

// ---------------------------------------------------------------------------------------------
// Per-token limits

interface LimitEntry { conns: number; window: number; bytes: number }

/**
 * Concurrent connections and bytes per minute, per key. Bytes are counted in both directions in
 * fixed clock-minute windows. State is in memory: it is per process (per isolate on Workers).
 */
export class Limiter {
  private readonly entries = new Map<string, LimitEntry>()
  constructor(
    private readonly maxConnections: number,
    private readonly bytesPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  private entry(key: string): LimitEntry {
    const window = Math.floor(this.now() / 60_000)
    let e = this.entries.get(key)
    if (!e) {
      if (this.entries.size >= 10_000) this.prune(window)
      e = { conns: 0, window, bytes: 0 }
      this.entries.set(key, e)
    } else if (e.window !== window) {
      e.window = window
      e.bytes = 0
    }
    return e
  }

  private prune(window: number): void {
    for (const [k, e] of this.entries) if (e.conns === 0 && e.window !== window) this.entries.delete(k)
  }

  /**
   * Takes a connection slot. Returns a release function (safe to call twice), or throws `limit`
   * when the key is at its connection limit or has spent this minute's bytes.
   */
  acquire(key: string): () => void {
    const e = this.entry(key)
    if (this.bytesPerMinute > 0 && e.bytes >= this.bytesPerMinute) throw new ProxyError('limit', 'byte limit for this minute reached')
    if (this.maxConnections > 0 && e.conns >= this.maxConnections) throw new ProxyError('limit', 'too many concurrent connections')
    e.conns++
    let released = false
    return () => {
      if (released) return
      released = true
      e.conns--
      if (e.conns === 0 && e.bytes === 0) this.entries.delete(key)
    }
  }

  /** Records `n` bytes. False once the key is over this minute's limit; the caller then stops. */
  consume(key: string, n: number): boolean {
    if (this.bytesPerMinute <= 0) return true
    const e = this.entry(key)
    e.bytes += n
    return e.bytes <= this.bytesPerMinute
  }

  connections(key: string): number {
    return this.entries.get(key)?.conns ?? 0
  }
}

// ---------------------------------------------------------------------------------------------
// Header encoding (plain mode)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_REV = /* @__PURE__ */ (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i
  t['+'.charCodeAt(0)] = 62 // standard alphabet accepted on input
  t['/'.charCodeAt(0)] = 63
  return t
})()

export function base64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i]! << 16
    out += B64[n >> 18]! + B64[(n >> 12) & 63]!
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!
  }
  return out
}

export function base64urlDecode(text: string): Uint8Array {
  const s = text.replace(/=+$/, '')
  if (s.length % 4 === 1) throw new Error('bad base64url length')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let acc = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const v = c < 128 ? B64_REV[c]! : -1
    if (v < 0) throw new Error('bad base64url character')
    acc = ((acc << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HEADER_VALUE_BAD = /[\0\r\n]/

/** `[name, value]` pairs to the base64url JSON form used by `x-bh-headers` and `x-bh-resp-headers`. */
export function encodeHeaders(pairs: Iterable<readonly [string, string]>): string {
  const list: [string, string][] = []
  for (const [k, v] of pairs) list.push([k, v])
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(list)))
}

/** Inverse of `encodeHeaders`. Throws a plain Error when the blob is not a list of valid headers. */
export function decodeHeaders(blob: string): HeaderPairs {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64urlDecode(blob.trim())))
  if (!Array.isArray(parsed)) throw new Error('headers must be an array')
  const out: HeaderPairs = []
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') {
      throw new Error('each header must be a [name, value] pair of strings')
    }
    if (!HEADER_NAME_RE.test(item[0]) || HEADER_VALUE_BAD.test(item[1])) throw new Error(`invalid header "${item[0].slice(0, 40)}"`)
    out.push([item[0], item[1]])
  }
  return out
}

/** Request headers the proxy sets from the connection itself and so never forwards. */
const REQUEST_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length', 'expect'])
/** Response headers that describe the proxy-to-target connection, not the response the client gets. */
const RESPONSE_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'trailer', 'upgrade'])

export function filterRequestHeaders(pairs: HeaderPairs): HeaderPairs {
  return pairs.filter(([k]) => !REQUEST_HOP.has(k.toLowerCase()))
}

export function filterResponseHeaders(pairs: HeaderPairs): HeaderPairs {
  return pairs.filter(([k]) => !RESPONSE_HOP.has(k.toLowerCase()))
}

// ---------------------------------------------------------------------------------------------
// Request parsing

export interface TunnelRequest { host: string; port: number }

/** `host` and `port` from the query of `GET /v1/tcp`. Throws `request`. */
export function parseTunnelRequest(params: URLSearchParams): TunnelRequest {
  const host = params.get('host')
  if (!host) throw new ProxyError('request', 'missing host')
  return { host: normalizeHost(host), port: parsePort(params.get('port')) }
}

export interface PlainRequest {
  url: URL
  host: string
  port: number
  secure: boolean
  token: string | null
  /** Headers to send to the target, hop-by-hop ones removed. */
  headers: HeaderPairs
}

/** The `x-bh-*` request headers of plain mode. `get` returns a header by lower-case name. Throws `request`. */
export function parsePlainRequest(get: (name: string) => string | null | undefined): PlainRequest {
  const raw = get('x-bh-url')
  if (!raw) throw new ProxyError('request', 'missing x-bh-url')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ProxyError('request', 'x-bh-url is not an absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProxyError('request', 'x-bh-url must be http or https')
  const secure = url.protocol === 'https:'
  const host = normalizeHost(url.hostname)
  const port = url.port ? parsePort(url.port) : secure ? 443 : 80
  let headers: HeaderPairs = []
  const blob = get('x-bh-headers')
  if (blob) {
    try {
      headers = decodeHeaders(blob)
    } catch (e) {
      throw new ProxyError('request', `x-bh-headers: ${e instanceof Error ? e.message : 'invalid'}`)
    }
  }
  return { url, host, port, secure, token: get('x-bh-token') || null, headers: filterRequestHeaders(headers) }
}

// ---------------------------------------------------------------------------------------------
// Responses

export const HEADER_URL = 'x-bh-url'
export const HEADER_TOKEN = 'x-bh-token'
export const HEADER_HEADERS = 'x-bh-headers'
export const HEADER_RESP_HEADERS = 'x-bh-resp-headers'
export const HEADER_STATUS = 'x-bh-status'
export const HEADER_ERROR = 'x-bh-error'

/** On every response, so the page can read the body and the `x-bh-*` headers. */
export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': `${HEADER_RESP_HEADERS}, ${HEADER_STATUS}, ${HEADER_ERROR}`,
  }
}

/** Headers of a 204 answer to a CORS preflight from any origin. `get` returns a request header. */
export function preflightHeaders(get: (name: string) => string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {
    ...corsHeaders(),
    'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': get('access-control-request-headers') || `${HEADER_URL}, ${HEADER_TOKEN}, ${HEADER_HEADERS}, content-type`,
    'access-control-max-age': '86400',
    vary: 'access-control-request-headers',
  }
  // Chrome's Private Network Access: a public page calling a proxy on localhost or a LAN address.
  if (get('access-control-request-private-network') === 'true') out['access-control-allow-private-network'] = 'true'
  return out
}

export function healthBody(cfg: ProxyConfig): { ok: true; v: number; modes: Mode[] } {
  return { ok: true, v: PROTOCOL_VERSION, modes: [...cfg.modes] }
}

export function errorBody(err: ProxyError): string {
  return JSON.stringify({ code: err.code, message: err.message })
}

/** First tunnel frame on failure. */
export function failFrame(err: ProxyError): string {
  return JSON.stringify({ ok: false, code: err.code, message: err.message })
}

export const OK_FRAME = '{"ok":true}'
export const END_FRAME = '{"end":true}'

/** True for the half-close text frame `{"end":true}`. */
export function isEndFrame(text: string): boolean {
  if (text === END_FRAME) return true
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && (v as { end?: unknown }).end === true
  } catch {
    return false
  }
}

export function toProxyError(e: unknown, fallback: ProxyErrorCode = 'connect'): ProxyError {
  if (e instanceof ProxyError) return e
  return new ProxyError(fallback, e instanceof Error ? e.message : String(e))
}
