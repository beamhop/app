import { describe, expect, it } from 'vitest'
import { KernelError } from '../src/kernel/errors.js'
import { Vfs } from '../src/kernel/vfs.js'
import { createResolver, ResolveError, resolveExportsMap } from '../src/node/resolve.js'
import { bytes, run, testMachine, write } from './helpers.js'

function tree(files: Record<string, string>) {
  const vfs = new Vfs()
  for (const [path, content] of Object.entries(files)) vfs.writeFileDeep(path, bytes(content))
  const resolver = createResolver(
    { kind: (p) => { const k = vfs.kindOf(p); return k === 'symlink' ? null : k }, readText: (p) => vfs.readText(p), realpath: (p) => vfs.realpath(p) },
    (id) => ['fs', 'path', 'stream/promises'].includes(id.replace(/^node:/, '')),
  )
  const file = (spec: string, parent: string, isImport = false) => resolver.resolve(spec, parent, isImport, '/').file
  const failure = (spec: string, parent: string, isImport = false) => {
    try {
      resolver.resolve(spec, parent, isImport, '/')
    } catch (e) {
      return (e as ResolveError).code
    }
    return 'resolved'
  }
  return { vfs, resolver, file, failure }
}

describe('module resolution', () => {
  const t = tree({
    '/app/main.js': '',
    '/app/lib/util.js': '',
    '/app/lib/data.json': '{}',
    '/app/lib/dir/index.js': '',
    '/app/package.json': '{"name":"app","imports":{"#internal/*":"./lib/*.js","#fs":{"node":"fs","default":"./lib/util.js"}},"exports":{".":"./main.js","./util":"./lib/util.js"}}',
    '/app/node_modules/plain/package.json': '{"main":"lib/entry"}',
    '/app/node_modules/plain/lib/entry.js': '',
    '/app/node_modules/plain/other.js': '',
    '/app/node_modules/dual/package.json': '{"exports":{".":{"import":"./esm.mjs","require":"./cjs.cjs"},"./feature/*":"./features/*.js","./package.json":"./package.json"}}',
    '/app/node_modules/dual/esm.mjs': '',
    '/app/node_modules/dual/cjs.cjs': '',
    '/app/node_modules/dual/features/a.js': '',
    '/app/node_modules/dual/hidden.js': '',
    '/app/node_modules/@scope/pkg/package.json': '{"main":"./main.js"}',
    '/app/node_modules/@scope/pkg/main.js': '',
    '/node_modules/hoisted/index.js': '',
  })

  it('resolves relative paths with extension and index lookup', () => {
    expect(t.file('./lib/util', '/app/main.js')).toBe('/app/lib/util.js')
    expect(t.file('./lib/util.js', '/app/main.js')).toBe('/app/lib/util.js')
    expect(t.file('./data', '/app/lib/util.js')).toBe('/app/lib/data.json')
    expect(t.file('./dir', '/app/lib/util.js')).toBe('/app/lib/dir/index.js')
    expect(t.file('../main', '/app/lib/util.js')).toBe('/app/main.js')
    expect(t.failure('./missing', '/app/main.js')).toBe('MODULE_NOT_FOUND')
  })

  it('walks up node_modules, honours "main", scopes and subpaths', () => {
    expect(t.file('plain', '/app/lib/util.js')).toBe('/app/node_modules/plain/lib/entry.js')
    expect(t.file('plain/other', '/app/main.js')).toBe('/app/node_modules/plain/other.js')
    expect(t.file('@scope/pkg', '/app/main.js')).toBe('/app/node_modules/@scope/pkg/main.js')
    expect(t.file('hoisted', '/app/lib/dir/index.js')).toBe('/node_modules/hoisted/index.js')
    expect(t.failure('absent', '/app/main.js')).toBe('MODULE_NOT_FOUND')
  })

  it('applies "exports": conditions, patterns, and encapsulation', () => {
    expect(t.file('dual', '/app/main.js', true)).toBe('/app/node_modules/dual/esm.mjs')
    expect(t.file('dual', '/app/main.js', false)).toBe('/app/node_modules/dual/cjs.cjs')
    expect(t.file('dual/feature/a', '/app/main.js')).toBe('/app/node_modules/dual/features/a.js')
    expect(t.failure('dual/hidden.js', '/app/main.js')).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
    expect(t.failure('dual/feature/missing', '/app/main.js')).toBe('MODULE_NOT_FOUND')
  })

  it('resolves package "imports" and self-references', () => {
    expect(t.file('#internal/util', '/app/main.js')).toBe('/app/lib/util.js')
    expect(t.resolver.resolve('#fs', '/app/main.js', true, '/')).toEqual({ builtin: 'fs' })
    expect(t.file('app/util', '/app/lib/dir/index.js')).toBe('/app/lib/util.js')
    expect(t.failure('#nope', '/app/main.js')).toBe('MODULE_NOT_FOUND')
  })

  it('recognises built-ins with and without the node: prefix', () => {
    expect(t.resolver.resolve('node:fs', '/app/main.js', true, '/')).toEqual({ builtin: 'node:fs' })
    expect(t.resolver.resolve('stream/promises', '/app/main.js', false, '/')).toEqual({ builtin: 'stream/promises' })
    expect(t.failure('node:nonexistent', '/app/main.js')).toBe('ERR_UNKNOWN_BUILTIN_MODULE')
  })

  it('matches the longest exports pattern', () => {
    const map = { './*': './a/*.js', './deep/*': './b/*.js', './deep/x': './exact.js' }
    expect(resolveExportsMap(map, './deep/x', [])).toBe('./exact.js')
    expect(resolveExportsMap(map, './deep/y', [])).toBe('./b/y.js')
    expect(resolveExportsMap(map, './other', [])).toBe('./a/other.js')
    expect(resolveExportsMap({ import: './m.mjs', default: './c.js' }, '.', ['require'])).toBe('./c.js')
  })

  it('decides the module format from extension, package type, then syntax', () => {
    const f = tree({
      '/m/package.json': '{"type":"module"}',
      '/m/a.js': 'export {}',
      '/m/b.cjs': '',
      '/c/package.json': '{"type":"commonjs"}',
      '/c/a.js': 'import x from "y"',
      '/c/b.mjs': '',
      '/loose/esm.js': '// comment\nimport fs from "node:fs"\nexport const a = 1\n',
      '/loose/cjs.js': 'const s = `\nimport x from "y"\n`\nmodule.exports = s\n',
      '/loose/plain.js': 'module.exports = 1',
      '/loose/data.json': '{}',
    })
    const fmt = (p: string) => f.resolver.formatOf(p)
    expect([fmt('/m/a.js'), fmt('/m/b.cjs'), fmt('/c/a.js'), fmt('/c/b.mjs')]).toEqual(['esm', 'cjs', 'cjs', 'esm'])
    expect([fmt('/loose/esm.js'), fmt('/loose/cjs.js'), fmt('/loose/plain.js'), fmt('/loose/data.json')]).toEqual(['esm', 'cjs', 'cjs', 'json'])
    expect(f.resolver.formatOf('/loose/plain.js', true)).toBe('esm') // the image builder already classified it
  })
})

