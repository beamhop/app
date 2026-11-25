import { describe, expect, it } from 'vitest'
import { KernelError } from '../src/kernel/errors.js'
import { Pipe } from '../src/kernel/pipe.js'
import type { Program } from '../src/kernel/process.js'
import { bytes, run, testMachine, text, write } from './helpers.js'

describe('Pipe', () => {
  it('delivers bytes in order through try-read, async read and push mode', async () => {
    const p = new Pipe()
    expect(p.tryRead()).toBeNull()
    p.write(bytes('a'))
    p.write(bytes('b'))
    expect(text(p.tryRead()!)).toBe('a')
    expect(text((await p.read())!)).toBe('b')
    const pending = p.read()
    p.write(bytes('c'))
    expect(text((await pending)!)).toBe('c')
    p.write(bytes('d'))
    p.end()
    expect(p.readableEnded).toBe(false) // 'd' is still buffered
    const seen: (string | null)[] = []
    p.pipeTo((chunk) => seen.push(chunk && text(chunk)))
    expect(seen).toEqual(['d', null])
    expect(p.readableEnded).toBe(true)
    p.write(bytes('ignored after end'))
    expect(p.bytesWritten).toBe(4)
  })

  it('reports backpressure and resolves drained() once the reader catches up', async () => {
    const p = new Pipe(4)
    expect(p.write(bytes('12'))).toBe(true)
    expect(p.write(bytes('345'))).toBe(false)
    let drained = false
    void p.drained().then(() => (drained = true))
    await Promise.resolve()
    expect(drained).toBe(false)
    p.tryRead()
    await Promise.resolve()
    expect(drained).toBe(true)
    expect(text(await (p.end(), p.readAll()))).toBe('345')
  })
})

describe('process table', () => {
  /** A program that echoes stdin until it ends; handles SIGUSR1 itself. */
  const echo: Program = {
    kind: 'test-echo',
    start(ctx) {
      const p = ctx.process
      p.signalHandler = (signal) => {
        if (signal !== 'SIGUSR1') return false
        p.stdout.write(bytes('[usr1]'))
        return true
      }
      p.stdin.pipeTo((chunk) => (chunk ? p.stdout.write(chunk) : ctx.exit(Number(p.argv[1] ?? 0))))
    },
  }

  it('tracks a process from spawn to exit, with argv, env, cwd and stdio', async () => {
    const m = testMachine()
    m.kernel.install(echo, ['/usr/bin/echo-test'])
    const events: string[] = []
    m.kernel.on({ spawn: (p) => events.push(`spawn ${p.pid}`), exit: (p, s) => events.push(`exit ${p.pid} ${s.code}`) })
    const proc = m.kernel.spawn({ argv: ['echo-test', '7'], env: { PATH: '/usr/bin', X: '1' }, cwd: '/tmp' })
    expect({ argv: proc.argv, env: proc.env, cwd: proc.cwd, path: proc.path, kind: proc.kind, running: proc.running }).toEqual({ argv: ['echo-test', '7'], env: { PATH: '/usr/bin', X: '1' }, cwd: '/tmp', path: '/usr/bin/echo-test', kind: 'test-echo', running: true })
    expect(m.kernel.get(proc.pid)).toBe(proc)
    expect(m.kernel.list()).toContain(proc)
    proc.stdin.write(bytes('hi'))
    proc.stdin.end()
    expect(await proc.exited).toEqual({ code: 7 })
    expect(text(await proc.stdout.readAll())).toBe('hi')
    await Promise.resolve()
    expect(m.kernel.get(proc.pid)).toBeUndefined()
    expect(events).toEqual([`spawn ${proc.pid}`, `exit ${proc.pid} 7`])
  })

  it('delivers signals to a handler, terminates otherwise, and SIGKILL always terminates', async () => {
    const m = testMachine()
    m.kernel.install(echo, ['/usr/bin/echo-test'])
    const a = m.kernel.spawn({ argv: ['echo-test'] })
    await new Promise((r) => setTimeout(r, 5))
    m.kernel.kill(a.pid, 'SIGUSR1') // handled: still running
    expect(a.running).toBe(true)
    m.kernel.kill(a.pid, 0) // existence test
    m.kernel.kill(a.pid, 'SIGTERM')
    expect(await a.exited).toEqual({ code: 143, signal: 'SIGTERM' })
    expect(a.terminated.aborted).toBe(true)
    expect(text(await a.stdout.readAll())).toBe('[usr1]')
    expect(() => m.kernel.kill(a.pid)).toThrow(KernelError)
    const b = m.kernel.spawn({ argv: ['echo-test'] })
    m.kernel.kill(b.pid, 9)
    expect(await b.exited).toEqual({ code: 137, signal: 'SIGKILL' })
    expect(() => m.kernel.kill(99999)).toThrow(/ESRCH/)
  })

  it('gives stdin:"none" processes an ended stdin and hangs up children when the parent exits', async () => {
    const m = testMachine()
    m.kernel.install(echo, ['/usr/bin/echo-test'])
    expect(await m.kernel.spawn({ argv: ['echo-test', '3'], stdin: 'none' }).exited).toEqual({ code: 3 })
    const parent = m.kernel.spawn({ argv: ['echo-test'] })
    const child = m.kernel.spawn({ argv: ['echo-test'], ppid: parent.pid })
    parent.stdin.end()
    await parent.exited
    expect(await child.exited).toEqual({ code: 129, signal: 'SIGHUP' })
  })

  it('runs programs synchronously only when they can finish without waiting', () => {
    const m = testMachine()
    const r = m.kernel.runSync(['which', 'bash'])
    expect(r && { code: r.code, stdout: text(r.stdout) }).toEqual({ code: 0, stdout: '/usr/bin/bash\n' })
    expect(m.kernel.runSync(['bash', '-c', 'echo hi'])).toBeUndefined()
    expect(() => m.kernel.runSync(['nope'])).toThrow(/ENOENT/)
  })
})

