import { describe, expect, it } from 'vitest'
import { run, testMachine, text, write } from './helpers.js'

describe('node program', () => {
  it('runs a CommonJS script with require, fs and process', async () => {
    const m = testMachine()
    write(m, '/work/lib.js', 'exports.double = (n) => n * 2')
    write(m, '/work/main.js', `
      const { double } = require('./lib')
      const fs = require('node:fs')
      fs.writeFileSync('out.txt', String(double(21)))
      console.log(process.argv.slice(2).join(','), fs.readFileSync('/work/out.txt', 'utf8'), __filename, require.main === module)
    `)
    const r = await run(m, ['node', 'main.js', 'a', 'b'])
    expect(r).toEqual({ code: 0, stdout: 'a,b 42 /work/main.js true\n', stderr: '' })
    expect(text(m.kernel.vfs.readFile('/work/out.txt'))).toBe('42')
  })

  it('runs ES modules written at run time through the transformer: live bindings, cycles, top-level await, import()', async () => {
    const m = testMachine()
    write(m, '/work/counter.mjs', 'export let count = 0\nexport function inc() { count++ }\nexport { later } from "./cycle.mjs"')
    write(m, '/work/cycle.mjs', 'import { inc } from "./counter.mjs"\nexport function later() { inc(); return "cycle" }')
    write(m, '/work/data.json', '{"n": 5}')
    write(m, '/work/cjs.cjs', 'module.exports = { named: 1 }')
    write(m, '/work/main.mjs', `
      import { count, inc, later } from './counter.mjs'
      import data from './data.json' with { type: 'json' }
      import cjs, { named } from './cjs.cjs'
      import { readFileSync } from 'node:fs'
      import * as path from 'node:path'
      inc(); later()
      const lazy = await import('./counter.mjs')
      await new Promise((r) => setTimeout(r, 5))
      console.log(count, lazy.count, data.n, cjs.named + named, typeof readFileSync, path.basename(import.meta.url), import.meta.dirname)
    `)
    const r = await run(m, ['node', 'main.mjs'])
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('2 2 5 2 function main.mjs /work\n')
    expect(r.code).toBe(0)
  })

  it('treats a .js file with module syntax and no package.json as ESM, like Node', async () => {
    const m = testMachine()
    write(m, '/work/script.js', 'import os from "node:os"\nexport const x = 1\nconsole.log(os.platform())')
    expect(await run(m, ['node', 'script.js'])).toMatchObject({ code: 0, stdout: 'linux\n' })
  })

  it('exits with the code from process.exit and drops output written afterwards', async () => {
    const m = testMachine()
    write(m, '/work/exit.js', 'process.on("exit", (c) => console.log("bye", c)); try { process.exit(3) } catch (e) { console.log("after") }')
    expect(await run(m, ['node', 'exit.js'])).toMatchObject({ code: 3, stdout: 'bye 3\n' })
  })

  it('reports an uncaught error on stderr and exits 1', async () => {
    const m = testMachine()
    write(m, '/work/boom.js', 'setTimeout(() => { throw new Error("boom") }, 1)')
    const r = await run(m, ['node', 'boom.js'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Uncaught Error: boom')
  })

  it('keeps running while a timer or stdin is pending, and reads stdin', async () => {
    const m = testMachine()
    write(m, '/work/echo.js', 'let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => setTimeout(() => console.log(s.toUpperCase()), 20))')
    expect(await run(m, ['node', 'echo.js'], { stdin: 'hello' })).toMatchObject({ code: 0, stdout: 'HELLO\n' })
  })

  it('gives each process its own globals', async () => {
    const m = testMachine()
    write(m, '/work/g.js', 'globalThis.process.title = process.argv[2]; setTimeout(() => console.log(process.title, typeof window, typeof self, typeof WebSocket, globalThis === global), 30)')
    const [a, b] = await Promise.all([run(m, ['node', 'g.js', 'one']), run(m, ['node', 'g.js', 'two'])])
    expect(a.stdout).toBe('one undefined undefined undefined true\n')
    expect(b.stdout).toBe('two undefined undefined undefined true\n')
  })

  it('supports node -e, -p and --version', async () => {
    const m = testMachine()
    expect((await run(m, ['node', '--version'])).stdout).toMatch(/^v22\./)
    expect((await run(m, ['node', '-e', 'console.log(require("path").join("a", "b"))'])).stdout).toBe('a/b\n')
    expect((await run(m, ['node', '-p', '1 + 1'])).stdout).toBe('2\n')
    expect((await run(m, ['node', '--input-type=module', '-e', 'import os from "node:os"; console.log(await Promise.resolve(os.EOL.length))'])).stdout).toBe('1\n')
    expect(m.kernel.vfs.readdir('/work')).toEqual([])
  })

  it('fails clearly for a missing module and a missing built-in', async () => {
    const m = testMachine()
    const r = await run(m, ['node', '-e', 'require("nope")'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("Cannot find module 'nope'")
    expect((await run(m, ['node', '-e', 'require("node:nope")'])).stderr).toContain('No such built-in module: node:nope')
  })
})

describe('child processes', () => {
  it('spawns the shell and reads its output and exit code', async () => {
    const m = testMachine()
    write(m, '/work/hello.txt', 'hello\n')
    write(m, '/work/sh.js', `
      const { spawn, exec } = require('child_process')
      const c = spawn('bash', ['-c', 'cat hello.txt && echo lines=$(wc -l < hello.txt); exit 4'])
      let out = ''; const events = []
      c.on('spawn', () => events.push('spawn'))
      c.stdout.on('data', (d) => (out += d))
      c.on('exit', (code) => events.push('exit' + code))
      c.on('close', (code) => exec('echo from-exec', (e, stdout) => console.log(JSON.stringify({ out, events, code, pid: typeof c.pid, stdout }))))
    `)
    const r = await run(m, ['node', 'sh.js'])
    expect(JSON.parse(r.stdout)).toEqual({ out: 'hello\nlines=1\n', events: ['spawn', 'exit4'], code: 4, pid: 'number', stdout: 'from-exec\n' })
  })

  it("reproduces Node's ENOENT sequence: no 'spawn', then 'error', then 'close'", async () => {
    const m = testMachine()
    write(m, '/work/enoent.js', `
      const c = require('child_process').spawn('no-such-program', ['x'])
      const events = []
      c.on('spawn', () => events.push('spawn'))
      c.on('error', (e) => events.push('error:' + e.code + ':' + e.syscall + ':' + (c.pid === undefined)))
      c.on('exit', () => events.push('exit'))
      c.stdout.on('close', () => events.push('stdout-close'))
      c.on('close', (code) => { events.push('close:' + code); console.log(events.join(' ')) })
    `)
    expect((await run(m, ['node', 'enoent.js'])).stdout).toBe('error:ENOENT:spawn no-such-program:true stdout-close close:-2\n')
  })

  it('runs a Node child, pipes stdin to it, and inherits stdio', async () => {
    const m = testMachine()
    write(m, '/work/child.js', 'process.stdin.on("data", (d) => process.stdout.write("child:" + d)); process.stdin.on("end", () => process.exit(7))')
    write(m, '/work/parent.js', `
      const c = require('child_process').spawn(process.execPath, ['child.js'], { stdio: ['pipe', 'inherit', 'inherit'] })
      c.stdin.end('ping')
      c.on('close', (code) => console.log(' parent:' + code))
    `)
    expect(await run(m, ['node', 'parent.js'])).toMatchObject({ code: 0, stdout: 'child:ping parent:7\n' })
  })

  it('lets bash scripts call node', async () => {
    const m = testMachine()
    write(m, '/work/n.mjs', 'console.log("from node", process.argv[2])')
    expect(await run(m, ['bash', '-c', 'node n.mjs $((1+1)) | tr a-z A-Z'])).toMatchObject({ code: 0, stdout: 'FROM NODE 2\n' })
  })

  it('answers spawnSync("which") synchronously and reports other sync children as missing', async () => {
    const logs: string[] = []
    const m2 = testMachine({ logs })
    write(m2, '/work/sync.js', `
      const cp = require('child_process')
      const a = cp.spawnSync('which', ['node'], { encoding: 'utf8' })
      const b = cp.spawnSync('which', ['bwrap'])
      const c = cp.spawnSync('bash', ['-c', 'echo hi'])
      let d; try { cp.execSync('git status') } catch (e) { d = e.code }
      console.log(a.status, a.stdout.trim(), b.status, c.status, c.error.code, d, cp.execSync('command -v cat').toString().trim())
    `)
    expect((await run(m2, ['node', 'sync.js'])).stdout).toBe('0 /usr/bin/node 1 null ENOENT ENOENT /usr/bin/cat\n')
    expect(logs.join('\n')).toContain('synchronous child process')
  })

  it('kills a child: the parent sees the signal, the child stops producing output', async () => {
    const m = testMachine()
    write(m, '/work/loop.js', 'setInterval(() => console.log("tick"), 5)')
    write(m, '/work/killer.js', `
      const c = require('child_process').spawn('node', ['loop.js'])
      let ticks = 0
      c.stdout.on('data', () => { if (++ticks === 2) c.kill('SIGKILL') })
      c.on('close', (code, signal) => console.log(code, signal, c.killed))
    `)
    expect((await run(m, ['node', 'killer.js'])).stdout).toBe('null SIGKILL true\n')
  })
})
