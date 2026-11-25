import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG, Limiter, ProxyError, addressKind, authorize, base64urlDecode, base64urlEncode, checkHostPort, checkToken,
  decodeHeaders, encodeHeaders, hostMatches, isEndFrame, normalizeHost, parseConfig, parseIPv6, parsePlainRequest,
  parseSubprotocols, parseTunnelRequest, preflightHeaders, resolveDestination, type ProxyConfig,
} from '../src/core'

const cfg = (over: Partial<ProxyConfig> = {}): ProxyConfig => ({ ...DEFAULT_CONFIG, tokens: ['tok'], ...over })
const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof ProxyError ? e.code : `not a ProxyError: ${String(e)}`
  }
  return 'no error'
}

describe('address classification', () => {
  it.each([
    ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'], ['0.0.0.0', 'unspecified'], ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.1', 'private'],
    ['100.64.0.1', 'CGNAT'], ['100.127.255.255', 'CGNAT'], ['169.254.169.254', 'link-local'],
    ['224.0.0.1', 'multicast'], ['239.255.255.255', 'multicast'], ['255.255.255.255', 'reserved'], ['198.18.0.1', 'private'],
    ['::', 'unspecified'], ['::1', 'loopback'], ['::ffff:127.0.0.1', 'IPv4-mapped'], ['::ffff:8.8.8.8', 'IPv4-mapped'],
    ['::ffff:7f00:1', 'IPv4-mapped'], ['::7f00:1', 'IPv4-compatible'], ['fe80::1', 'link-local'], ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'], ['fec0::1', 'private'], ['ff02::1', 'multicast'], ['64:ff9b::a00:1', 'private'],
    ['2002:7f00:1::1', 'loopback'], ['2001:db8::1', 'reserved'], ['not-an-ip', 'invalid'], ['1.2.3', 'invalid'],
  ])('%s is refused as %s', (addr, kind) => {
    expect(addressKind(addr)).toBe(kind)
  })

  it.each(['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.32.0.1', '172.15.0.1', '169.253.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '64:ff9b::808:808', '2002:808:808::1'])('%s is public', (addr) => {
    expect(addressKind(addr)).toBeNull()
  })

  it('parses IPv6 forms', () => {
    expect(parseIPv6('[::1]')).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))
    expect(parseIPv6('1:2:3:4:5:6:7:8')?.[15]).toBe(8)
    expect(parseIPv6('1:2:3:4:5:6:7')).toBeNull()
    expect(parseIPv6('1::2::3')).toBeNull()
    expect(parseIPv6('fe80::1%eth0')).toBeNull()
    expect(parseIPv6('1:2:3:4:5:6:7::8')).toBeNull()
    expect(parseIPv6('::ffff:1.2.3.4')?.slice(10)).toEqual(new Uint8Array([0xff, 0xff, 1, 2, 3, 4]))
  })
})

