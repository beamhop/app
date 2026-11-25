// Minimal sandbox "kernel": pipes, in-memory files, process table, WASI preview1 subset.
// Runs inside ONE dedicated worker. No SharedArrayBuffer, no Atomics.
//
// Placement (a) "coroutine": wasm instance lives in this worker. Non-blocking syscalls are
//   plain synchronous JS calls. The potentially blocking imports (fd_read, fd_write,
//   poll_oneoff, spike.waitpid) are wrapped in WebAssembly.Suspending and return either a
//   plain number (no suspension) or a Promise (the instance's stack is suspended).
// Placement (b) "worker": wasm instance lives in its own worker (proc-worker.js); every
//   syscall arrives here as a message on a MessagePort and is answered with a message.

export const E = { SUCCESS: 0, AGAIN: 6, BADF: 8, INVAL: 28, NOSYS: 52, PIPE: 64 };
const BLOCK = -1; // "would block" result of file.read/file.write
const EPIPE = -2;
const NEVER = new Promise(() => {});

export class ProcExit extends Error {
  constructor(code) {
    super('proc_exit ' + code);
    this.code = code;
  }
}

// ---------------------------------------------------------------- files

class NullFile {
  refs = 0;
  read() { return 0; }
  write(_u8, _p, l) { return l; }
  close() {}
}

export class MemFile {
  refs = 0;
  chunks = [];
  size = 0;
  read() { return 0; }
  write(u8, p, l) {
    this.chunks.push(u8.slice(p, p + l));
    this.size += l;
    return l;
  }
  close() {}
  text() {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return new TextDecoder().decode(out);
  }
}

export class Pipe {
  constructor(cap) {
    this.cap = cap;
    this.buf = new Uint8Array(cap);
    this.rpos = 0;
    this.len = 0;
    this.readers = 0;
    this.writers = 0;
    this.rq = []; // resolve fns of blocked readers
    this.wq = []; // resolve fns of blocked writers
    this.totalRead = 0;
    this.r = new PipeReadEnd(this);
    this.w = new PipeWriteEnd(this);
  }
}
function wake(q) {
  for (let i = 0; i < q.length; i++) q[i]();
  q.length = 0;
}
function waitOn(q, proc) {
  return new Promise((resolve) => {
    q.push(resolve);
    // kill support: forget the waiter so nothing references the suspended stack any more
    proc.cancelWait = () => {
      const i = q.indexOf(resolve);
      if (i >= 0) q.splice(i, 1);
    };
  });
}
class PipeReadEnd {
  refs = 0;
  constructor(pipe) { this.pipe = pipe; }
  open() { this.refs++; this.pipe.readers++; return this; }
  read(u8, p, l) {
    const pipe = this.pipe;
    if (pipe.len === 0) return pipe.writers === 0 ? 0 : BLOCK;
    const n = l < pipe.len ? l : pipe.len;
    const first = Math.min(n, pipe.cap - pipe.rpos);
    u8.set(pipe.buf.subarray(pipe.rpos, pipe.rpos + first), p);
    if (first < n) u8.set(pipe.buf.subarray(0, n - first), p + first);
    pipe.rpos = (pipe.rpos + n) % pipe.cap;
    pipe.len -= n;
    pipe.totalRead += n;
    if (pipe.wq.length) wake(pipe.wq);
    return n;
  }
  write() { return EPIPE; }
  wait(proc) { return waitOn(this.pipe.rq, proc); }
  close() { this.pipe.readers--; if (this.pipe.readers === 0) wake(this.pipe.wq); }
}
class PipeWriteEnd {
  refs = 0;
  constructor(pipe) { this.pipe = pipe; }
  open() { this.refs++; this.pipe.writers++; return this; }
  read() { return 0; }
  write(u8, p, l) {
    const pipe = this.pipe;
    if (pipe.readers === 0) return EPIPE;
    const space = pipe.cap - pipe.len;
    if (space === 0) return BLOCK;
    const n = l < space ? l : space;
    const wpos = (pipe.rpos + pipe.len) % pipe.cap;
    const first = Math.min(n, pipe.cap - wpos);
    pipe.buf.set(u8.subarray(p, p + first), wpos);
    if (first < n) pipe.buf.set(u8.subarray(p + first, p + n), 0);
    pipe.len += n;
    if (pipe.rq.length) wake(pipe.rq);
    return n;
  }
  wait(proc) { return waitOn(this.pipe.wq, proc); }
  close() { this.pipe.writers--; if (this.pipe.writers === 0) wake(this.pipe.rq); }
}