describe('shell', () => {
  it('runs scripts from -c, from a file and from stdin, with env and cwd', async () => {
    const m = testMachine()
    write(m, '/work/s.sh', 'echo "file $1 $PWD"')
    expect((await run(m, ['bash', '-c', 'echo "$GREETING from $PWD"'], { env: { GREETING: 'hi' }, cwd: '/tmp' })).stdout).toBe('hi from /tmp\n')
    expect((await run(m, ['bash', '-c', '-l', 'echo login-form'])).stdout).toBe('login-form\n')
    expect((await run(m, ['bash', '-lc', 'echo combined-form'])).stdout).toBe('combined-form\n')
    expect((await run(m, ['sh', 's.sh', 'arg'])).stdout).toBe('file arg /work\n')
    expect((await run(m, ['bash'], { stdin: 'echo from-stdin; exit 2' }))).toMatchObject({ code: 2, stdout: 'from-stdin\n' })
    expect((await run(m, ['bash', '-c', 'cat'], { stdin: 'piped input' })).stdout).toBe('piped input')
    expect(await run(m, ['bash', '-c', 'nonexistent-tool'])).toMatchObject({ code: 127 })
  })

  it('shares the file system with everything else and asks the app to open URLs', async () => {
    const opened: string[] = []
    const m = testMachine()
    m.kernel.openUrl = (url) => opened.push(url)
    await run(m, ['bash', '-c', 'mkdir -p out && echo data > out/f.txt && xdg-open https://example.com/login'])
    expect(text(m.kernel.vfs.readFile('/work/out/f.txt'))).toBe('data\n')
    expect(opened).toEqual(['https://example.com/login'])
    expect(await run(m, ['xdg-open', 'file:///etc/passwd'])).toMatchObject({ code: 2 })
  })

  it('can be killed while a script runs', async () => {
    const m = testMachine()
    const proc = m.kernel.spawn({ argv: ['bash', '-c', 'sleep 30; echo done'], stdin: 'none' })
    setTimeout(() => m.kernel.kill(proc.pid), 20)
    expect(await proc.exited).toEqual({ code: 143, signal: 'SIGTERM' })
    expect(text(await proc.stdout.readAll())).toBe('')
  })
})