describe('hosts and patterns', () => {
  it('normalises hosts and rejects loose numeric forms', () => {
    expect(normalizeHost('Example.COM.')).toBe('example.com')
    expect(normalizeHost('[::1]')).toBe('::1')
    expect(normalizeHost('1.2.3.4')).toBe('1.2.3.4')
    for (const bad of ['', '0x7f.1', '2130706433', '010.0.0.1', '127.1', '1.2.3.4.5', 'a b', 'a..b', 'exa$mple.com', '::zz', 'a/b', '-a.com']) {
      expect(code(() => normalizeHost(bad)), bad).toBe('request')
    }
  })

  it('matches patterns', () => {
    expect(hostMatches('*', 'anything.example')).toBe(true)
    expect(hostMatches('*.example.com', 'api.example.com')).toBe(true)
    expect(hostMatches('*.example.com', 'a.b.example.com')).toBe(true)
    expect(hostMatches('*.example.com', 'example.com')).toBe(false)
    expect(hostMatches('*.example.com', 'badexample.com')).toBe(false)
    expect(hostMatches('example.com', 'example.com')).toBe(true)
    expect(hostMatches('example.com', 'api.example.com')).toBe(false)
  })

  it('applies allow and deny lists for hosts and ports', () => {
    const c = cfg({ allowHosts: ['*.good.test', 'exact.test'], denyHosts: ['bad.good.test'], allowPorts: [{ from: 443, to: 443 }, { from: 8000, to: 8100 }], denyPorts: [{ from: 8050, to: 8050 }] })
    expect(code(() => checkHostPort(c, 'api.good.test', 443))).toBe('no error')
    expect(code(() => checkHostPort(c, 'exact.test', 8001))).toBe('no error')
    expect(code(() => checkHostPort(c, 'bad.good.test', 443))).toBe('policy')
    expect(code(() => checkHostPort(c, 'other.test', 443))).toBe('policy')
    expect(code(() => checkHostPort(c, 'api.good.test', 80))).toBe('policy')
    expect(code(() => checkHostPort(c, 'api.good.test', 8050))).toBe('policy')
    expect(code(() => checkHostPort(cfg(), 'mail.test', 25))).toBe('policy') // default deny list
    expect(code(() => checkHostPort(cfg(), 'any.test', 22))).toBe('no error')
  })

  it('checks addresses after resolution', async () => {
    const lookup = async (h: string): Promise<string[]> => {
      if (h === 'public.test') return ['93.184.216.34']
      if (h === 'private.test') return ['10.1.2.3']
      if (h === 'mixed.test') return ['192.168.0.1', '93.184.216.34', '::1']
      if (h === 'empty.test') return []
      throw new Error('ENOTFOUND')
    }
    await expect(resolveDestination(cfg(), 'public.test', lookup)).resolves.toEqual(['93.184.216.34'])
    await expect(resolveDestination(cfg(), 'mixed.test', lookup)).resolves.toEqual(['93.184.216.34'])
    await expect(resolveDestination(cfg(), 'private.test', lookup)).rejects.toMatchObject({ code: 'policy' })
    await expect(resolveDestination(cfg(), '127.0.0.1', lookup)).rejects.toMatchObject({ code: 'policy' })
    await expect(resolveDestination(cfg(), '::ffff:8.8.8.8', lookup)).rejects.toMatchObject({ code: 'policy' })
    await expect(resolveDestination(cfg(), 'empty.test', lookup)).rejects.toMatchObject({ code: 'dns' })
    await expect(resolveDestination(cfg(), 'missing.test', lookup)).rejects.toMatchObject({ code: 'dns' })
    await expect(resolveDestination(cfg({ allowPrivate: true }), 'private.test', lookup)).resolves.toEqual(['10.1.2.3'])
    await expect(resolveDestination(cfg({ allowPrivate: true }), '127.0.0.1', lookup)).resolves.toEqual(['127.0.0.1'])
  })
})

describe('tokens', () => {
  it('checks tokens and derives the limit key', () => {
    const c = cfg({ tokens: ['alpha', 'beta'] })
    expect(checkToken(c, 'alpha')).toBe(true)
    expect(checkToken(c, 'beta')).toBe(true)
    expect(checkToken(c, 'alph')).toBe(false)
    expect(checkToken(c, 'alphaa')).toBe(false)
    expect(checkToken(c, '')).toBe(false)
    expect(checkToken(c, null)).toBe(false)
    expect(authorize(c, 'beta', '1.2.3.4')).toBe('token:beta')
    expect(code(() => authorize(c, 'nope', '1.2.3.4'))).toBe('auth')
    expect(authorize(cfg({ open: true, tokens: [] }), null, '1.2.3.4')).toBe('open:1.2.3.4')
  })

  it('reads the token from the subprotocol list', () => {
    expect(parseSubprotocols('bh1, bh1.secret-1')).toEqual({ offered: true, token: 'secret-1' })
    expect(parseSubprotocols('bh1.a.b,bh1')).toEqual({ offered: true, token: 'a.b' })
    expect(parseSubprotocols('bh1')).toEqual({ offered: true, token: null })
    expect(parseSubprotocols('other')).toEqual({ offered: false, token: null })
    expect(parseSubprotocols(undefined)).toEqual({ offered: false, token: null })
  })
})

