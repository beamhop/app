// The kernel worker: hosts the Kernel plus all in-worker test/benchmark commands.
// Protocol with the page: {id, cmd, args} -> {id, ok, result|error};  {ping} -> {pong}.
import { Kernel } from './kernel.js';

const PROGRAMS = ['producer', 'upper', 'count', 'spin', 'pingpong', 'hog', 'crash', 'parent', 'reentrant'];
let k = new Kernel();
const enc = new TextEncoder();
const now = () => performance.now();
const LINE = (i) => `line ${String(i).padStart(7, '0')} the quick brown fox jumps over the lazy dog\n`;

let finalized = { instance: 0, memory: 0 };
const registry = new FinalizationRegistry((what) => finalized[what]++);

const expectedCache = new Map();
function expected(lines) {
  if (!expectedCache.has(lines)) {
    let h = 0x811c9dc5;
    let bytes = 0;
    for (let i = 0; i < lines; i++) {
      const s = LINE(i).toUpperCase();
      for (let j = 0; j < s.length; j++) h = Math.imul(h ^ s.charCodeAt(j), 0x01000193);
      bytes += s.length;
    }
    expectedCache.set(lines, `lines=${lines} bytes=${bytes} fnv=${(h >>> 0).toString(16).padStart(8, '0')}\n`);
  }
  return expectedCache.get(lines);
}
function resetStats() {
  k.stats.syscalls = k.stats.suspends = k.stats.switches = k.stats.remoteSyscalls = 0;
  k.macrotaskYields = 0;
  k.lastPid = 0;
}
const release = (end) => { end.refs--; end.close(); }; // kernel-held pipe end

