// Shared by the unit tests: a machine running under Node, with no network unless a broker is given.
import { transformEsm } from '../src/esm/transform.js'
import type { NetBroker, NetMode } from '../src/kernel/net.js'
import { createMachine, type Machine } from '../src/machine.js'

export const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

export function testMachine(opts: { net?: NetBroker; netMode?: NetMode; logs?: string[] } = {}): Machine {
  return createMachine({ loadTransformer: () => transformEsm, net: opts.net, netMode: opts.netMode, log: (level, message) => opts.logs?.push(`${level}: ${message}`) })
}

export interface RunResult {
  code: number
  signal?: string
  stdout: string
  stderr: string
}
/** Spawn a command and wait for it, collecting its output. */
export async function run(machine: Machine, argv: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}): Promise<RunResult> {
  const proc = machine.kernel.spawn({ argv, cwd: opts.cwd, env: opts.env ? { ...machine.kernel.env, ...opts.env } : undefined })
  if (opts.stdin !== undefined) proc.stdin.write(bytes(opts.stdin))
  proc.stdin.end()
  const [stdout, stderr, status] = await Promise.all([proc.stdout.readAll(), proc.stderr.readAll(), proc.exited])
  return { ...status, stdout: text(stdout), stderr: text(stderr) }
}
export function write(machine: Machine, path: string, content: string, mode = 0o644): void {
  machine.kernel.vfs.writeFileDeep(path, bytes(content), { mode })
}