describe('limits', () => {
  it('limits concurrent connections per key', () => {
    const l = new Limiter(2, 0)
    const a = l.acquire('k')
    l.acquire('k')
    expect(code(() => l.acquire('k'))).toBe('limit')
    expect(code(() => l.acquire('other'))).toBe('no error')
    a()
    a() // releasing twice frees one slot only
    expect(l.connections('k')).toBe(1)
    expect(code(() => l.acquire('k'))).toBe('no error')
    expect(code(() => l.acquire('k'))).toBe('limit')
  })

  it('limits bytes per clock minute per key', () => {
    let now = 60_000 * 1000
    const l = new Limiter(0, 1000, () => now)
    expect(l.consume('k', 600)).toBe(true)
    expect(l.consume('k', 400)).toBe(true)
    expect(l.consume('k', 1)).toBe(false)
    expect(code(() => l.acquire('k'))).toBe('limit')
    expect(l.consume('other', 1000)).toBe(true)
    now += 60_000
    expect(code(() => l.acquire('k'))).toBe('no error')
    expect(l.consume('k', 1000)).toBe(true)
  })
})

describe('header encoding', () => {
  it('round-trips base64url for every length and byte value', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 0xff)
      const text = base64urlEncode(bytes)
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/)
      expect(text).toBe(Buffer.from(bytes).toString('base64url'))
      expect(base64urlDecode(text)).toEqual(bytes)
    }
    expect(base64urlDecode(Buffer.from('padded!').toString('base64'))).toEqual(new Uint8Array(Buffer.from('padded!')))
    expect(() => base64urlDecode('a')).toThrow()
    expect(() => base64urlDecode('a*bc')).toThrow()
  })

  it('round-trips header pairs, repeats and non-ASCII included', () => {
    const pairs: [string, string][] = [['User-Agent', 'x/1.0'], ['Cookie', 'a=1; b=2'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['X-Name', 'Zoë ✓']]
    expect(decodeHeaders(encodeHeaders(pairs))).toEqual(pairs)
    expect(decodeHeaders(encodeHeaders([]))).toEqual([])
  })

  it('rejects malformed header blobs', () => {
    const enc = (v: unknown): string => base64urlEncode(new TextEncoder().encode(JSON.stringify(v)))
    for (const bad of [enc({ a: 'b' }), enc([['a']]), enc([['a', 1]]), enc([['bad name', 'v']]), enc([['a', 'v\r\nx: y']]), enc([['', 'v']]), '!!!', enc('x')]) {
      expect(() => decodeHeaders(bad)).toThrow()
    }
  })

  it('parses a plain-mode request and drops hop-by-hop headers', () => {
    const h: Record<string, string> = {
      'x-bh-url': 'https://API.example.com/v1/x?y=1',
      'x-bh-token': 'tok',
      'x-bh-headers': encodeHeaders([['Host', 'other.example'], ['Connection', 'keep-alive'], ['Content-Length', '5'], ['Transfer-Encoding', 'chunked'], ['Accept', '*/*']]),
    }
    const p = parsePlainRequest((n) => h[n])
    expect(p).toMatchObject({ host: 'api.example.com', port: 443, secure: true, token: 'tok' })
    expect(p.headers).toEqual([['Host', 'other.example'], ['Accept', '*/*']])
    expect(parsePlainRequest((n) => ({ 'x-bh-url': 'http://h.test:8080/' })[n])).toMatchObject({ host: 'h.test', port: 8080, secure: false, token: null, headers: [] })
    expect(code(() => parsePlainRequest(() => undefined))).toBe('request')
    expect(code(() => parsePlainRequest((n) => ({ 'x-bh-url': '/relative' })[n]))).toBe('request')
    expect(code(() => parsePlainRequest((n) => ({ 'x-bh-url': 'ftp://h.test/' })[n]))).toBe('request')
    expect(code(() => parsePlainRequest((n) => ({ 'x-bh-url': 'http://h.test/', 'x-bh-headers': 'bm9wZQ' })[n]))).toBe('request')
  })

  it('parses a tunnel request', () => {
    expect(parseTunnelRequest(new URLSearchParams('host=Example.com&port=443'))).toEqual({ host: 'example.com', port: 443 })
    for (const bad of ['port=443', 'host=a.test', 'host=a.test&port=0', 'host=a.test&port=65536', 'host=a.test&port=4x', 'host=a.test&port=-1']) {
      expect(code(() => parseTunnelRequest(new URLSearchParams(bad))), bad).toBe('request')
    }
  })

  it('recognises the end frame', () => {
    expect(isEndFrame('{"end":true}')).toBe(true)
    expect(isEndFrame('{ "end": true }')).toBe(true)
    expect(isEndFrame('{"end":false}')).toBe(false)
    expect(isEndFrame('end')).toBe(false)
    expect(isEndFrame('null')).toBe(false)
  })

  it('answers preflights', () => {
    const h = preflightHeaders((n) => ({ 'access-control-request-headers': 'x-bh-url,x-custom', 'access-control-request-private-network': 'true' })[n])
    expect(h['access-control-allow-origin']).toBe('*')
    expect(h['access-control-allow-headers']).toBe('x-bh-url,x-custom')
    expect(h['access-control-allow-private-network']).toBe('true')
    expect(preflightHeaders(() => null)['access-control-allow-headers']).toContain('x-bh-headers')
  })
})