// ---------------------------------------------------------------- kernel

const SUSPENDING = new Set([
  'wasi_snapshot_preview1.fd_read',
  'wasi_snapshot_preview1.fd_write',
  'wasi_snapshot_preview1.poll_oneoff',
  'spike.waitpid',
  'spike.nop_susp',
  'spike.nop_async',
]);
const enc = new TextEncoder();
const dec = new TextDecoder();

// Fast-path shim, hand-assembled (no linear memory, ~150 bytes). One instance per process,
// linked wasm-to-wasm between an UNMODIFIED wasip1 guest and the kernel:
//
//   (func (export "fd_write") (param i32 i32 i32 i32) (result i32) (local i32)
//     (local.tee 4 (call $try_fd_write (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
//     (if (result i32) (i32.ge_s (i32.const 0))
//       (then (local.get 4))
//       (else (call $slow_fd_write (local.get 0) (local.get 1) (local.get 2) (local.get 3)))))
//   ... same for fd_read.
//
// Why: in Chromium 158 an import wrapped in WebAssembly.Suspending suspends+resumes the
// stack on EVERY call, even when the JS function returns a plain number. With the shim only
// calls that really block reach a Suspending import; the common case is a plain JS call.
function buildShimModule() {
  const str = (s) => [s.length, ...enc.encode(s)];
  const section = (id, body) => [id, body.length, ...body];
  const imp = (name) => [...str('k'), ...str(name), 0x00, 0x00];
  const body = (tryIdx, slowIdx) => {
    const args = [0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3];
    const code = [0x01, 0x01, 0x7f, ...args, 0x10, tryIdx, 0x22, 4, 0x41, 0x00, 0x4e, 0x04, 0x7f, 0x20, 4, 0x05, ...args, 0x10, slowIdx, 0x0b, 0x0b];
    return [code.length, ...code];
  };
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, 0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f]),
    ...section(2, [0x04, ...imp('try_fd_write'), ...imp('slow_fd_write'), ...imp('try_fd_read'), ...imp('slow_fd_read')]),
    ...section(3, [0x02, 0x00, 0x00]),
    ...section(7, [0x02, ...str('fd_write'), 0x00, 4, ...str('fd_read'), 0x00, 5]),
    ...section(10, [0x02, ...body(0, 1), ...body(2, 3)]),
  ];
  return new WebAssembly.Module(new Uint8Array(bytes));
}

export class Kernel {
  constructor() {
    this.modules = {}; // name -> WebAssembly.Module
    this.shimModule = buildShimModule();
    this.procs = new Map(); // pid -> proc (live)
    this.nextPid = 1;
    // suspends: kernel-level blocks (a Promise was returned). suspendingCalls: calls that
    // went through a WebAssembly.Suspending import (each one suspends+resumes the stack in
    // Chromium, whether or not the kernel blocked).
    this.stats = { syscalls: 0, suspends: 0, switches: 0, remoteSyscalls: 0, suspendingCalls: 0 };
    // true: fd_read/fd_write go through the wasm fast-path shim (buildShimModule) so that only
    // calls that really block touch a Suspending import. false: they are Suspending directly.
    this.useShim = true;
    this.lastPid = 0;
    this.sliceMs = 0; // 0 = never yield to the event loop voluntarily
    this.lastYield = 0;
    this.macrotaskYields = 0;
    this._mc = new MessageChannel();
    this._mcq = [];
    this._mc.port1.onmessage = () => {
      const q = this._mcq;
      this._mcq = [];
      this.lastYield = performance.now();
      for (const f of q) f();
    };
    this.onExit = null; // optional hook (proc) => void
  }