const cmds = {
  env() {
    // estimate performance.now() granularity
    let min = Infinity;
    for (let i = 0; i < 50; i++) {
      const a = now();
      let b;
      do b = now(); while (b === a);
      min = Math.min(min, b - a);
    }
    return {
      crossOriginIsolated: self.crossOriginIsolated,
      typeofSharedArrayBuffer: typeof SharedArrayBuffer,
      typeofAtomicsWait: typeof Atomics?.wait,
      typeofSuspending: typeof WebAssembly.Suspending,
      typeofPromising: typeof WebAssembly.promising,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      performanceNowGranularityMs: min,
      nestedWorkerAvailable: typeof Worker,
      gcExposed: typeof gc,
    };
  },

  async load() {
    const out = {};
    for (const name of PROGRAMS) {
      const t0 = now();
      const resp = await fetch(`./wasm/${name}.wasm`);
      const bytes = await resp.arrayBuffer();
      const t1 = now();
      k.modules[name] = await WebAssembly.compile(bytes);
      out[name] = { bytes: bytes.byteLength, compileMs: +(now() - t1).toFixed(2), fetchMs: +(t1 - t0).toFixed(2) };
    }
    out.spinImports = WebAssembly.Module.imports(k.modules.spin).map((i) => `${i.module}.${i.name}`);
    out.producerImports = WebAssembly.Module.imports(k.modules.producer).map((i) => `${i.module}.${i.name}`);
    return out;
  },

  // producer | upper | count      (stages: 2 => producer | upper, output captured and compared exactly)
  dbg() { const d = self.DBG; self.DBG = []; return d && d.slice(0, 50); },
  async pipeline({ lines = 200000, sleepEvery = 0, sleepMs = 2, pipeCap = 4096, buf = false, sliceMs = 0, placement = 'a', stages = 3 } = {}) {
    const want = stages === 3 ? expected(lines) : null;
    resetStats();
    k.sliceMs = sliceMs;
    k.lastYield = now();
    const p1 = k.pipe(pipeCap);
    const p2 = k.pipe(pipeCap);
    const out = k.memFile();
    const err = k.memFile();
    const nul = k.nullFile();
    const env = buf ? ['SPIKE_BUF=1'] : [];
    const sp = (name, args, fds) => (placement === 'a' ? k.spawn(name, args, { fds, env }) : k.spawnRemote(name, args, { fds, env }));
    let countReadWhenProducerExited = null;
    let producerPid = 0;
    k.onExit = (p) => { if (p.pid === producerPid) countReadWhenProducerExited = p2.totalRead; };
    // like a shell: hold all pipe ends while forking, then drop them
    const held = [p1.r.open(), p1.w.open(), p2.r.open(), p2.w.open()];
    const t0 = now();
    const procs = [];
    // In placement (a) spawn() runs the child synchronously until it first blocks.
    const a = sp('producer', [String(lines), String(sleepEvery), String(sleepMs)], [nul, p1.w, err]);
    producerPid = a.pid;
    procs.push(a);
    if (stages === 3) {
      procs.push(sp('upper', [], [p1.r, p2.w, err]));
      procs.push(sp('count', [], [p2.r, out, err]));
    } else {
      procs.push(sp('upper', [], [p1.r, out, err]));
    }
    held.forEach(release);
    const codes = await Promise.all(procs.map((p) => p.exited));
    const ms = now() - t0;
    k.onExit = null;
    k.sliceMs = 0;
    const text = out.text();
    const bytes = lines * LINE(0).length;
    let ok;
    if (stages === 3) ok = text === want;
    else {
      let exp = '';
      for (let i = 0; i < lines; i++) exp += LINE(i).toUpperCase();
      ok = text === exp;
    }
    return {
      placement, lines, pipeCap, buf, sliceMs, sleepEvery, stages,
      ok,
      output: stages === 3 ? text.trim() : `${text.length} chars captured`,
      expected: stages === 3 ? want.trim() : 'exact text match',
      exitCodes: codes,
      stderr: err.text(),
      ms: +ms.toFixed(1),
      bytesPerStage: bytes,
      throughputMBps: +(bytes / 1e6 / (ms / 1000)).toFixed(1),
      syscalls: placement === 'a' ? k.stats.syscalls : k.stats.remoteSyscalls,
      suspends: k.stats.suspends,
      processSwitches: k.stats.switches,
      suspendsPerProc: Object.fromEntries(procs.map((p) => [p.name, p.suspends])),
      macrotaskYields: k.macrotaskYields,
      // interleaving evidence: how much `count` had already consumed when `producer` exited
      countReadWhenProducerExited,
      maxBufferedBetweenStages: countReadWhenProducerExited === null ? null : bytes - countReadWhenProducerExited,
    };
  },

  async spin({ mode = 'clock', n = 1000000, placement = 'a' } = {}) {
    const out = k.memFile();
    const nul = k.nullFile();
    const fds = [nul, out, out, nul];
    const t0 = now();
    const p = placement === 'a' ? k.spawn('spin', [mode, String(n)], { fds }) : k.spawnRemote('spin', [mode, String(n)], { fds });
    const code = await p.exited;
    const wall = now() - t0;
    const [, , dt] = out.text().trim().split(' ');
    return { mode, n, placement, exitCode: code, nsPerCall: +(Number(dt) / n).toFixed(2), guestMs: Number(dt) / 1e6, wallMs: +wall.toFixed(1) };
  },

  // two coroutine processes, two pipes, 1 byte back and forth: 2 suspend/resume per round
  async pingpong({ rounds = 200000 } = {}) {
    resetStats();
    const ab = k.pipe(4096);
    const ba = k.pipe(4096);
    const err = k.memFile();
    const held = [ab.r.open(), ab.w.open(), ba.r.open(), ba.w.open()];
    const t0 = now();
    const b = k.spawn('pingpong', ['echo'], { fds: [ab.r, ba.w, err] });
    const a = k.spawn('pingpong', ['init', String(rounds)], { fds: [ba.r, ab.w, err] });
    held.forEach(release);
    const codes = await Promise.all([a.exited, b.exited]);
    const ms = now() - t0;
    return {
      rounds, exitCodes: codes, ms: +ms.toFixed(1), suspends: k.stats.suspends, switches: k.stats.switches, syscalls: k.stats.syscalls,
      nsPerSuspendResume: +((ms * 1e6) / k.stats.suspends).toFixed(0),
      note: 'ns per suspend/resume includes the 1-byte fd_read + fd_write around each switch',
    };
  },

  async spawnCost({ batch = 200, remoteReps = 20 } = {}) {
    const nul = k.nullFile();
    const fds = [nul, nul, nul, nul];
    const r = {};
    // (a) instantiate only (imports object + new WebAssembly.Instance), not started
    let t0 = now();
    const made = [];
    for (let i = 0; i < batch; i++) made.push(k.spawn('spin', ['clock', '1'], { fds, noStart: true }));
    r.a_instantiateOnlyUs = +(((now() - t0) * 1000) / batch).toFixed(1);
    for (const p of made) k.kill(p.pid);
    // (a) full lifecycle: instantiate + _start (Rust runtime init, args, 1 syscall, println) + exit
    t0 = now();
    for (let i = 0; i < batch; i++) await k.spawn('spin', ['clock', '1'], { fds }).exited;
    r.a_spawnRunExitUs = +(((now() - t0) * 1000) / batch).toFixed(1);
    // raw engine numbers for reference
    t0 = now();
    for (let i = 0; i < batch; i++) new WebAssembly.Instance(k.modules.reentrant, { env: { block: () => 0, js_call: () => 0, js_call_susp: () => 0 } });
    r.rawInstantiateTinyModuleUs = +(((now() - t0) * 1000) / batch).toFixed(1);
    // (b) cold: new Worker + module script load + postMessage(Module) + instantiate
    const ready = [];
    const full = [];
    for (let i = 0; i < remoteReps; i++) {
      t0 = now();
      const p = k.spawnRemote('spin', ['clock', '1'], { fds });
      await p.ready;
      ready.push(now() - t0);
      await p.exited;
      full.push(now() - t0);
    }
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    r.b_coldWorkerInstantiatedMs = +med(ready).toFixed(2);
    r.b_coldWorkerSpawnRunExitMs = +med(full).toFixed(2);
    r.b_coldSamplesMs = ready.map((x) => +x.toFixed(1));
    // (b) warm: reuse one already-running worker (pool)
    const warm = new Worker(new URL('./proc-worker.js', import.meta.url), { type: 'module' });
    await k.spawnRemote('spin', ['clock', '1'], { fds, worker: warm }).exited;
    const wready = [];
    const wfull = [];
    for (let i = 0; i < remoteReps; i++) {
      t0 = now();
      const p = k.spawnRemote('spin', ['clock', '1'], { fds, worker: warm });
      await p.ready;
      wready.push(now() - t0);
      await p.exited;
      wfull.push(now() - t0);
    }
    warm.terminate();
    r.b_warmWorkerInstantiatedMs = +med(wready).toFixed(2);
    r.b_warmWorkerSpawnRunExitMs = +med(wfull).toFixed(2);
    return r;
  },

  async waitchild() {
    const out = k.memFile();
    const p = k.spawn('parent', ['producer', '3'], { fds: [k.nullFile(), out, out] });
    const code = await p.exited;
    return { exitCode: code, parentSuspends: p.suspends, output: out.text() };
  },

  // ---------------------------------------------------------------- kill
  async kill() {
    const r = {};
    // 1. kill a process suspended in fd_read on an empty pipe
    {
      const p = k.pipe(4096);
      const out = k.memFile();
      const w = p.w.open();
      const proc = k.spawn('count', [], { fds: [p.r, out, out] });
      const before = { state: proc.state, suspends: proc.suspends, pipeReaders: p.readers, waitersOnPipe: p.rq.length };
      const killed = k.kill(proc.pid);
      const wr = p.w.write(enc.encode('x'), 0, 1);
      await new Promise((res) => setTimeout(res, 20));
      r.suspendedInRead = {
        before, killed, state: proc.state, exitCode: proc.exitCode,
        pipeReadersAfter: p.readers, waitersOnPipeAfter: p.rq.length,
        writeToPipeAfterKill: wr === -2 ? 'EPIPE' : wr,
        guestOutputAfterKill: out.text(), stillInProcTable: k.procs.has(proc.pid),
        instanceRefDropped: proc.instance === null,
      };
      release(w);
    }
    // 2. kill a process that was already woken (promise resolved) but has not resumed yet
    {
      const p = k.pipe(4096);
      const out = k.memFile();
      const w = p.w.open();
      const proc = k.spawn('count', [], { fds: [p.r, out, out] });
      p.w.write(enc.encode('hello\n'), 0, 6); // resolves the reader's promise; resume is a queued microtask
      k.kill(proc.pid);
      release(w);
      await new Promise((res) => setTimeout(res, 20));
      r.wokenButNotResumed = { state: proc.state, guestOutputAfterKill: out.text(), note: 'empty output = guest never ran again' };
    }
    // 3. kill a process suspended in a sleep (poll_oneoff)
    {
      const out = k.memFile();
      const proc = k.spawn('producer', ['10', '1', '5000'], { fds: [k.nullFile(), out, out] });
      await new Promise((res) => setTimeout(res, 20));
      const t0 = now();
      k.kill(proc.pid);
      const code = await proc.exited;
      r.suspendedInSleep = { exitCode: code, state: proc.state, outputBeforeKill: out.text().trim(), waitMs: +(now() - t0).toFixed(1) };
    }
    // 4. kill the middle of a running pipeline; neighbours must see EPIPE / EOF
    {
      const p1 = k.pipe(4096);
      const p2 = k.pipe(4096);
      const out = k.memFile();
      const errA = k.memFile();
      const held = [p1.r.open(), p1.w.open(), p2.r.open(), p2.w.open()];
      const a = k.spawn('producer', ['1000000', '1000', '1'], { fds: [k.nullFile(), p1.w, errA] });
      const b = k.spawn('upper', [], { fds: [p1.r, p2.w, errA] });
      const c = k.spawn('count', [], { fds: [p2.r, out, errA] });
      held.forEach(release);
      await new Promise((res) => setTimeout(res, 30));
      k.kill(b.pid);
      const codes = await Promise.all([a.exited, b.exited, c.exited]);
      r.middleOfPipeline = {
        exitCodes: { producer: codes[0], upper: codes[1], count: codes[2] },
        states: { producer: a.state, upper: b.state, count: c.state },
        producerError: a.error,
        producerStderr: errA.text().trim().slice(0, 200),
        countOutput: out.text().trim(),
        liveProcsAfter: k.procs.size,
      };
    }
    return r;
  },

  // ---------------------------------------------------------------- memory
  hogSpawn({ n = 20, mb = 16 } = {}) {
    self.hogs = [];
    for (let i = 0; i < n; i++) {
      const p = k.pipe(64);
      const w = p.w.open();
      const proc = k.spawn('hog', [String(mb)], { fds: [p.r, k.nullFile(), k.nullFile()], registry });
      self.hogs.push({ pid: proc.pid, w, ok: proc.state === 'running' && proc.suspends === 1 });
    }
    return { spawned: n, allSuspended: self.hogs.every((h) => h.ok), liveProcs: k.procs.size };
  },
  hogKill() {
    for (const h of self.hogs) { k.kill(h.pid); release(h.w); }
    self.hogs = null;
    return { liveProcs: k.procs.size };
  },
  async gc() {
    if (typeof gc !== 'function') return { gcExposed: false, finalized: { ...finalized } };
    for (let i = 0; i < 3; i++) { gc(); await new Promise((r) => setTimeout(r, 50)); }
    return { gcExposed: true, finalized: { ...finalized } };
  },
  finalized() {
    return { ...finalized };
  },

  // ---------------------------------------------------------------- traps
  async trap() {
    const r = {};
    // a bystander process that must survive the others' traps
    const bp = k.pipe(4096);
    const bout = k.memFile();
    const bw = bp.w.open();
    const bystander = k.spawn('count', [], { fds: [bp.r, bout, bout] });
    for (const mode of ['trap', 'panic', 'oob', 'overflow']) {
      const p = k.pipe(4096);
      const err = k.memFile();
      const w = p.w.open();
      const proc = k.spawn('crash', [mode], { fds: [p.r, err, err] });
      const suspendedFirst = proc.suspends === 1 && proc.state === 'running';
      p.w.write(enc.encode('hello'), 0, 5);
      const t0 = now();
      const code = await proc.exited;
      r[mode] = {
        suspendedBeforeCrash: suspendedFirst, exitCode: code, state: proc.state, error: proc.error,
        stderr: err.text().trim().slice(0, 300), fdsClosed: p.readers === 0, ms: +(now() - t0).toFixed(1),
      };
      release(w);
    }
    bp.w.write(enc.encode('a\nb\n'), 0, 4);
    release(bw);
    const bcode = await bystander.exited;
    r.bystander = { exitCode: bcode, output: bout.text().trim() };
    // kernel still fully usable?
    const after = await cmds.pipeline({ lines: 2000 });
    r.pipelineAfterTrapsOk = after.ok;
    return r;
  },

  // ---------------------------------------------------------------- many suspended procs
  async many({ counts = [1000, 4000, 10000], budgetMs = 60000 } = {}) {
    const res = [];
    const tStart = now();
    for (const n of counts) {
      if (now() - tStart > budgetMs) { res.push({ n, skipped: 'time budget' }); break; }
      const procs = [];
      const ws = [];
      const nul = k.nullFile();
      let error = null;
      const t0 = now();
      try {
        for (let i = 0; i < n; i++) {
          const p = k.pipe(16);
          ws.push(p.w.open());
          procs.push(k.spawn('count', [], { fds: [p.r, nul, nul] }));
        }
      } catch (e) {
        error = `${e.constructor.name}: ${e.message}`;
      }
      const spawnMs = now() - t0;
      const suspended = procs.filter((p) => p.state === 'running' && p.suspends === 1).length;
      const t1 = now();
      ws.forEach(release); // EOF for everyone -> all resume, print, exit
      const codes = await Promise.all(procs.map((p) => p.exited));
      res.push({
        n, spawnedAndSuspended: suspended, error,
        spawnMs: +spawnMs.toFixed(0), usPerSpawn: +((spawnMs * 1000) / Math.max(1, procs.length)).toFixed(0),
        resumeAllAndExitMs: +(now() - t1).toFixed(0), allExitedZero: codes.every((c) => c === 0), liveProcsAfter: k.procs.size,
      });
      if (error) break;
    }
    return res;
  },

  // ---------------------------------------------------------------- JS frames between wasm frames
  async reentrant() {
    const r = {};
    const mod = k.modules.reentrant;
    const make = (blockFn) => {
      let inst;
      const imports = {
        env: {
          block: new WebAssembly.Suspending(blockFn),
          // plain synchronous JS frame that re-enters wasm through the RAW export
          js_call: (x) => {
            try {
              return inst.exports.inner(x);
            } catch (e) {
              imports.caught = `${e.constructor.name}: ${e.message}`;
              throw e;
            }
          },
          // Suspending import whose async JS re-enters wasm through a promising() export
          js_call_susp: new WebAssembly.Suspending(async (x) => await WebAssembly.promising(inst.exports.inner)(x)),
        },
      };
      inst = new WebAssembly.Instance(mod, imports);
      return { inst, imports };
    };
    const delay = (x) => new Promise((res) => setTimeout(() => res(x * 2), 1));
    const attempt = async (label, f) => {
      try {
        r[label] = { ok: true, value: await f() };
      } catch (e) {
        r[label] = { ok: false, error: `${e.constructor.name}: ${e.message}` };
      }
    };
    // 1. baseline: promising(export) -> Suspending import returning a pending promise
    let m = make(delay);
    await attempt('direct_wasm_to_suspending_import', () => WebAssembly.promising(m.inst.exports.outer_direct)(5)); // 5*2+100
    // 2. promising(outer) -> wasm -> sync JS frame -> raw wasm export -> Suspending import (pending promise)
    m = make(delay);
    await attempt('wasm_js_wasm_then_suspend', () => WebAssembly.promising(m.inst.exports.outer_via_js)(5));
    r.wasm_js_wasm_then_suspend.caughtInsideJsFrame = m.imports.caught || null;
    // 2b. is the instance still usable afterwards?
    await attempt('instance_usable_after_failed_suspend', () => WebAssembly.promising(m.inst.exports.outer_direct)(1));
    // 3. same shape but the Suspending import returns a plain value (nothing to suspend)
    m = make((x) => x * 2);
    await attempt('wasm_js_wasm_no_actual_suspend', () => WebAssembly.promising(m.inst.exports.outer_via_js)(5)); // 5*2+1+1000
    // 4. workaround: the middle JS frame is itself async + Suspending and calls promising(inner)
    m = make(delay);
    await attempt('wasm_asyncjs_wasm_then_suspend', () => WebAssembly.promising(m.inst.exports.outer_via_js_susp)(5));
    // 5. Suspending import reached from a NON-promising export (plain synchronous call from JS)
    m = make(delay);
    await attempt('raw_export_then_suspend', async () => m.inst.exports.outer_direct(5));
    // 5b. ... and when the import does not actually return a promise
    m = make((x) => x * 2);
    await attempt('raw_export_no_actual_suspend', async () => m.inst.exports.outer_direct(5));
    // 6. two concurrently suspended activations of the SAME instance
    m = make(delay);
    await attempt('two_concurrent_activations_same_instance', () =>
      Promise.all([WebAssembly.promising(m.inst.exports.outer_direct)(1), WebAssembly.promising(m.inst.exports.outer_direct)(2)]));
    // 7. JS built-in frame in between: Array.prototype.map calling the raw export
    m = make(delay);
    await attempt('suspend_through_array_map_frame', async () => [1].map((x) => m.inst.exports.inner(x)));
    return r;
  },

  // ---------------------------------------------------------------- CPU hogs
  burn() {
    // placement (a): never returns; the whole kernel worker is stuck in wasm.
    k.spawn('spin', ['burn'], { fds: [k.nullFile(), k.nullFile(), k.nullFile(), k.nullFile()] });
    return 'unreachable';
  },
  async burnRemote({ killAfterMs = 300 } = {}) {
    // placement (b): the burner is in its own worker; the kernel stays responsive and kills it.
    const nul = k.nullFile();
    const p = k.spawnRemote('spin', ['burn'], { fds: [nul, nul, nul, nul] });
    await p.ready;
    const t0 = now();
    await new Promise((res) => setTimeout(res, killAfterMs));
    const lateBy = now() - t0 - killAfterMs;
    k.kill(p.pid);
    const code = await p.exited;
    const after = await cmds.pipeline({ lines: 2000 });
    return { exitCode: code, state: p.state, kernelTimerLateByMs: +lateBy.toFixed(1), pipelineAfterOk: after.ok, liveProcs: k.procs.size };
  },
};

self.onmessage = async ({ data }) => {
  if (data.ping !== undefined) return self.postMessage({ pong: data.ping });
  const { id, cmd, args } = data;
  try {
    const result = await cmds[cmd](args || {});
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: `${e && e.constructor && e.constructor.name}: ${e && e.message}\n${e && e.stack}` });
  }
};
self.postMessage({ boot: true });
