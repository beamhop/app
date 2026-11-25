// `bash`, `sh` and the usual command-line tools, provided by just-bash: a bash interpreter written in
// TypeScript that runs in this thread against the kernel's VFS. Until wasm tools exist this is the machine's
// whole userland besides `node`.
//
// Limits that follow from just-bash: a script's output is delivered when the script finishes, not as it is
// produced; only its built-in commands (plus the kernel programs listed as `external`) exist; there is no `trap`.
import { Buffer } from 'buffer'
import { Bash, defineCommand, getCommandNames } from 'just-bash/browser'
import type { Kernel } from '../kernel.js'
import { resolve } from '../path.js'
import type { Process, ProcessContext, Program } from '../process.js'

const SHELL_NAMES = ['bash', 'sh', 'dash', 'zsh']

export const shQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** just-bash's file system interface (its IFileSystem), implemented directly on the VFS. */
function fsAdapter(kernel: Kernel) {
  const vfs = kernel.vfs
  type Enc = string | { encoding?: string } | undefined
  const encodingOf = (o: Enc): BufferEncoding => {
    const e = (typeof o === 'string' ? o : o?.encoding) ?? 'utf8'
    return (e === 'binary' ? 'latin1' : e) as BufferEncoding
  }
  const bytesOf = (content: string | Uint8Array, o: Enc): Uint8Array => (typeof content === 'string' ? new Uint8Array(Buffer.from(content, encodingOf(o))) : content.slice())
  const statOf = (path: string, follow: boolean) => {
    const s = follow ? vfs.stat(path) : vfs.lstat(path)
    return { isFile: s.kind === 'file', isDirectory: s.kind === 'dir', isSymbolicLink: s.kind === 'symlink', mode: s.mode, size: s.size, mtime: new Date(s.mtimeMs), ino: s.ino, dev: 1 }
  }
  return {
    async readFile(p: string, o?: Enc) {
      return Buffer.from(vfs.readFile(p)).toString(encodingOf(o))
    },
    async readFileBuffer(p: string) {
      return vfs.readFile(p).slice()
    },
    async writeFile(p: string, content: string | Uint8Array, o?: Enc) {
      vfs.writeFile(p, bytesOf(content, o))
    },
    async appendFile(p: string, content: string | Uint8Array, o?: Enc) {
      vfs.writeFile(p, bytesOf(content, o), { flag: 'a' })
    },
    async exists(p: string) {
      return vfs.exists(p)
    },
    async stat(p: string) {
      return statOf(p, true)
    },
    async lstat(p: string) {
      return statOf(p, false)
    },
    async mkdir(p: string, o?: { recursive?: boolean }) {
      vfs.mkdir(p, o)
    },
    async readdir(p: string) {
      return vfs.readdir(p).map((e) => e.name).sort()
    },
    async readdirWithFileTypes(p: string) {
      return vfs
        .readdir(p)
        .map((e) => ({ name: e.name, isFile: e.kind === 'file', isDirectory: e.kind === 'dir', isSymbolicLink: e.kind === 'symlink' }))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
    },
    async rm(p: string, o?: { recursive?: boolean; force?: boolean }) {
      vfs.rm(p, o)
    },
    async cp(a: string, b: string) {
      vfs.copy(a, b)
    },
    async mv(a: string, b: string) {
      vfs.rename(a, b)
    },
    resolvePath(base: string, p: string) {
      return resolve(base, p)
    },
    getAllPaths() {
      // Used for glob expansion hints; image mounts (node_modules trees) are skipped to keep it cheap.
      const out: string[] = []
      const mounts = new Set(vfs.mountPoints())
      const walk = (dir: string) => {
        for (const e of vfs.readdir(dir)) {
          const full = (dir === '/' ? '' : dir) + '/' + e.name
          out.push(full)
          if (e.kind === 'dir' && e.name !== 'node_modules' && !mounts.has(full)) walk(full)
        }
      }
      walk('/')
      return out
    },
    async chmod(p: string, mode: number) {
      vfs.chmod(p, mode)
    },
    async symlink(target: string, p: string) {
      vfs.symlink(target, p)
    },
    async link(a: string, b: string) {
      vfs.link(a, b)
    },
    async readlink(p: string) {
      return vfs.readlink(p)
    },
    async realpath(p: string) {
      return vfs.realpath(p)
    },
    async utimes(p: string, atime: Date, mtime: Date) {
      vfs.utimes(p, +atime, +mtime)
    },
  }
}

export interface ShellOptions {
  /** Names of other kernel programs that scripts may call (`node`, ...). Each runs as a child process. */
  external?: string[]
}

/**
 * Install the shell and its tools: `bash`/`sh` as one program kind, and every just-bash built-in as an
 * executable of its own, so `spawn('cat', …)` and PATH lookups behave as on a real system.
 */