  macrotask() {
    return new Promise((r) => {
      this._mcq.push(r);
      if (this._mcq.length === 1) this._mc.port2.postMessage(0);
    });
  }

  nullFile() { return new NullFile(); }
  memFile() { return new MemFile(); }
  pipe(cap = 4096) { return new Pipe(cap); }

  _newProc(name, args, opts) {
    const proc = {
      pid: this.nextPid++,
      name,
      args: [name, ...args],
      env: opts.env || [],
      fds: [],
      state: 'running',
      exitCode: null,
      error: null,
      suspends: 0,
      cancelWait: null,
      dead: false,
      placement: 'a',
      useShim: opts.shim ?? this.useShim,
      instance: null,
      memory: null,
      worker: null,
      waiters: [],
    };
    const fds = opts.fds || [];
    for (let i = 0; i < fds.length; i++) {
      const f = fds[i];
      if (!f) continue;
      if (f.open) f.open(); else f.refs++;
      proc.fds[i] = f;
    }
    proc.exited = new Promise((r) => proc.waiters.push(r));
    this.procs.set(proc.pid, proc);
    return proc;
  }

  closeFd(proc, fd) {
    const f = proc.fds[fd];
    if (!f) return E.BADF;
    proc.fds[fd] = undefined;
    if (f.open) { f.refs--; f.close(); } else f.refs--;
    return 0;
  }

  // Tear a process down: close fds (peers see EOF/EPIPE), drop every reference to the
  // instance so its memory and (if suspended) its stack become garbage.
  _finish(proc, code, state, error) {
    if (proc.dead) return;
    proc.dead = true;
    proc.state = state;
    proc.exitCode = code;
    proc.error = error || null;
    for (let fd = 0; fd < proc.fds.length; fd++) if (proc.fds[fd]) this.closeFd(proc, fd);
    proc.instance = null;
    proc.memory = null;
    if (proc.worker) { proc.worker.terminate(); proc.worker = null; }
    if (proc.port) { proc.port.close(); proc.port = null; }
    this.procs.delete(proc.pid);
    if (this.onExit) this.onExit(proc);
    for (const w of proc.waiters) w(code);
    proc.waiters.length = 0;
  }

  kill(pid) {
    const proc = this.procs.get(pid);
    if (!proc) return false;
    if (proc.cancelWait) { proc.cancelWait(); proc.cancelWait = null; }
    if (proc.timer) { clearTimeout(proc.timer); proc.timer = 0; }
    this._finish(proc, 137, 'killed');
    return true;
  }

  // ------------------------------------------------------------ placement (a)

  // Returns the proc. `timing` (optional object) receives instantiate time.
  spawn(name, args = [], opts = {}) {
    const module = this.modules[name];
    if (!module) throw new Error('no such program ' + name);
    const proc = this._newProc(name, args, opts);
    let instance;
    try {
      instance = new WebAssembly.Instance(module, this._imports(module, proc));
    } catch (e) {
      this._finish(proc, 127, 'spawn-failed', String(e)); // closes the fds we just opened
      throw e;
    }
    proc.instance = instance;
    proc.memory = instance.exports.memory;
    proc._refresh();
    if (opts.registry) { opts.registry.register(instance, 'instance'); opts.registry.register(proc.memory, 'memory'); }
    if (opts.noStart) return proc;
    this.start(proc);
    return proc;
  }

  start(proc) {
    const start = WebAssembly.promising(proc.instance.exports._start);
    // NOTE: start() runs the guest synchronously right here until it first suspends.
    start().then(
      () => this._finish(proc, 0, 'exited'),
      (e) => {
        if (e instanceof ProcExit) this._finish(proc, e.code, 'exited');
        else this._finish(proc, 134, 'trapped', `${e && e.constructor && e.constructor.name}: ${e && e.message}`);
      },
    );
  }

