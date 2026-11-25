// Placement (b): one wasm process per worker. EVERY syscall (except args/environ, whose
// data arrives with the spawn message) is a postMessage round trip to the kernel worker
// over a MessagePort, awaited through JSPI. No SharedArrayBuffer, no Atomics.
const enc = new TextEncoder();

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  const { module, args, env, port } = data;
  let pending = null;
  port.onmessage = (ev) => {
    const r = pending;
    pending = null;
    r(ev.data);
  };
  // the process is single threaded and blocked during a syscall, so no request ids needed
  const call = (msg, transfer) =>
    new Promise((resolve) => {
      pending = resolve;
      port.postMessage(msg, transfer || []);
    });

  let memory;
  let u8 = new Uint8Array(0);
  let dv;
  const refresh = () => {
    if (u8.byteLength === 0) {
      u8 = new Uint8Array(memory.buffer);
      dv = new DataView(memory.buffer);
    }
  };
  const argv = args.map((s) => enc.encode(s + '\0'));
  const envv = env.map((s) => enc.encode(s + '\0'));
  const sizes = (list, pc, ps) => {
    refresh();
    dv.setUint32(pc, list.length, true);
    dv.setUint32(ps, list.reduce((a, b) => a + b.length, 0), true);
    return 0;
  };
  const fill = (list, pv, pb) => {
    refresh();
    for (const s of list) {
      dv.setUint32(pv, pb, true);
      u8.set(s, pb);
      pv += 4;
      pb += s.length;
    }
    return 0;
  };
  class ProcExit extends Error {
    constructor(code) { super('exit'); this.code = code; }
  }

  const wasi = {
    args_sizes_get: (pc, ps) => sizes(argv, pc, ps),
    args_get: (pv, pb) => fill(argv, pv, pb),
    environ_sizes_get: (pc, ps) => sizes(envv, pc, ps),
    environ_get: (pv, pb) => fill(envv, pv, pb),
    async fd_write(fd, iovs, n, pn) {
      refresh();
      // gather; the bytes must be copied out because memory cannot be shared
      let total = 0;
      for (let i = 0; i < n; i++) total += dv.getUint32(iovs + 8 * i + 4, true);
      const bytes = new Uint8Array(total);
      let o = 0;
      for (let i = 0; i < n; i++) {
        const p = dv.getUint32(iovs + 8 * i, true);
        const l = dv.getUint32(iovs + 8 * i + 4, true);
        bytes.set(u8.subarray(p, p + l), o);
        o += l;
      }
      const [errno, nw] = await call(['fd_write', fd, bytes], [bytes.buffer]);
      refresh();
      dv.setUint32(pn, nw, true);
      return errno;
    },
    async fd_read(fd, iovs, n, pn) {
      refresh();
      let total = 0;
      for (let i = 0; i < n; i++) total += dv.getUint32(iovs + 8 * i + 4, true);
      const [errno, bytes] = await call(['fd_read', fd, total]);
      if (errno) return errno;
      refresh();
      let o = 0;
      for (let i = 0; i < n && o < bytes.length; i++) {
        const p = dv.getUint32(iovs + 8 * i, true);
        const l = Math.min(dv.getUint32(iovs + 8 * i + 4, true), bytes.length - o);
        u8.set(bytes.subarray(o, o + l), p);
        o += l;
      }
      dv.setUint32(pn, o, true);
      return 0;
    },
    async fd_close(fd) {
      return (await call(['fd_close', fd]))[0];
    },
    async clock_time_get(id, _prec, p) {
      const [, ms] = await call(['clock_time_get', id]);
      refresh();
      const ns = ms * 1e6;
      dv.setUint32(p, ns % 4294967296, true);
      dv.setUint32(p + 4, ns / 4294967296, true);
      return 0;
    },
    async poll_oneoff(pin, pout, nsubs, pnev) {
      refresh();
      const ms = Number(dv.getBigUint64(pin + 24, true)) / 1e6;
      const ud = dv.getBigUint64(pin, true);
      await call(['sleep', ms]);
      refresh();
      u8.fill(0, pout, pout + 32);
      dv.setBigUint64(pout, ud, true);
      dv.setUint32(pnev, 1, true);
      return 0;
    },
    proc_exit(code) {
      throw new ProcExit(code);
    },
    random_get(p, l) {
      refresh();
      crypto.getRandomValues(u8.subarray(p, p + l));
      return 0;
    },
  };
  const spike = {
    nop: async (x) => (await call(['nop', x]))[1],
    nop_susp: async (x) => (await call(['nop', x]))[1],
    nop_async: async (x) => (await call(['nop', x]))[1],
  };
  const impl = { wasi_snapshot_preview1: wasi, spike };
  const imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') continue;
    const ns = (imports[imp.module] ??= {});
    const fn = impl[imp.module]?.[imp.name] || (() => 52);
    ns[imp.name] = fn.constructor.name === 'AsyncFunction' ? new WebAssembly.Suspending(fn) : fn;
  }
  const instance = new WebAssembly.Instance(module, imports);
  memory = instance.exports.memory;
  port.postMessage(['started']);
  let code = 0;
  let err;
  try {
    await WebAssembly.promising(instance.exports._start)();
  } catch (e) {
    if (e instanceof ProcExit) code = e.code;
    else { code = 134; err = `${e.constructor.name}: ${e.message}`; }
  }
  port.postMessage(['exit', code, err]);
  port.onmessage = null;
};
