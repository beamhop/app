// Confinement probes. Each `body` is the body of an async function evaluated INSIDE a fresh
// guest compartment (or, for the control run, in a plain worker global).
// A body returns OK(note) / REACHED(note) / INFO(note) / CHECK(key, note); a throw counts as blocked.
// CHECK(key) asks the kernel to look at self[key] afterwards (side effects in the real global).
'use strict';
(function () {
  const PRELUDE = `
    const OK = (note) => ({ s: 'blocked', note });
    const REACHED = (note) => ({ s: 'reachable', note });
    const INFO = (note) => ({ s: 'info', note });
    const CHECK = (key, note) => ({ s: 'check', key, note });
    const isReal = (g) => { try { return !!g && (typeof g === 'object' || typeof g === 'function') && (typeof g.fetch === 'function' || typeof g.importScripts === 'function' || typeof g.postMessage === 'function' || g.__REAL_GLOBAL_CANARY__ === 1); } catch (e) { return false; } };
    const verdict = (g, label) => isReal(g) ? REACHED(label + ' is the real worker global') : OK(label + (g === globalThis ? ' === compartment globalThis (no ambient authority on it)' : ' -> ' + (g === undefined ? 'undefined' : typeof g)));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  `;
  const T = [];
  const add = (group, name, body, opts) => T.push(Object.assign({ group, name, body }, opts || {}));

  // ---- ambient globals -----------------------------------------------------------------
  add('globals', 'globalThis', `
    const names = Object.getOwnPropertyNames(globalThis);
    const v = verdict(globalThis, 'globalThis');
    v.note += '; ' + names.length + ' own props; non-intrinsic: ' + names.filter((n) => !/^[A-Z]|^(eval|escape|unescape|decodeURI|decodeURIComponent|encodeURI|encodeURIComponent|isFinite|isNaN|parseFloat|parseInt|globalThis|undefined|harden|lockdown|assert)$/.test(n)).join(',');
    return v;`);
  for (const n of ['self', 'window', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'indexedDB', 'caches', 'localStorage', 'navigator', 'location', 'postMessage', 'onmessage', 'addEventListener', 'close', 'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'Blob', 'Response', 'structuredClone', 'OffscreenCanvas', 'FileReaderSync', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'SpikeKernel', '__REAL_GLOBAL_CANARY__']) {
    add('globals', 'typeof ' + n, `
      const t = typeof ${n};
      return t === 'undefined' ? OK('typeof ${n} === "undefined" (name not on compartment global; lookup ends at SES scope terminator)') : REACHED('typeof ${n} === ' + t);`);
  }
  add('globals', 'this at top level / in sloppy-style function', `
    const a = (function () { return this; })();
    const b = (0, function () { return this; })();
    if (isReal(a) || isReal(b)) return REACHED('function this is the real global');
    return OK('this in a plain function call is ' + a + ' (guest code is always evaluated in strict mode)');`);
  add('globals', 'builtin called with undefined this', `
    const tries = [() => (0, Object.prototype.valueOf)(), () => [].concat.call(undefined), () => Function.prototype.call.call(Object.prototype.valueOf), () => (0, Object.prototype.__lookupGetter__)('x'), () => Reflect.apply(Array.prototype.slice, undefined, [])];
    const out = [];
    for (const t of tries) { try { const v = t(); if (isReal(v)) return REACHED('builtin leaked the real global'); out.push(typeof v); } catch (e) { out.push(e.name); } }
    return OK('results: ' + out.join(','));`);

  // ---- evaluators ------------------------------------------------------------------------
  add('evaluators', "Function('return this')()", `return verdict(Function('return this')(), "Function('return this')()");`);
  add('evaluators', "(0,eval)('this')", `return verdict((0, eval)('this'), "(0,eval)('this')");`);
  add('evaluators', "direct eval('this') / eval('typeof fetch')", `
    const g = eval('this'); const t = eval('typeof fetch');
    if (isReal(g) || t !== 'undefined') return REACHED('direct eval sees real global');
    return OK("eval('this') " + (g === globalThis ? '=== compartment globalThis' : typeof g) + "; eval('typeof fetch') === 'undefined'");`);
  add('evaluators', "new Function('return typeof fetch')", `
    const t = new Function('return typeof fetch + "/" + typeof importScripts + "/" + typeof self')();
    return t === 'undefined/undefined/undefined' ? OK('new Function body evaluated in the compartment: ' + t) : REACHED(t);`);
  add('evaluators', '({}).constructor.constructor', `return verdict(({}).constructor.constructor('return this')(), 'Object.constructor.constructor("return this")()');`);
  add('evaluators', 'arrow.constructor / Function.prototype.constructor', `
    const F = (() => {}).constructor;
    const same = F === Function;
    let r; try { r = F('return this')(); } catch (e) { return OK('Function.prototype.constructor throws: ' + e.name + ': ' + e.message); }
    const v = verdict(r, '(()=>{}).constructor("return this")()'); v.note += '; constructor === compartment Function: ' + same; return v;`);
  add('evaluators', 'AsyncFunction constructor', `
    const AF = (async () => {}).constructor;
    let r; try { r = await AF('return this')(); } catch (e) { return OK('AsyncFunction constructor throws: ' + e.name + ': ' + e.message); }
    return verdict(r, 'AsyncFunction("return this")()');`);
  add('evaluators', 'GeneratorFunction constructor', `
    const GF = (function* () {}).constructor;
    let r; try { r = GF('yield this')().next().value; } catch (e) { return OK('GeneratorFunction constructor throws: ' + e.name + ': ' + e.message); }
    return verdict(r, 'GeneratorFunction("yield this")().next().value');`);
  add('evaluators', 'AsyncGeneratorFunction constructor', `
    const AGF = (async function* () {}).constructor;
    let r; try { r = (await AGF('yield this')().next()).value; } catch (e) { return OK('AsyncGeneratorFunction constructor throws: ' + e.name + ': ' + e.message); }
    return verdict(r, 'AsyncGeneratorFunction result');`);
  add('evaluators', 'Reflect.construct(Function) / getPrototypeOf chains', `
    const out = [];
    for (const f of [() => Reflect.construct(Function, ['return this'])(), () => Reflect.getPrototypeOf(async function () {}).constructor('return this')(), () => Object.getPrototypeOf(Function.prototype).constructor.constructor('return this')(), () => globalThis.constructor.constructor('return this')()]) {
      try { const g = f(); if (isReal(g)) return REACHED('real global'); out.push(g === globalThis ? 'compartment global' : typeof g); } catch (e) { out.push(e.name); }
    }
    return OK(out.join(', '));`);
  add('evaluators', 'constructor of endowed functions/classes', `
    const targets = { 'console.log': console.log, 'kernel.fs.readFileSync': kernel.fs.readFileSync, setTimeout, queueMicrotask, TextEncoder, TextDecoder, URL, 'process.cwd': process.cwd, 'process.stdout.write': process.stdout.write };
    const out = [];
    for (const k of Object.keys(targets)) {
      const f = targets[k];
      let res;
      try { const g = f.constructor('return this')(); if (isReal(g)) return REACHED(k + '.constructor("return this")() is the real global'); res = g === globalThis ? 'compartment-global' : typeof g; } catch (e) { res = 'throws ' + e.name; }
      out.push(k + ':' + res + (Object.getPrototypeOf(f) === Function.prototype ? '' : ':proto!=Function.prototype'));
    }
    return OK(out.join('; '));`);
  add('evaluators', 'nested Compartment', `
    if (typeof Compartment !== 'function') return OK('Compartment not available in guest');
    const c = new Compartment();
    const t = c.evaluate('typeof fetch + "/" + typeof self + "/" + typeof kernel');
    return t.startsWith('undefined/undefined') ? OK('guest can create child compartments; child sees: ' + t + ' (no added authority)') : REACHED(t);`);
  add('evaluators', 'SES powers visible in guest', `
    return INFO(['lockdown', 'harden', 'Compartment', 'assert', 'repairIntrinsics', 'hardenIntrinsics'].map((n) => n + ':' + typeof globalThis[n]).join(' '));`);

  // ---- dynamic import ------------------------------------------------------------------------
  const DATA = 'data:text/javascript,globalThis.__pwned_import=typeof fetch;export default typeof fetch';
  add('import', 'import() [default evaluate options]', `
    const m = await import('${DATA}');
    return REACHED('dynamic import executed a module in the real global; typeof fetch there = ' + m.default);`);
  add('import', 'import() [with __evadeImportExpressionTest__]', `
    const m = await import('${DATA}');
    return REACHED('dynamic import executed a module in the real global; typeof fetch there = ' + m.default);`, { evade: true });
  add('import', 'import/**/() and import\\n() [evade on]', `
    const m = await import/**/('${DATA}');
    const n = await import
      ('${DATA}');
    return REACHED('obfuscated dynamic import ran: ' + m.default);`, { evade: true });
  add('import', "Function('return import(...)') / eval string concat", `
    const out = [];
    for (const mk of [() => Function('return imp' + 'ort("${DATA}")')(), () => eval('imp' + 'ort("${DATA}")'), () => (0, eval)('imp' + 'ort("${DATA}")'), () => new (async () => {}).constructor('return imp' + 'ort("${DATA}")')()]) {
      try { const m = await mk(); return REACHED('import via runtime-constructed source ran: ' + m.default); } catch (e) { out.push(e.name + ': ' + e.message.slice(0, 70)); }
    }
    return OK(out.join(' | '));`);
  add('import', 'import.source() [not matched by the SES regexp]', `
    let r;
    try { r = Function('return imp' + 'ort.source("${DATA}")')(); } catch (e) { return OK('Function() path: ' + e.name + ': ' + e.message.slice(0, 90)); }
    try { const m = await r; return REACHED('import.source resolved: ' + typeof m); } catch (e) { return REACHED('import.source() expression was accepted and executed natively (promise rejected with ' + e.name + ': ' + e.message.slice(0, 80) + ')'); }`);
  add('import', 'import.defer() [not matched by the SES regexp]', `
    let r;
    try { r = Function('return imp' + 'ort.defer("${DATA}")')(); } catch (e) { return OK('Function() path: ' + e.name + ': ' + e.message.slice(0, 90)); }
    try { const m = await r; return REACHED('import.defer resolved, module ran in real global: ' + typeof m); } catch (e) { return REACHED('import.defer() expression was accepted and executed natively (rejected with ' + e.name + ': ' + e.message.slice(0, 80) + ')'); }`);
  add('import', 'import.meta', `
    const m = Function('return imp' + 'ort.meta')();
    return REACHED('import.meta available: ' + JSON.stringify(m));`);
  add('import', 'escaped keyword \\u0069mport()', `
    const m = await Function('return \\\\u0069mport("${DATA}")')();
    return REACHED('escaped import ran: ' + m.default);`);

  // ---- errors and stacks --------------------------------------------------------------------
  add('errors', 'new Error().stack', `
    const st = new Error('x').stack;
    return INFO('typeof stack=' + typeof st + ' value=' + JSON.stringify(String(st).slice(0, 160)));`);
  add('errors', 'Error.prepareStackTrace / CallSite objects', `
    let sites; let how = '';
    try { Error.prepareStackTrace = (e, s) => { sites = s; return s; }; how = 'assignment accepted'; } catch (e) { how = 'assignment threw ' + e.name; }
    const st = new Error('x').stack;
    const cs = Array.isArray(st) ? st[0] : sites && sites[0];
    if (cs && typeof cs === 'object') {
      let th, fn; try { th = cs.getThis && cs.getThis(); } catch (e) { th = 'threw'; } try { fn = cs.getFunction && cs.getFunction(); } catch (e) { fn = 'threw'; }
      if (isReal(th)) return REACHED('CallSite.getThis() returned the real global');
      return INFO(how + '; got CallSite objects: getThis=' + typeof th + ' getFunction=' + typeof fn);
    }
    return OK(how + '; no CallSite objects reached the guest; stack is ' + typeof st + ' ' + JSON.stringify(String(st).slice(0, 60)));`);
  add('errors', 'Error.captureStackTrace', `
    if (typeof Error.captureStackTrace !== 'function') return OK('Error.captureStackTrace is ' + typeof Error.captureStackTrace);
    const o = {}; Error.captureStackTrace(o);
    return INFO('captureStackTrace present; o.stack=' + JSON.stringify(String(o.stack).slice(0, 120)) + '; Error.stackTraceLimit=' + Error.stackTraceLimit);`);
  add('errors', 'error thrown by kernel function', `
    try { kernel.fs.readFileSync('/does/not/exist'); } catch (e) {
      let g; try { g = e.constructor.constructor('return this')(); } catch (err) { g = undefined; }
      if (isReal(g)) return REACHED('kernel error constructor chain reaches the real global');
      return OK('kernel error: instanceof guest Error=' + (e instanceof Error) + ' code=' + e.code + ' stack=' + JSON.stringify(String(e.stack).slice(0, 100)));
    }
    return INFO('no throw');`);
  add('errors', 'fn.caller / arguments.callee into kernel frames', `
    const out = [];
    try { out.push('readFileSync.caller=' + typeof kernel.fs.readFileSync.caller); } catch (e) { out.push('readFileSync.caller throws ' + e.name); }
    try { out.push('readFileSync.arguments=' + typeof kernel.fs.readFileSync.arguments); } catch (e) { out.push('.arguments throws ' + e.name); }
    let leak = 'not called';
    const probe = { toString() { try { leak = typeof probe.toString.caller; } catch (e) { leak = 'throws ' + e.name; } return '/x'; } };
    kernel.fs.existsSync(probe);
    out.push('callee.caller from coercion callback: ' + leak);
    let thisInTimer = await new Promise((r) => setTimeout(function () { r(this); }, 0));
    if (isReal(thisInTimer)) return REACHED('timer callback this is the real global');
    out.push('this in timer callback: ' + thisInTimer);
    return OK(out.join('; '));`);

  // ---- scope tricks ---------------------------------------------------------------------------
  add('scope', 'Symbol.unscopables on compartment global', `
    let how = '';
    try { globalThis[Symbol.unscopables] = { fetch: true, eval: true, Function: true, console: true }; how += 'assign accepted'; } catch (e) { how += 'assign threw ' + e.name; }
    try { Object.defineProperty(globalThis, Symbol.unscopables, { value: { console: true, fetch: true }, configurable: true }); how += '; defineProperty accepted'; } catch (e) { how += '; defineProperty threw ' + e.name; }
    let a, b, c;
    try { a = eval('typeof fetch'); } catch (e) { a = e.name; }
    try { b = Function('return typeof fetch + "/" + typeof importScripts')(); } catch (e) { b = e.name; }
    try { c = Function('return typeof console')(); } catch (e) { c = e.name; }
    if (a === 'function' || /function/.test(String(b))) return REACHED('unscopables exposed real globals: ' + a + ' ' + b);
    return OK(how + '; afterwards typeof fetch=' + a + ' / ' + b + ', typeof console=' + c);`);
  add('scope', 'delete/replace eval then direct eval', `
    const out = [];
    try { globalThis.eval = (s) => 'guest-eval'; out.push('replace: eval("typeof fetch") -> ' + eval('typeof fetch')); } catch (e) { out.push('replace threw ' + e.name); }
    try { delete globalThis.eval; const r = eval('typeof fetch'); if (r !== 'undefined') return REACHED('after deleting eval, direct eval saw typeof fetch=' + r); out.push('after delete: ' + r); } catch (e) { out.push('after delete: ' + e.name + ' ' + e.message.slice(0, 50)); }
    let t; try { t = Function('return typeof fetch + "/" + typeof self')(); } catch (e) { t = e.name; }
    if (t !== 'undefined/undefined') return REACHED(out.join('; ') + '; ' + t);
    return OK(out.join('; ') + '; Function() still confined afterwards: typeof fetch/self = ' + t);`);
  add('scope', 'undeclared assignment / var leakage', `
    let r; try { Function('leakedGlobal = 1; return typeof leakedGlobal')(); r = 'accepted'; } catch (e) { r = e.name + ': ' + e.message.slice(0, 60); }
    (0, eval)('var guestVar = 42');
    return CHECK('guestVar', 'undeclared assignment: ' + r + "; (0,eval)('var guestVar') -> globalThis.guestVar=" + globalThis.guestVar);`);
  add('scope', 'HTML comment / direct-eval censorship info', `
    const out = [];
    for (const [label, src] of [['<!-- in source', 'return 1 <!-- x'], ['import( in string', 'return "import(x)"'], ['eval( in nested code', 'return eval("1+1")']]) {
      try { out.push(label + ' => ' + Function(src)()); } catch (e) { out.push(label + ' => ' + e.name + ' ' + (/(SES_[A-Z_]+)/.exec(e.message) || [''])[0]); }
    }
    return INFO(out.join('; '));`);

  // ---- pollution of shared intrinsics --------------------------------------------------------
  add('pollution', 'mutate shared intrinsics', `
    const attempts = {
      'Object.prototype.polluted = 1': () => { Object.prototype.polluted = 1; },
      'Array.prototype.push = f': () => { Array.prototype.push = function () {}; },
      'Function.prototype.call = f': () => { Function.prototype.call = function () {}; },
      'Promise.prototype.then = f': () => { Promise.prototype.then = function () {}; },
      'JSON.parse = f': () => { JSON.parse = () => 1; },
      'Object.defineProperty(Object.prototype, "x")': () => { Object.defineProperty(Object.prototype, 'x', { value: 1 }); },
      'Object.setPrototypeOf(Object.prototype, {})': () => { Object.setPrototypeOf(Array.prototype, {}); },
      'Array.prototype.__proto__ = {}': () => { Array.prototype.__proto__ = {}; },
      'Symbol.iterator override on Array.prototype': () => { Array.prototype[Symbol.iterator] = function* () {}; },
      'Uint8Array.prototype.x': () => { Object.getPrototypeOf(Uint8Array.prototype).x = 1; },
      'Error.prototype.toString': () => { Error.prototype.toString = () => 'x'; },
      'delete Object.keys': () => { if (!delete Object.keys) throw new TypeError('delete returned false'); },
    };
    const ok = [], bad = [];
    for (const k of Object.keys(attempts)) { try { attempts[k](); bad.push(k); } catch (e) { ok.push(e.name); } }
    if (({}).polluted === 1 || bad.length) return REACHED('mutation succeeded: ' + bad.join(', '));
    return OK(ok.length + ' mutation attempts all threw (' + [...new Set(ok)].join(',') + '); isFrozen(Object.prototype)=' + Object.isFrozen(Object.prototype) + ' isFrozen(Array.prototype)=' + Object.isFrozen(Array.prototype) + ' isFrozen(Function.prototype)=' + Object.isFrozen(Function.prototype));`);
  add('pollution', 'guest-global Date/Math objects (endowed initial Date/Math)', `
    const out = [];
    try { Math.random = () => 4; out.push('Math.random overwritten'); } catch (e) { out.push('Math frozen'); }
    try { Date.now = () => 0; out.push('Date.now overwritten'); } catch (e) { out.push('Date frozen'); }
    return /overwritten/.test(out.join()) ? REACHED(out.join('; ')) : OK(out.join('; '));`);
  const MUTATE_ENDOWMENTS = `
    const attempts = {
      'console.log = f': () => { console.log = () => {}; },
      'kernel.fs.readFileSync = f': () => { kernel.fs.readFileSync = () => 'evil'; },
      'kernel.fs = {}': () => { kernel.fs = {}; },
      'kernel.fs.readFileSync.x = 1': () => { kernel.fs.readFileSync.x = 1; },
      'URL.prototype.toString = f': () => { URL.prototype.toString = () => 'evil'; },
      'URL.evil = 1': () => { URL.evil = 1; },
      'TextEncoder.prototype.encode = f': () => { TextEncoder.prototype.encode = () => new Uint8Array(0); },
      'TextDecoder.prototype.decode = f': () => { TextDecoder.prototype.decode = () => 'evil'; },
      'process.stdout.write = f': () => { process.stdout.write = () => true; },
    };
    const blocked = [], succeeded = [];
    for (const k of Object.keys(attempts)) { try { attempts[k](); succeeded.push(k); } catch (e) { blocked.push(k); } }
    const frozen = 'isFrozen: URL=' + Object.isFrozen(URL) + ' URL.prototype=' + Object.isFrozen(URL.prototype) + ' TextEncoder.prototype=' + Object.isFrozen(TextEncoder.prototype) + ' kernel.fs=' + Object.isFrozen(kernel.fs) + ' console=' + Object.isFrozen(console) + ' process=' + Object.isFrozen(process);
    if (succeeded.length) return REACHED('mutated shared endowments: ' + succeeded.join(', ') + '; ' + frozen);
    return OK(blocked.length + ' mutation attempts threw; ' + frozen);`;
  add('pollution', 'mutate endowed objects (hardened endowments)', MUTATE_ENDOWMENTS);
  add('pollution', 'mutate endowed objects (endowments NOT hardened: what-if)', MUTATE_ENDOWMENTS, { noHarden: true, whatIf: true });
  add('pollution', 'process object (deliberately mutable, per guest)', `
    process.env.FOO = 'bar'; process.title = 'x';
    return INFO('process.env.FOO=' + process.env.FOO + ' (per-guest object, not shared, functions on it are hardened: isFrozen(process.cwd)=' + Object.isFrozen(process.cwd) + ')');`);

  // ---- endowment prototype chains ----------------------------------------------------------------
  add('endowments', 'values returned by kernel / host objects', `
    const vals = { stat: kernel.fs.statSync('/'), bytes: kernel.fs.readFileSync('/app/compat.js'), list: kernel.fs.readdirSync('/'), url: new URL('http://a/b?c=1'), encoded: new TextEncoder().encode('x'), 'url.searchParams': new URL('http://a/?x=1').searchParams, 'stat.isFile': kernel.fs.statSync('/').isFile, timerId: setTimeout(() => {}, 0) };
    const out = [];
    for (const k of Object.keys(vals)) {
      const v = vals[k];
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) { out.push(k + ':primitive ' + typeof v); continue; }
      let g; try { g = v.constructor.constructor('return this')(); } catch (e) { g = e.name; }
      if (isReal(g)) return REACHED(k + '.constructor.constructor reaches the real global');
      let p = v, depth = 0; while (Object.getPrototypeOf(p) !== null && depth < 10) { p = Object.getPrototypeOf(p); depth++; }
      out.push(k + ':' + (g === globalThis ? 'compartment-global' : g) + (p === Object.prototype ? '' : ':root!=Object.prototype'));
    }
    return OK(out.join('; '));`);
  add('endowments', 'ambient statics on host classes', `
    const out = ['URL.createObjectURL=' + typeof URL.createObjectURL, 'URL.revokeObjectURL=' + typeof URL.revokeObjectURL, 'URL.canParse=' + typeof URL.canParse];
    let r; try { r = URL.createObjectURL({}); } catch (e) { r = 'throws ' + e.name; }
    out.push('URL.createObjectURL({}) -> ' + r);
    return INFO(out.join('; ') + ' (needs a Blob/MediaSource argument, which the guest cannot construct; still an ambient static the kernel should strip by wrapping URL)');`);
  add('endowments', 'timer wrapper rejects string callbacks', `
    try { setTimeout('globalThis.__pwned_timer_wrapped = 1', 0); } catch (e) { return OK('wrapper threw ' + e.name + ': ' + e.message); }
    await sleep(20);
    return CHECK('__pwned_timer_wrapped', 'wrapper accepted a string');`);
  add('endowments', 'RAW native setTimeout.bind(self) endowed (what-if)', `
    rawSetTimeout('self.__pwned_timer_raw = typeof fetch', 0);
    await sleep(30);
    return CHECK('__pwned_timer_raw', 'string passed to the native setTimeout is compiled and run in the real worker global');`, { extra: 'rawSetTimeout', whatIf: true });

  // ---- timing sources ------------------------------------------------------------------------------
  add('timing', 'Date.now / new Date / Math.random [minimal endowments]', `
    const out = [];
    for (const [k, f] of [['Date.now()', () => Date.now()], ['new Date()', () => String(new Date())], ['Date()', () => Date()], ['Math.random()', () => Math.random()], ['new Date(0)', () => new Date(0).toISOString()]]) { try { out.push(k + '=' + f()); } catch (e) { out.push(k + ' throws ' + e.name + ': ' + e.message.slice(0, 50)); } }
    out.push('typeof performance=' + typeof performance);
    return INFO(out.join('; '));`, { profile: 'minimal' });
  add('timing', 'Date.now / performance.now [extended endowments]', `
    const a = Date.now(); const p0 = performance.now(); let n = 0; while (performance.now() === p0) n++; const p1 = performance.now();
    return INFO('Date.now()=' + (a > 1.6e12 ? 'real wall clock' : a) + '; performance.now() granularity ~' + (p1 - p0).toFixed(4) + ' ms (endowed by kernel; resolution is whatever the kernel wrapper passes through)');`);

  // ---- WebAssembly -------------------------------------------------------------------------------------
  const WASM = '[0,97,115,109,1,0,0,0,1,12,2,96,2,127,127,1,127,96,1,127,1,127,2,9,1,3,101,110,118,1,102,0,1,3,3,2,0,1,7,15,2,3,97,100,100,0,1,5,99,97,108,108,102,0,2,10,16,2,7,0,32,0,32,1,106,11,6,0,32,0,16,0,11]';
  add('wasm', 'WebAssembly endowed: instantiate + what the instance can reach', `
    const bytes = new Uint8Array(${WASM});
    const mod = new WebAssembly.Module(bytes);
    let called = 0;
    const inst = new WebAssembly.Instance(mod, { env: { f: (x) => { called++; return x * 2; } } });
    const add = inst.exports.add(2, 3), callf = inst.exports.callf(21);
    let g; try { g = inst.exports.add.constructor('return this')(); } catch (e) { g = e.name; }
    if (isReal(g)) return REACHED('wasm export function constructor reaches real global');
    let link; try { new WebAssembly.Instance(mod, {}); link = 'no error'; } catch (e) { link = e.name; }
    const asyncInst = await WebAssembly.instantiate(bytes, { env: { f: (x) => x } });
    return OK('add(2,3)=' + add + ' callf(21)=' + callf + ' (import called ' + called + 'x); imports=' + JSON.stringify(WebAssembly.Module.imports(mod).map((i) => i.module + '.' + i.name)) + '; exports=' + Object.keys(inst.exports) + '; instantiate without imports -> ' + link + '; export.constructor("return this")() -> ' + (g === globalThis ? 'compartment global' : g) + '; async instantiate ok=' + (asyncInst.instance.exports.add(1, 1) === 2) + '; isFrozen(WebAssembly)=' + Object.isFrozen(WebAssembly) + '; statics: instantiateStreaming=' + typeof WebAssembly.instantiateStreaming + ' compileStreaming=' + typeof WebAssembly.compileStreaming + ' (need a Response, unreachable without fetch)');`, { extra: 'WebAssembly' });
  add('wasm', 'WebAssembly endowed: shared memory / JSPI info', `
    const out = [];
    try { new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }); out.push('shared Memory constructible'); } catch (e) { out.push('shared Memory: ' + e.name); }
    out.push('Suspending=' + typeof WebAssembly.Suspending + ' promising=' + typeof WebAssembly.promising + ' JSTag=' + typeof WebAssembly.JSTag + ' Exception=' + typeof WebAssembly.Exception);
    return INFO(out.join('; '));`, { extra: 'WebAssembly' });

  // ---- misc channels --------------------------------------------------------------------------------------
  add('misc', 'RegExp legacy statics / Symbol registry / locale (shared channels)', `
    /(secret)/.exec('secret');
    return INFO('RegExp.$1=' + String(RegExp.$1) + ' RegExp.input=' + String(RegExp.input) + '; Symbol.for registry is shared between compartments by design: ' + (Symbol.for('x') === Symbol.for('x')) + '; typeof Intl=' + typeof Intl + '; (1234.5).toLocaleString()=' + (1234.5).toLocaleString());`);
  add('misc', 'resource exhaustion (not prevented, by design)', `
    let depth = 0; const rec = () => { depth++; rec(); };
    let r; try { rec(); } catch (e) { r = e.name; }
    return INFO('deep recursion -> ' + r + ' at depth ' + depth + ' (catchable); infinite loops and memory exhaustion are NOT stopped by SES, see liveness test');`);

  self.CONFINE = { PRELUDE, TESTS: T };
})();
