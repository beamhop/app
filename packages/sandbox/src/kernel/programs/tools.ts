// Small programs the kernel implements itself.
import type { Kernel } from '../kernel.js'
import type { Program, SyncRunContext, SyncRunResult } from '../process.js'

const enc = new TextEncoder()

/**
 * `which`. Implemented here rather than left to the shell because it can answer synchronously: harnesses probe
 * for tools with `spawnSync('which', [name])`, and a synchronous child is only possible for programs that
 * never need to wait.
 */
const which: Program = {
  kind: 'which',
  start(ctx) {
    const p = ctx.process
    const r = runWhich({ kernel: ctx.kernel, argv: p.argv, env: p.env, cwd: p.cwd, stdin: new Uint8Array(0) })
    p.stdout.write(r.stdout)
    ctx.exit(r.code)
  },
  runSync: runWhich,
}
function runWhich(ctx: SyncRunContext): SyncRunResult {
  const names = ctx.argv.slice(1).filter((a) => !a.startsWith('-'))
  let out = ''
  let missing = names.length === 0
  for (const name of names) {
    const path = ctx.kernel.which(name, ctx.cwd, ctx.env)
    if (path) out += path + '\n'
    else missing = true
  }
  return { code: missing ? 1 : 0, stdout: enc.encode(out), stderr: new Uint8Array(0) }
}

/** `xdg-open` / `open`: the machine cannot open a browser, so it asks the app to (login pages). */
const openUrl: Program = {
  kind: 'open-url',
  start(ctx) {
    const target = ctx.process.argv.slice(1).find((a) => !a.startsWith('-'))
    if (!target || !/^https?:\/\//.test(target)) {
      ctx.process.stderr.write(enc.encode(`${ctx.process.argv[0]}: only http(s) URLs can be opened from the machine\n`))
      return ctx.exit(2)
    }
    ctx.kernel.openUrl(target)
    ctx.exit(0)
  },
}

export function installTools(kernel: Kernel): void {
  kernel.install(which, ['/usr/bin/which'])
  kernel.install(openUrl, ['/usr/bin/xdg-open', '/usr/bin/open'])
}