export function installShell(kernel: Kernel, opts: ShellOptions = {}): void {
  const builtinNames = new Set<string>(getCommandNames())
  let bash: Bash | null = null

  // A kernel program exposed as a shell command: spawn it, hand over stdin, collect its output.
  const externalCommand = (name: string) =>
    defineCommand(name, async (args, ctx) => {
      // just-bash's context type differs between versions (env is a Map in some); read it structurally.
      const c = ctx as unknown as { cwd: string; env: Map<string, string> | Record<string, string>; stdin?: string }
      const env = c.env instanceof Map ? Object.fromEntries(c.env) : { ...c.env }
      let child: Process
      try {
        child = kernel.spawn({ argv: [name, ...args], env, cwd: c.cwd })
      } catch (e) {
        return { stdout: '', stderr: `${name}: ${e instanceof Error ? e.message : String(e)}\n`, exitCode: 127 }
      }
      if (c.stdin) child.stdin.write(new Uint8Array(Buffer.from(String(c.stdin), 'latin1')))
      child.stdin.end()
      const [stdout, stderr, status] = await Promise.all([child.stdout.readAll(), child.stderr.readAll(), child.exited])
      return { stdout: Buffer.from(stdout).toString('utf8'), stderr: Buffer.from(stderr).toString('utf8'), exitCode: status.code }
    })

  const getBash = (): Bash => {
    // defenseInDepth patches globals while a script runs; it must be off when the shell shares a realm with Node programs.
    bash ??= new Bash({
      fs: fsAdapter(kernel) as unknown as NonNullable<ConstructorParameters<typeof Bash>[0]>['fs'],
      cwd: '/work',
      env: { ...kernel.env },
      defenseInDepth: false,
      customCommands: (opts.external ?? []).map(externalCommand),
    })
    return bash
  }

  async function run(ctx: ProcessContext, script: string | null): Promise<void> {
    const proc = ctx.process
    const abort = new AbortController()
    proc.terminated.addEventListener('abort', () => abort.abort(), { once: true })
    let stdin: Uint8Array
    if (script === null) {
      script = Buffer.from(await proc.stdin.readAll()).toString('utf8')
      stdin = new Uint8Array(0)
    } else {
      // Give the parent one turn to write the child's input, then run with what has arrived. A script that
      // reads more input than that sees end of file: just-bash takes stdin as a whole, up front.
      if (!proc.stdin.readableEnded) await new Promise((r) => setTimeout(r, 0))
      const chunks: Uint8Array[] = []
      for (let c = proc.stdin.tryRead(); c; c = proc.stdin.tryRead()) chunks.push(c)
      stdin = Buffer.concat(chunks)
    }
    if (!proc.running) return
    const enc = new TextEncoder()
    try {
      const result = await getBash().exec(script, {
        cwd: proc.cwd,
        env: proc.env,
        replaceEnv: true,
        rawScript: true,
        signal: abort.signal,
        stdin: stdin.byteLength ? Buffer.from(stdin).toString('latin1') : undefined,
        stdinKind: 'bytes',
      })
      if (!proc.running) return
      if (result.stdout) proc.stdout.write(result.stdoutKind === 'bytes' ? new Uint8Array(Buffer.from(result.stdout, 'latin1')) : enc.encode(result.stdout))
      if (result.stderr) proc.stderr.write(enc.encode(result.stderr))
      ctx.exit(result.exitCode)
    } catch (e) {
      if (!proc.running) return
      proc.stderr.write(enc.encode(`${proc.argv[0]}: ${e instanceof Error ? e.message : String(e)}\n`))
      ctx.exit(1)
    }
  }

  const shell: Program = {
    kind: 'shell',
    start(ctx) {
      const args = ctx.process.argv.slice(1)
      // `bash -c -l 'script'` and `bash -lc 'script'` are both in use: the script is the first non-option argument.
      const hasC = args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
      const rest = args.filter((a, i) => !(a.startsWith('-') && a.length > 1) && !(i > 0 && (args[i - 1] === '-o' || args[i - 1] === '-O')))
      let script: string | null
      if (hasC) script = rest[0] ?? ''
      else if (rest[0]) script = `source ${shQuote(rest[0])} ${rest.slice(1).map(shQuote).join(' ')}`
      else script = null // read the script from stdin
      void run(ctx, script)
    },
  }
  const builtin: Program = {
    kind: 'shell-builtin',
    start(ctx) {
      const [name, ...args] = ctx.process.argv
      void run(ctx, [name.slice(name.lastIndexOf('/') + 1), ...args].map(shQuote).join(' '))
    },
  }
  kernel.install(builtin, [...builtinNames].filter((n) => !SHELL_NAMES.includes(n)).map((n) => '/usr/bin/' + n))
  kernel.install(shell, SHELL_NAMES.map((n) => '/usr/bin/' + n))
  kernel.setNativeFallback((name) => (builtinNames.has(name) ? builtin : undefined))
}