describe('configuration', () => {
  it('refuses to start without tokens unless open', () => {
    expect(() => parseConfig({})).toThrow(/BH_PROXY_TOKENS/)
    expect(parseConfig({ BH_PROXY_OPEN: '1' })).toMatchObject({ open: true, tokens: [] })
    expect(parseConfig({ BH_PROXY_TOKENS: 'a' })).toMatchObject({ ...DEFAULT_CONFIG, tokens: ['a'] })
  })

  it('reads every variable', () => {
    const c = parseConfig({
      BH_PROXY_TOKENS: 'one, two',
      BH_PROXY_ALLOW: '*.Example.com api.test',
      BH_PROXY_DENY: 'evil.example.com',
      BH_PROXY_ALLOW_PORTS: '443,8000-8100',
      BH_PROXY_DENY_PORTS: '',
      BH_PROXY_ALLOW_PRIVATE: 'true',
      BH_PROXY_MAX_CONNECTIONS: '5',
      BH_PROXY_BYTES_PER_MINUTE: '1000000',
      BH_PROXY_PORT: '9000',
      BH_PROXY_HOST: '0.0.0.0',
      BH_PROXY_IDLE_TIMEOUT_MS: '1000',
      BH_PROXY_CONNECT_TIMEOUT_MS: '500',
      BH_PROXY_MODES: 'tcp',
      BH_PROXY_DOH_URL: 'https://dns.example/dns-query',
    })
    expect(c).toEqual({
      tokens: ['one', 'two'], open: false, allowHosts: ['*.example.com', 'api.test'], denyHosts: ['evil.example.com'],
      allowPorts: [{ from: 443, to: 443 }, { from: 8000, to: 8100 }], denyPorts: [], allowPrivate: true, maxConnections: 5,
      bytesPerMinute: 1_000_000, port: 9000, host: '0.0.0.0', idleTimeoutMs: 1000, connectTimeoutMs: 500, modes: ['tcp'],
      dohUrl: 'https://dns.example/dns-query',
    })
  })

  it.each([
    { BH_PROXY_TOKENS: 'bad/token' }, { BH_PROXY_TOKENS: 'tok=en' }, { BH_PROXY_TOKENS: 'a', BH_PROXY_OPEN: 'maybe' },
    { BH_PROXY_TOKENS: 'a', BH_PROXY_PORT: '70000' }, { BH_PROXY_TOKENS: 'a', BH_PROXY_PORT: 'http' },
    { BH_PROXY_TOKENS: 'a', BH_PROXY_ALLOW_PORTS: '0' }, { BH_PROXY_TOKENS: 'a', BH_PROXY_ALLOW_PORTS: '90-80' },
    { BH_PROXY_TOKENS: 'a', BH_PROXY_MODES: 'udp' }, { BH_PROXY_TOKENS: 'a', BH_PROXY_ALLOW: 'a*b.com' },
    { BH_PROXY_TOKENS: 'a', BH_PROXY_IDLE_TIMEOUT_MS: '0' },
  ])('rejects %o', (env) => {
    expect(() => parseConfig(env)).toThrow()
  })
})