  _imports(module, proc) {
    const k = this;
    const stats = this.stats;
    let u8 = new Uint8Array(0);
    let dv = null;
    const refresh = () => {
      u8 = new Uint8Array(proc.memory.buffer);
      dv = new DataView(proc.memory.buffer);
    };
    proc._refresh = refresh;
    const argv = proc.args.map((s) => enc.encode(s + '\0'));
    const envv = proc.env.map((s) => enc.encode(s + '\0'));
    const sizes = (list, pc, ps) => {
      if (u8.byteLength === 0) refresh();
      dv.setUint32(pc, list.length, true);
      dv.setUint32(ps, list.reduce((a, b) => a + b.length, 0), true);
      return 0;
    };
    const fill = (list, pv, pb) => {
      if (u8.byteLength === 0) refresh();
      for (const s of list) {
        dv.setUint32(pv, pb, true);
        u8.set(s, pb);
        pv += 4;
        pb += s.length;
      }
      return 0;
    };

    // Called after every resume. Returns a promise only if the kernel wants a macrotask hop.
    const resumed = () => {
      if (k.lastPid !== proc.pid) { k.lastPid = proc.pid; stats.switches++; }
    };

    // Slow path of fd_read / fd_write: suspend until the file is ready, then retry.
    async function ioSlow(isWrite, f, p, l, pn) {
      for (;;) {
        stats.suspends++;
        proc.suspends++;
        await f.wait(proc);
        proc.cancelWait = null;
        if (proc.dead) await NEVER; // killed between wake-up and resume: never return to wasm
        if (k.sliceMs && performance.now() - k.lastYield > k.sliceMs) {
          k.macrotaskYields++;
          await k.macrotask();
          if (proc.dead) await NEVER;
        }
        resumed();
        if (u8.byteLength === 0) refresh();
        const r = isWrite ? f.write(u8, p, l) : f.read(u8, p, l);
        if (r === BLOCK) continue;
        if (r === EPIPE) return E.PIPE;
        dv.setUint32(pn, r, true);
        return 0;
      }
    }

    const wasi = {
      args_sizes_get: (pc, ps) => sizes(argv, pc, ps),
      args_get: (pv, pb) => fill(argv, pv, pb),
      environ_sizes_get: (pc, ps) => sizes(envv, pc, ps),
      environ_get: (pv, pb) => fill(envv, pv, pb),
      fd_write(fd, iovs, n, pn) {
        stats.syscalls++;
        const f = proc.fds[fd];
        if (f === undefined) return E.BADF;
        if (u8.byteLength === 0) refresh();
        let total = 0;
        for (let i = 0; i < n; i++) {
          const p = dv.getUint32(iovs + 8 * i, true);
          const l = dv.getUint32(iovs + 8 * i + 4, true);
          if (l === 0) continue;
          const r = f.write(u8, p, l);
          if (r === BLOCK) {
            if (total > 0) break; // partial write; caller loops
            return ioSlow(true, f, p, l, pn); // -> Promise -> JSPI suspends this instance
          }
          if (r === EPIPE) return E.PIPE;
          total += r;
          if (r < l) break;
        }
        dv.setUint32(pn, total, true);
        return 0;
      },
      fd_read(fd, iovs, n, pn) {
        stats.syscalls++;
        const f = proc.fds[fd];
        if (f === undefined) return E.BADF;
        if (u8.byteLength === 0) refresh();
        let total = 0;
        for (let i = 0; i < n; i++) {
          const p = dv.getUint32(iovs + 8 * i, true);
          const l = dv.getUint32(iovs + 8 * i + 4, true);
          if (l === 0) continue;
          const r = f.read(u8, p, l);
          if (r === BLOCK) {
            if (total > 0) break;
            return ioSlow(false, f, p, l, pn);
          }
          total += r;
          if (r < l) break;
        }
        dv.setUint32(pn, total, true);
        return 0;
      },
      fd_close(fd) {
        stats.syscalls++;
        return k.closeFd(proc, fd);
      },
      fd_fdstat_get(fd, p) {
        stats.syscalls++;
        const f = proc.fds[fd];
        if (f === undefined) return E.BADF;
        if (u8.byteLength === 0) refresh();
        u8.fill(0, p, p + 24);
        dv.setUint8(p, f instanceof MemFile ? 4 : 2); // regular_file : character_device
        dv.setBigUint64(p + 8, 0xffffffffn, true);
        return 0;
      },
      clock_time_get(id, _precision, p) {
        stats.syscalls++;
        if (u8.byteLength === 0) refresh();
        // ns as a double, split into two u32 (avoids allocating a BigInt)
        const ns = (id === 0 ? performance.timeOrigin + performance.now() : performance.now()) * 1e6;
        dv.setUint32(p, ns % 4294967296, true);
        dv.setUint32(p + 4, ns / 4294967296, true);
        return 0;
      },
      poll_oneoff(pin, pout, nsubs, pnev) {
        stats.syscalls++;
        if (u8.byteLength === 0) refresh();
        // Only clock subscriptions (sleep) are implemented.
        let ms = Infinity;
        let ud = 0n;
        for (let i = 0; i < nsubs; i++) {
          const s = pin + 48 * i;
          if (dv.getUint8(s + 8) !== 0) continue;
          let t = Number(dv.getBigUint64(s + 24, true)) / 1e6;
          if (dv.getUint16(s + 40, true) & 1) t -= dv.getUint32(s + 16, true) === 0 ? performance.timeOrigin + performance.now() : performance.now();
          if (t < ms) { ms = t; ud = dv.getBigUint64(s, true); }
        }
        if (ms === Infinity) return E.NOSYS;
        const done = () => {
          if (u8.byteLength === 0) refresh();
          u8.fill(0, pout, pout + 32);
          dv.setBigUint64(pout, ud, true);
          dv.setUint32(pnev, 1, true);
          return 0;
        };
        if (ms <= 0) return done();
        stats.suspends++;
        proc.suspends++;
        return new Promise((resolve) => {
          proc.timer = setTimeout(() => {
            proc.timer = 0;
            k.lastYield = performance.now();
            resumed();
            resolve(done());
          }, ms);
        });
      },
      proc_exit(code) {
        throw new ProcExit(code);
      },
      random_get(p, l) {
        stats.syscalls++;
        if (u8.byteLength === 0) refresh();
        crypto.getRandomValues(u8.subarray(p, p + l));
        return 0;
      },
      sched_yield: () => 0,
    };
    const spike = {
      nop: (x) => x + 1,
      nop_susp: (x) => x + 1,
      nop_async: (x) => Promise.resolve(x + 1),
      spawn(p, l) {
        if (u8.byteLength === 0) refresh();
        const [name, ...args] = dec.decode(u8.subarray(p, p + l)).split(' ');
        // child inherits stdout/stderr. NOTE: the child starts running *inside* this call.
        return k.spawn(name, args, { fds: [k.nullFile(), proc.fds[1], proc.fds[2]] }).pid;
      },
      waitpid(pid) {
        const child = k.procs.get(pid);
        if (!child) return -1;
        stats.suspends++;
        proc.suspends++;
        return child.exited.then((code) => { resumed(); return code; });
      },
    };
    const impl = { wasi_snapshot_preview1: wasi, spike };
    const imports = {};
    const useShim = proc.useShim;
    let shim = null;
    if (useShim) {
      // One tiny shim instance per process; its exports are linked wasm-to-wasm.
      let pend = null;
      const tryOf = (fn) => (a, b, c, d) => {
        const r = fn(a, b, c, d);
        if (typeof r === 'number') return r;
        pend = r; // the blocking path already started; hand its promise to the slow import
        return -1;
      };
      const slow = new WebAssembly.Suspending(() => { stats.suspendingCalls++; return pend; });
      shim = new WebAssembly.Instance(k.shimModule, {
        k: { try_fd_write: tryOf(wasi.fd_write), slow_fd_write: slow, try_fd_read: tryOf(wasi.fd_read), slow_fd_read: slow },
      }).exports;
    }
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.kind !== 'function') continue;
      const ns = (imports[imp.module] ??= {});
      const full = imp.module + '.' + imp.name;
      let fn = impl[imp.module]?.[imp.name];
      if (!fn) fn = () => E.NOSYS; // stub the rest
      if (shim && imp.module === 'wasi_snapshot_preview1' && shim[imp.name]) ns[imp.name] = shim[imp.name];
      else if (SUSPENDING.has(full)) {
        const f = fn;
        ns[imp.name] = new WebAssembly.Suspending(function () { stats.suspendingCalls++; return f.apply(null, arguments); });
      } else ns[imp.name] = fn;
    }
    return imports;
  }

  // ------------------------------------------------------------ placement (b)

  // Spawns `name` in its own worker. Every syscall is a postMessage round trip to here.
  // opts.worker: reuse an already running (warm) proc-worker instead of creating one.
  spawnRemote(name, args = [], opts = {}) {
    const module = this.modules[name];
    const proc = this._newProc(name, args, opts);
    proc.placement = 'b';
    const mc = new MessageChannel();
    proc.port = mc.port1;
    proc.port.onmessage = (ev) => {
      this.stats.remoteSyscalls++;
      const r = this._remoteSyscall(proc, ev.data);
      if (r === undefined) return;
      if (r instanceof Promise) r.then((v) => proc.port && proc.port.postMessage(v));
      else proc.port.postMessage(r);
    };
    const worker = opts.worker || new Worker(new URL('./proc-worker.js', import.meta.url), { type: 'module' });
    if (!opts.worker) proc.worker = worker;
    proc.ready = new Promise((r) => (proc._ready = r));
    worker.postMessage({ type: 'run', module, args: proc.args, env: proc.env, port: mc.port2 }, [mc.port2]);
    return proc;
  }

  _remoteSyscall(proc, m) {
    const op = m[0];
    switch (op) {
      case 'started': // instantiated, about to call _start
        proc._ready();
        return undefined;
      case 'nop':
        return [0, m[1] + 1];
      case 'clock_time_get':
        return [0, m[1] === 0 ? performance.timeOrigin + performance.now() : performance.now()];
      case 'fd_write': {
        const f = proc.fds[m[1]];
        if (!f) return [E.BADF, 0];
        return this._remoteWrite(proc, f, m[2]);
      }
      case 'fd_read': {
        const f = proc.fds[m[1]];
        if (!f) return [E.BADF, null];
        return this._remoteRead(proc, f, m[2]);
      }
      case 'fd_close':
        return [this.closeFd(proc, m[1])];
      case 'sleep':
        return new Promise((r) => { proc.timer = setTimeout(() => { proc.timer = 0; r([0]); }, m[1]); });
      case 'exit':
        this._finish(proc, m[1], m[2] ? 'trapped' : 'exited', m[2]);
        return undefined;
      default:
        return [E.NOSYS];
    }
  }
  _remoteWrite(proc, f, bytes) {
    const r = f.write(bytes, 0, bytes.length);
    if (r === EPIPE) return [E.PIPE, 0];
    if (r !== BLOCK) return [0, r];
    return (async () => {
      for (;;) {
        await f.wait(proc);
        proc.cancelWait = null;
        if (proc.dead) await NEVER;
        const r2 = f.write(bytes, 0, bytes.length);
        if (r2 === BLOCK) continue;
        return r2 === EPIPE ? [E.PIPE, 0] : [0, r2];
      }
    })();
  }
  _remoteRead(proc, f, len) {
    const buf = new Uint8Array(len);
    const r = f.read(buf, 0, len);
    if (r !== BLOCK) return [0, r === len ? buf : buf.slice(0, r)];
    return (async () => {
      for (;;) {
        await f.wait(proc);
        proc.cancelWait = null;
        if (proc.dead) await NEVER;
        const r2 = f.read(buf, 0, len);
        if (r2 === BLOCK) continue;
        return [0, r2 === len ? buf : buf.slice(0, r2)];
      }
    })();
  }
}
