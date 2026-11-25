// node:child_process. There is no OS; `bash`/`sh` (and any other command line) is executed by just-bash, a
// TypeScript bash interpreter running in this same worker against the same in-memory VFS.
// Synchronous variants (execSync, spawnSync, execFileSync) cannot be provided: just-bash is asynchronous and the
// worker has no way to block (no SharedArrayBuffer / Atomics.wait). They fail and every call is recorded.
import { Buffer } from 'buffer';
import { Bash, getCommandNames } from 'just-bash/browser';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const shQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

export function createChildProcess({ vfs, fs, EventEmitter, stream, process, track, host, path, util }) {
  const log = { spawns: [], syncCalls: [] };
  const fsAdapter = {
    async readFile(p, o) { const enc = (typeof o === 'string' ? o : o && o.encoding) || 'utf8'; return fs.readFileSync(p).toString(enc === 'binary' ? 'latin1' : enc); },
    async readFileBuffer(p) { return new Uint8Array(fs.readFileSync(p)); },
    async writeFile(p, content, o) { fs.writeFileSync(p, content, typeof o === 'string' ? o : o && o.encoding); },
    async appendFile(p, content, o) { fs.appendFileSync(p, content, typeof o === 'string' ? o : o && o.encoding); },
    async exists(p) { return fs.existsSync(p); },
    async stat(p) { const s = fs.statSync(p); return { isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: false, mode: s.mode & 0o7777, size: s.size, mtime: s.mtime, ino: s.ino, dev: 1 }; },
    async lstat(p) { const s = fs.lstatSync(p); return { isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(), mode: s.mode & 0o7777, size: s.size, mtime: s.mtime, ino: s.ino, dev: 1 }; },
    async mkdir(p, o) { fs.mkdirSync(p, o); },
    async readdir(p) { return fs.readdirSync(p).sort(); },
    async readdirWithFileTypes(p) { return fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory(), isSymbolicLink: d.isSymbolicLink() })).sort((a, b) => (a.name < b.name ? -1 : 1)); },
    async rm(p, o) { fs.rmSync(p, o); },
    async cp(a, b, o) { fs.cpSync(a, b, o); },
    async mv(a, b) { fs.renameSync(a, b); },
    resolvePath(base, p) { return path.resolve(base, p); },
    getAllPaths() { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = (d === '/' ? '' : d) + '/' + e.name; out.push(f); if (e.isDirectory() && e.name !== 'node_modules') walk(f); } }; walk('/'); return out; },
    async chmod(p, m) { fs.chmodSync(p, m); },
    async symlink(t, p) { fs.symlinkSync(t, p); },
    async link(a, b) { fs.linkSync(a, b); },
    async readlink(p) { return fs.readlinkSync(p); },
    async realpath(p) { return fs.realpathSync(p); },
    async utimes(p, a, m) { fs.utimesSync(p, a, m); },
  };
  let bash = null, bashInitMs = null;
  const builtinNames = new Set(getCommandNames());
  const getBash = () => {
    if (!bash) { const t = host.performance.now();
      // just-bash resolves commands through $PATH on the file system it is given; publish its built-ins as stub files.
      const stub = new TextEncoder().encode('#!/bin/bash\n# just-bash built-in\n');
      for (const dir of ['/usr/bin', '/bin']) { vfs.mkdir(dir, { recursive: true }); for (const name of getCommandNames()) if (!vfs.tryLookup(dir + '/' + name)) vfs.writeFile(dir + '/' + name, stub, { mode: 0o755 }); } bash = new Bash({ fs: fsAdapter, cwd: process.cwd(), env: { ...process.env }, defenseInDepth: false }); bashInitMs = host.performance.now() - t; log.bashInitMs = bashInitMs; }
    return bash;
  };

  let nextPid = 5000;
  class ChildProcess extends EventEmitter {
    constructor() { super(); this.pid = nextPid++; this.exitCode = null; this.signalCode = null; this.killed = false; this.connected = false; this.stdin = null; this.stdout = null; this.stderr = null; this.stdio = [null, null, null]; this._abort = new AbortController(); }
    kill(sig = 'SIGTERM') { if (this.exitCode !== null || this.signalCode !== null) return false; this.killed = true; this._signal = typeof sig === 'number' ? 'SIGTERM' : sig; this._abort.abort(); return true; }
    ref() { return this; } unref() { return this; } disconnect() {} send() { return false; }
    [Symbol.dispose]() { this.kill(); }
  }

  function toScript(command, args, options) {
    const base = path.basename(command);
    if (options.shell) return [command, ...args].join(' ');
    if (SHELLS.has(base)) {
      // `bash -c -l 'script'` and `bash -lc 'script'` are both in use: the command string is the first non-option argument.
      const hasC = args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      const rest = args.filter((a, i) => !(a.startsWith('-') && a.length > 1) && !(i > 0 && (args[i - 1] === '-o' || args[i - 1] === '-O')));
      if (hasC) return rest[0] ?? '';
      if (rest[0]) return `source ${shQuote(rest[0])} ${rest.slice(1).map(shQuote).join(' ')}`;
      return null; // script comes from stdin
    }
    // A path to a native executable (ELF/Mach-O/PE) cannot run here. If just-bash has a built-in of the same name
    // (rg, git is not one, ...), run that instead; otherwise the spawn fails like a missing binary would.
    if (command.includes('/')) {
      const node = vfs.tryLookup(command.startsWith('/') ? command : path.resolve(options.cwd || process.cwd(), command));
      const d = node && node.kind === 'file' ? node.data : null;
      const isNative = d && d.length > 4 && ((d[0] === 0x7f && d[1] === 0x45 && d[2] === 0x4c && d[3] === 0x46) || (d[0] === 0xcf && d[1] === 0xfa) || (d[0] === 0x4d && d[1] === 0x5a));
      if (isNative || (d && builtinNames.has(base))) { track(isNative ? 'spawn of native executable' : 'spawn of stub', command + (builtinNames.has(base) ? ' -> just-bash ' + base : ' -> ENOENT')); return [builtinNames.has(base) ? base : '__no_such_native_binary__', ...args].map(shQuote).join(' '); }
    }
    return [command, ...args].map(shQuote).join(' ');
  }

  function spawn(command, args, options) {
    if (!Array.isArray(args)) { options = args; args = []; }
    options = options || {};
    args = args.map(String);
    const child = new ChildProcess();
    const rec = { api: 'spawn', command, args: args.map((a) => (a.length > 200 ? a.slice(0, 200) + '…' : a)), cwd: options.cwd, shell: !!options.shell };
    log.spawns.push(rec);
    let stdio = options.stdio ?? 'pipe';
    if (typeof stdio === 'string') stdio = [stdio, stdio, stdio];
    const kind = (i) => (stdio[i] == null ? 'pipe' : typeof stdio[i] === 'string' ? stdio[i] : 'inherit');
    const fdOf = (v) => (typeof v === 'number' ? v : v && typeof v === 'object' && typeof v.fd === 'number' ? v.fd : null);
    const fdWriters = [0, 1, 2].map((i) => (fdOf(stdio[i]) > 2 ? fs.__dupForChild(fdOf(stdio[i])) : null));
    const stdinChunks = [];
    let stdinEnded = kind(0) !== 'pipe', startRun;
    if (kind(0) === 'pipe') child.stdin = new stream.Writable({ write(c, e, cb) { stdinChunks.push(typeof c === 'string' ? Buffer.from(c, e) : c); cb(); }, final(cb) { stdinEnded = true; cb(); startRun && startRun(); } });
    const mkOut = (i, target) => { if (kind(i) === 'pipe') return new stream.Readable({ read() {} }); return null; };
    child.stdout = mkOut(1); child.stderr = mkOut(2);
    child.stdio = [child.stdin, child.stdout, child.stderr];
    child.spawnfile = command; child.spawnargs = [command, ...args];
    // Decide ENOENT before 'spawn', as Node does: no 'spawn' event, 'error' then 'close', pid undefined.
    const baseName = path.basename(command);
    const envPath = String((options.env || process.env).PATH || '/usr/bin:/bin').split(':');
    const resolvable = options.shell || SHELLS.has(baseName) || (command.includes('/') ? !!vfs.tryLookup(command.startsWith('/') ? command : path.resolve(options.cwd || process.cwd(), command)) : builtinNames.has(command) || envPath.some((d) => d && vfs.tryLookup(d + '/' + command)));
    if (!resolvable) {
      rec.enoent = true; child.pid = undefined;
      const e = Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', errno: -2, syscall: 'spawn ' + command, path: command, spawnargs: args });
      process.__ref();
      host.setTimeout(() => { child.emit('error', e); for (const st of [child.stdin, child.stdout, child.stderr]) if (st) st.destroy(); host.setTimeout(() => { child.emit('close', -2, null); process.__unref(); }, 0); }, 0);
      return child;
    }
    const script = toScript(command, args, options);
    process.__ref();
    let started = false;
    startRun = async () => {
      if (started) return; started = true;
      const t0 = host.performance.now();
      let result, error;
      try {
        const sh = getBash();
        const src = script ?? Buffer.concat(stdinChunks).toString('utf8');
        const env = options.env ? Object.fromEntries(Object.entries(options.env).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) : { ...process.env };
        result = await sh.exec(src, { cwd: options.cwd ? String(options.cwd) : process.cwd(), env, replaceEnv: true, signal: child._abort.signal, stdin: script != null && stdinChunks.length ? Buffer.concat(stdinChunks).toString('utf8') : undefined, rawScript: true });
      } catch (e) { error = e; }
      rec.ms = +(host.performance.now() - t0).toFixed(1);
      if (process.__exited) return;
      const base = path.basename(command);
      if (child.killed) { child.signalCode = child._signal || 'SIGTERM'; rec.signal = child.signalCode; }
      else if (error) { result = { stdout: '', stderr: String(error && error.message || error) + '\n', exitCode: 1 }; rec.error = String(error && error.message || error).slice(0, 300); }
      if (result && !child.killed && !SHELLS.has(base) && !options.shell && result.exitCode === 127 && /command not found/.test(result.stderr)) {
        rec.enoent = true;
        const e = Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', errno: -2, syscall: 'spawn ' + command, path: command, spawnargs: args });
        child.emit('error', e); child.stdout && child.stdout.push(null); child.stderr && child.stderr.push(null);
        host.setTimeout(() => { child.emit('close', -2, null); process.__unref(); }, 0);
        return;
      }
      const emitOut = (s, text, parentStream, i) => {
        if (text) { const b = result.stdoutKind === 'bytes' && i === 1 ? Buffer.from(text, 'latin1') : Buffer.from(text, 'utf8'); if (s) s.push(b); else if (fdWriters[i]) fdWriters[i](new Uint8Array(b)); else if (kind(i) === 'inherit') parentStream.write(b); }
        if (s) s.push(null);
      };
      if (result) { try { emitOut(child.stdout, result.stdout, process.stdout, 1); emitOut(child.stderr, result.stderr, process.stderr, 2); } catch (e) { rec.stdioError = String(e && e.stack || e).slice(0, 500); } rec.exitCode = result.exitCode; rec.stdoutBytes = result.stdout.length; }
      else { child.stdout && child.stdout.push(null); child.stderr && child.stderr.push(null); }
      child.exitCode = child.killed ? null : result ? result.exitCode : 1;
      // 'exit' first, then 'close' once the stdio streams have ended (as Node does).
      host.setTimeout(() => {
        child.emit('exit', child.exitCode, child.signalCode);
        let closed = false;
        const close = () => { if (closed) return; closed = true; child.emit('close', child.exitCode, child.signalCode); process.__unref(); };
        const streams = [child.stdout, child.stderr].filter(Boolean);
        const check = () => { if (streams.every((s) => s.readableEnded || s.destroyed)) close(); };
        for (const s of streams) { s.once('end', check); s.once('close', check); }
        check();
        host.setTimeout(() => { if (!closed) { for (const s of streams) if (!s.readableEnded && s.listenerCount('data') === 0) s.resume(); host.setTimeout(close, 50); } }, 200);
      }, 0);
    };
    host.setTimeout(() => { child.emit('spawn'); if (script != null || stdinEnded) startRun(); }, 0);
    if (options.signal) options.signal.addEventListener('abort', () => child.kill(options.killSignal || 'SIGTERM'), { once: true });
    if (options.timeout) host.setTimeout(() => child.kill(options.killSignal || 'SIGTERM'), options.timeout);
    return child;
  }

  function collect(child, options, cb, cmdText) {
    const enc = options.encoding === 'buffer' || options.encoding === null ? null : options.encoding || 'utf8';
    const out = [], err = [];
    child.stdout && child.stdout.on('data', (d) => out.push(d));
    child.stderr && child.stderr.on('data', (d) => err.push(d));
    const fin = (e, code, signal) => {
      if (!cb) return;
      const so = Buffer.concat(out), se = Buffer.concat(err);
      const stdout = enc ? so.toString(enc) : so, stderr = enc ? se.toString(enc) : se;
      if (!e && (code !== 0 || signal)) { e = Object.assign(new Error(`Command failed: ${cmdText}\n${se.toString()}`), { code, killed: child.killed, signal: signal || null, cmd: cmdText }); }
      if (e) { e.stdout = stdout; e.stderr = stderr; }
      const f = cb; cb = null; f(e || null, stdout, stderr);
    };
    child.on('error', (e) => fin(e));
    child.on('close', (code, signal) => fin(null, code, signal));
    return child;
  }
  function exec(command, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    options = options || {};
    return collect(spawn('/bin/sh', ['-c', command], { ...options, stdio: 'pipe' }), options, cb, command);
  }
  function execFile(file, args, options, cb) {
    if (typeof args === 'function') { cb = args; args = []; options = {}; } else if (!Array.isArray(args)) { cb = options; options = args; args = []; }
    if (typeof options === 'function') { cb = options; options = {}; }
    options = options || {};
    return collect(spawn(file, args, { ...options, stdio: 'pipe' }), options, cb, [file, ...args].join(' '));
  }
  const customPromisify = (fn) => (...args) => { let child; const p = new Promise((resolve, reject) => { child = fn(...args, (e, stdout, stderr) => (e ? reject(e) : resolve({ stdout, stderr }))); }); p.child = child; return p; };
  exec[util.promisify.custom] = customPromisify(exec);
  execFile[util.promisify.custom] = customPromisify(execFile);

  const syncFail = (api, command, args) => {
    const text = [command, ...(args || [])].join(' ');
    log.syncCalls.push({ api, command: text.slice(0, 300), stack: (new Error().stack || '').split('\n').slice(3, 6).map((l) => l.trim().replace(/^at /, '').slice(0, 160)) });
    track('child_process.' + api, text.slice(0, 120));
    return Object.assign(new Error(`${api} ${command} ENOENT (synchronous child processes cannot be emulated without blocking)`), { code: 'ENOENT', errno: -2, syscall: api + ' ' + command, path: command, spawnargs: args || [], status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0 });
  };
  const emptyOut = (options) => (options && options.encoding && options.encoding !== 'buffer' ? '' : Buffer.alloc(0));
  return {
    log,
    module: {
      ChildProcess, spawn, exec, execFile,
      fork: (file) => { track('child_process.fork', String(file)); throw Object.assign(new Error('child_process.fork is not implemented in the emulation layer'), { code: 'ERR_NOT_IMPLEMENTED_IN_EMULATION' }); },
      execSync: (command, options) => { throw syncFail('execSync', command); },
      execFileSync: (file, args, options) => { throw syncFail('execFileSync', file, Array.isArray(args) ? args : []); },
      spawnSync: (command, args, options) => { if (!Array.isArray(args)) { options = args; args = []; } const error = syncFail('spawnSync', command, args); return { pid: 0, output: [null, emptyOut(options), emptyOut(options)], stdout: emptyOut(options), stderr: emptyOut(options), status: null, signal: null, error }; },
    },
  };
}
