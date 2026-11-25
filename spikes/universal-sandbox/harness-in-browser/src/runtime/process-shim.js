// Module that polyfill packages (readable-stream, util, assert) import as `process`. Delegates to the live process object.
export const holder = { process: null };
const shim = {
  nextTick: (fn, ...args) => (holder.process ? holder.process.nextTick(fn, ...args) : queueMicrotask(() => fn(...args))),
  get env() { return holder.process ? holder.process.env : {}; },
  get platform() { return 'linux'; },
  get version() { return 'v22.12.0'; },
  get versions() { return { node: '22.12.0' }; },
  get stdout() { return holder.process && holder.process.stdout; },
  get stderr() { return holder.process && holder.process.stderr; },
  cwd: () => (holder.process ? holder.process.cwd() : '/'),
  emitWarning: () => {},
  browser: false,
  argv: [],
  binding: () => { throw new Error('process.binding unsupported'); },
};
export default shim;
export const process = shim;