describe('program resolution', () => {
  const spawnCode = (m: ReturnType<typeof testMachine>, argv: string[], env?: Record<string, string>): string => {
    try {
      return m.kernel.resolveCommand(argv, '/work', env ?? m.kernel.env).program.kind
    } catch (e) {
      return (e as KernelError).code
    }
  }

  it('finds commands on PATH in order, and by path', () => {
    const m = testMachine()
    write(m, '/opt/tools/hello', '#!/bin/sh\necho hi\n', 0o755)
    expect(m.kernel.which('node', '/work', m.kernel.env)).toBe('/usr/bin/node')
    expect(m.kernel.which('cat', '/work', m.kernel.env)).toBe('/usr/bin/cat')
    expect(m.kernel.which('hello', '/work', m.kernel.env)).toBeNull()
    expect(m.kernel.which('hello', '/work', { PATH: '/nowhere:/opt/tools' })).toBe('/opt/tools/hello')
    expect(m.kernel.which('./hello', '/opt/tools', {})).toBe('/opt/tools/hello')
    expect(m.kernel.which('cat', '/work', { PATH: '/bin' })).toBe('/bin/cat') // /bin is a link to /usr/bin
  })

  it('maps executables to program kinds: stubs, shebangs, plain scripts, native binaries', () => {
    const m = testMachine()
    write(m, '/work/script.mjs', '#!/usr/bin/env node\nconsole.log(1)\n', 0o755)
    write(m, '/work/abs.js', '#!/usr/bin/node --no-warnings\n', 0o755)
    write(m, '/work/run.sh', '#!/bin/bash -e\necho hi\n', 0o755)
    write(m, '/work/noshebang', 'echo plain\n', 0o755)
    write(m, '/work/data.txt', 'not executable\n', 0o644)
    m.kernel.vfs.writeFile('/work/elf', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), { mode: 0o755 })
    m.kernel.vfs.writeFileDeep('/vendor/rg', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), { mode: 0o755 })
    expect(spawnCode(m, ['node'])).toBe('node')
    expect(spawnCode(m, ['bash'])).toBe('shell')
    expect(spawnCode(m, ['sh'])).toBe('shell')
    expect(spawnCode(m, ['grep'])).toBe('shell-builtin')
    expect(spawnCode(m, ['which'])).toBe('which')
    expect(spawnCode(m, ['./script.mjs'])).toBe('node')
    expect(m.kernel.resolveCommand(['./script.mjs', 'arg'], '/work', m.kernel.env).argv).toEqual(['node', '/work/script.mjs', 'arg'])
    expect(m.kernel.resolveCommand(['./abs.js'], '/work', m.kernel.env).argv).toEqual(['/usr/bin/node', '--no-warnings', '/work/abs.js'])
    expect(m.kernel.resolveCommand(['./run.sh', 'x'], '/work', m.kernel.env).argv).toEqual(['/bin/bash', '-e', '/work/run.sh', 'x'])
    expect(spawnCode(m, ['./noshebang'])).toBe('shell')
    expect(spawnCode(m, ['./data.txt'])).toBe('EACCES')
    expect(spawnCode(m, ['./missing'])).toBe('ENOENT')
    expect(spawnCode(m, ['no-such-command'])).toBe('ENOENT')
    expect(spawnCode(m, ['./elf'])).toBe('ENOEXEC')
    // a vendored native binary whose name is a shell tool is served by that tool (Claude Code ships rg this way)
    expect(spawnCode(m, ['/vendor/rg'])).toBe('shell-builtin')
  })

  it('runs what it resolved', async () => {
    const m = testMachine()
    write(m, '/work/script.mjs', '#!/usr/bin/env node\nconsole.log("args", process.argv.slice(2).join(" "))\n', 0o755)
    write(m, '/work/run.sh', '#!/bin/bash\necho "shell $1"\n', 0o755)
    write(m, '/work/hay.txt', 'needle\nhay\n')
    expect((await run(m, ['./script.mjs', 'a', 'b'])).stdout).toBe('args a b\n')
    expect((await run(m, ['./run.sh', 'arg'])).stdout).toBe('shell arg\n')
    expect((await run(m, ['grep', '-c', 'needle', 'hay.txt'])).stdout).toBe('1\n')
    expect(await run(m, ['which', 'node', 'nope'])).toMatchObject({ code: 1, stdout: '/usr/bin/node\n' })
    expect(() => m.kernel.spawn({ argv: ['nope'] })).toThrow(KernelError)
    expect(() => m.kernel.spawn({ argv: ['node'], cwd: '/does/not/exist' })).toThrow(/ENOENT/)
  })
})
