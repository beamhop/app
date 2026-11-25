// Assembles a machine: a kernel with its userland (shell, tools, node) and the image mounting that goes with
// it. The frame worker builds one of these; tests and, later, the desktop bridge build one directly under Node.
import type { TransformResult } from './esm/transform.js'
import type { DecodedImage } from './image/format.js'
import { ImageFs } from './kernel/imagefs.js'
import { Kernel, type KernelOptions } from './kernel/kernel.js'
import { installShell } from './kernel/programs/shell.js'
import { installTools } from './kernel/programs/tools.js'
import { createNodeProgram, type NodeProgramOptions } from './node/index.js'

export interface MachineOptions extends KernelOptions {
  /** The ES module transformer for files with no precompiled form. Loaded lazily by the caller's means. */
  loadTransformer(): (source: string, filename: string) => TransformResult
  onNodeStats?: NodeProgramOptions['onStats']
}

export interface Machine {
  kernel: Kernel
  /** Mount a decoded image read-only at `at`, register its compile cache, and link its executables into /usr/bin. */
  mountImage(at: string, image: DecodedImage): { files: number; bytes: number }
}

export function createMachine(options: MachineOptions): Machine {
  const kernel = new Kernel(options)
  const esmCache = new Map<string, Uint8Array>()
  // Order matters: later installs replace the shell's stub of the same name (its own `which`, for one).
  const shell = installShell(kernel, { external: ['node', 'xdg-open', 'open'] })
  installTools(kernel)
  kernel.install(createNodeProgram({ esmCache, loadTransformer: options.loadTransformer, onStats: options.onNodeStats }), ['/usr/bin/node'])

  return {
    kernel,
    mountImage(at, image) {
      const fs = new ImageFs(image)
      kernel.vfs.mount(at, fs)
      const root = kernel.vfs.realpath(at)
      for (const [path, offset, length] of image.index.esm) esmCache.set(`${root}/${path}`, image.blob.subarray(offset, offset + length))
      // meta.bin: { "<command>": "<path inside the image>" }, written by the image builder from the package's "bin".
      const bin = image.index.meta.bin
      if (bin && typeof bin === 'object') {
        for (const [name, target] of Object.entries(bin as Record<string, unknown>)) {
          if (typeof target !== 'string' || !/^[\w.@-]+$/.test(name)) continue
          // /usr/bin, not /usr/local/bin: that is where the shell maps executables to commands (see installShell).
          const link = '/usr/bin/' + name
          if (kernel.vfs.kindOf(link, false) !== null) kernel.vfs.unlink(link)
          kernel.vfs.symlink(`${root}/${target}`, link)
          shell.addExternal(name)
        }
      }
      return { files: fs.fileCount, bytes: fs.byteLength }
    },
  }
}
