// What the polyfill packages (readable-stream, util, assert) see as the global `process`. The build injects
// this module for their free `process` references. It is deliberately not tied to any one Node process:
// several can live in the worker, and the polyfills only need scheduling and a few constants.

/** Set by the Node layer: where an exception thrown by a nextTick callback goes. */
export const shimHooks: { onError: (error: unknown) => void } = {
  onError(error) {
    queueMicrotask(() => {
      throw error
    })
  },
}

const shim = {
  nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void {
    queueMicrotask(() => {
      try {
        fn(...args)
      } catch (e) {
        shimHooks.onError(e)
      }
    })
  },
  env: {} as Record<string, string | undefined>,
  platform: 'linux',
  version: 'v22.12.0',
  versions: { node: '22.12.0' },
  stdout: undefined,
  stderr: undefined,
  cwd: () => '/',
  emitWarning: () => {},
  browser: false,
  argv: [] as string[],
  binding: () => {
    throw new Error('process.binding is not supported')
  },
}
export default shim
export { shim as process }
