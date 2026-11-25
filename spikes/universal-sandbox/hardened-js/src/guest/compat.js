'use strict';
// Compatibility smoke tests. Each test loads a real npm package from the fake fs
// through the kernel's require() and exercises it. Throws on failure.
const eq = (a, b, what) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what || 'assertion'}: got ${x}, expected ${y}`);
};
const ok = (v, what) => { if (!v) throw new Error('expected truthy: ' + what); };
const dflt = (m) => (m && m.default !== undefined ? m.default : m);

const tests = {
  'core:fs': () => {
    const fs = require('fs');
    fs.writeFileSync('/app/tmp.txt', 'hello');
    eq(fs.readFileSync('/app/tmp.txt', 'utf8'), 'hello');
    eq(fs.readFileSync('/app/tmp.txt').length, 5);
    ok(fs.existsSync('/node_modules/lodash/package.json'), 'exists');
    ok(fs.readdirSync('/node_modules').includes('lodash'), 'readdir');
    ok(fs.statSync('/node_modules').isDirectory() && fs.statSync('/app/tmp.txt').isFile(), 'stat');
    let code; try { fs.readFileSync('/nope'); } catch (e) { code = e.code; }
    eq(code, 'ENOENT');
    eq(require('node:fs'), fs);
    return 'read/write/exists/readdir/stat ok';
  },
  'core:path': () => {
    const path = require('path');
    eq(path.join('/a', '../b', 'c.js'), '/b/c.js'); eq(path.extname('x.ts'), '.ts'); eq(path.resolve('x'), '/app/x');
    return 'path-browserify';
  },
  'core:util': () => {
    const util = require('util');
    eq(util.format('%s=%d', 'a', 1), 'a=1');
    ok(util.inspect({ a: [1, { b: 2 }] }).includes('b: 2'), 'inspect');
    function A() {} function B() {} util.inherits(B, A); ok(new B() instanceof A, 'inherits');
    ok(util.types.isTypedArray(new Uint8Array(1)) && util.types.isPromise(Promise.resolve()), 'types');
    return util.promisify((cb) => cb(null, 7))().then((v) => { eq(v, 7); return 'util@0.12 (format/inspect/inherits/types/promisify)'; });
  },
  'core:events': () => {
    const EventEmitter = require('events');
    const e = new EventEmitter(); let n = 0; e.on('x', (v) => { n += v; }); e.once('x', (v) => { n += v; }); e.emit('x', 2); e.emit('x', 2);
    eq(n, 6);
    class Sub extends EventEmitter {} ok(new Sub().listenerCount('x') === 0, 'subclass');
    return 'events@3';
  },
  'core:assert': () => {
    const assert = require('assert');
    assert.strictEqual(1, 1); assert.deepStrictEqual({ a: [1] }, { a: [1] });
    let threw = false; try { assert.deepStrictEqual({ a: 1 }, { a: 2 }); } catch (e) { threw = e.name === 'AssertionError' || e.code === 'ERR_ASSERTION'; }
    ok(threw, 'AssertionError thrown');
    assert.throws(() => { throw new TypeError('x'); }, TypeError);
    return 'assert@2';
  },
  'core:buffer': () => {
    const { Buffer } = require('buffer');
    eq(Buffer.from('héllo', 'utf8').toString('base64'), 'aMOpbGxv');
    eq(Buffer.concat([Buffer.from([1, 2]), Buffer.alloc(2)]).length, 4);
    eq(Buffer.from('ff00', 'hex').readUInt16BE(0), 0xff00);
    ok(Buffer.isBuffer(Buffer.from('a')) && Buffer.from('a') instanceof Uint8Array, 'isBuffer');
    return 'buffer@6';
  },
  lodash: () => {
    const _ = require('lodash');
    eq(_.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    eq(_.cloneDeep({ a: { b: [1] } }), { a: { b: [1] } });
    eq(_.chain([3, 1, 2]).sortBy().map((x) => x * 2).value(), [2, 4, 6]);
    eq(_.get({ a: [{ b: 1 }] }, 'a[0].b'), 1);
    return _.VERSION;
  },
  'lodash:_.template': () => {
    const _ = require('lodash');
    eq(_.template('<%= o.a %>', { variable: 'o' })({ a: 1 }), '1');
    // default mode generates sloppy code using a `with` statement
    eq(_.template('<%= a %>-<%- b %>')({ a: 1, b: '<' }), '1-&lt;');
    return 'template ok';
  },
  zod: () => {
    const { z } = require('zod');
    const S = z.object({ name: z.string().min(1), age: z.number().int().positive(), tags: z.array(z.string()).default([]), email: z.string().email().optional() });
    eq(S.parse({ name: 'a', age: 3 }), { name: 'a', age: 3, tags: [] });
    const r = S.safeParse({ name: '', age: -1 });
    ok(!r.success && r.error.issues.length === 2, 'issues');
    eq(z.union([z.literal('a'), z.number()]).safeParse(true).success, false);
    return 'object/union/safeParse ok';
  },
  marked: () => {
    const { marked } = require('marked');
    eq(marked.parse('# hi **there**'), '<h1>hi <strong>there</strong></h1>\n');
    ok(marked.parse('| a |\n|---|\n| 1 |').includes('<table>'), 'gfm table');
    return 'parse ok';
  },
  'marked:html-comment input': () => {
    // Behavioural check for SES's source "evasion": does the library still recognise an HTML
    // comment in its INPUT after its own source text was rewritten? (input built by concatenation
    // so this test file itself is not affected)
    const { marked } = require('marked');
    const open = '<' + '!--', close = '--' + '>';
    eq(marked.parse(open + ' note ' + close + '\n\nhi'), open + ' note ' + close + '<p>hi</p>\n');
    return 'html comment passed through';
  },
  'markdown-it': () => {
    const MarkdownIt = dflt(require('markdown-it'));
    eq(new MarkdownIt().render('*x* `y`'), '<p><em>x</em> <code>y</code></p>\n');
    return 'render ok';
  },
  yaml: () => {
    const YAML = require('yaml');
    eq(YAML.parse('a: 1\nb:\n  - x\n  - {c: true}\n'), { a: 1, b: ['x', { c: true }] });
    eq(YAML.stringify({ a: [1, 2] }), 'a:\n  - 1\n  - 2\n');
    return 'parse/stringify ok';
  },
  semver: () => {
    const semver = require('semver');
    ok(semver.satisfies('1.2.3', '^1.0.0') && !semver.satisfies('2.0.0', '^1.0.0'), 'satisfies');
    eq(semver.maxSatisfying(['1.0.0', '1.5.0', '2.0.0'], '1.x'), '1.5.0');
    eq(semver.inc('1.2.3', 'minor'), '1.3.0');
    return 'ok';
  },
  'date-fns': () => {
    const { format, addDays, differenceInCalendarDays, parseISO, formatDistance } = require('date-fns');
    const d = new Date(2024, 0, 15, 12);
    eq(format(addDays(d, 20), 'yyyy-MM-dd EEEE'), '2024-02-04 Sunday');
    eq(differenceInCalendarDays(parseISO('2024-03-01'), d), 46);
    eq(formatDistance(d, addDays(d, 3)), '3 days');
    return 'format/addDays/parseISO ok';
  },
  ajv: () => {
    const Ajv = dflt(require('ajv'));
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile({ type: 'object', properties: { a: { type: 'integer', minimum: 1 }, b: { type: 'string', pattern: '^x' } }, required: ['a'], additionalProperties: false });
    ok(validate({ a: 1, b: 'xy' }), 'valid');
    ok(!validate({ a: 0, c: 1 }) && validate.errors.length === 2, 'errors');
    return 'compile (codegen via new Function) ok';
  },
  chalk: () => {
    const { Chalk } = require('chalk');
    const c = new Chalk({ level: 1 });
    eq(c.red.bold('x'), '\u001b[31m\u001b[1mx\u001b[22m\u001b[39m');
    const auto = dflt(require('chalk'));
    return 'level-1 styling ok; auto-detected level=' + auto.level;
  },
  commander: () => {
    const { Command } = require('commander');
    const p = new Command();
    p.exitOverride().option('-p, --port <n>', 'port', (v) => parseInt(v, 10), 80).option('-v, --verbose').argument('<file>');
    p.parse(['-p', '8080', '--verbose', 'in.txt'], { from: 'user' });
    eq(p.opts(), { port: 8080, verbose: true }); eq(p.args, ['in.txt']);
    return 'parse ok';
  },
  uuid: () => {
    const { v4, v5, validate, version } = require('uuid');
    const id = v4();
    ok(validate(id) && version(id) === 4, 'v4');
    eq(v5('hello', v5.URL), v5('hello', v5.URL));
    return 'v4/v5 ok';
  },
  'preact+render-to-string': () => {
    const { h, Fragment } = require('preact');
    const { useState } = require('preact/hooks');
    const render = dflt(require('preact-render-to-string'));
    const renderToString = typeof render === 'function' ? render : require('preact-render-to-string').renderToString;
    const Item = ({ n }) => { const [v] = useState(n * 2); return h('li', { class: 'i' }, v); };
    const html = renderToString(h(Fragment, null, h('ul', null, [1, 2].map((n) => h(Item, { n, key: n })))));
    eq(html, '<ul><li class="i">2</li><li class="i">4</li></ul>');
    return 'h/hooks/renderToString ok';
  },
  'typescript:transpile': () => {
    const ts = require('typescript');
    const out = ts.transpileModule('const x: number = 1; export const f = <T,>(a: T): T => a; enum E { A, B }', { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } });
    ok(out.outputText.includes('const x = 1;') && out.outputText.includes('exports.f'), 'transpile output');
    return 'ts ' + ts.version;
  },
  'typescript:typecheck': () => {
    const ts = require('typescript');
    const check = require('./tscheck.js');
    const good = check(ts, '/app/a.ts', 'const xs: number[] = [1,2,3]; export const s: string = xs.map(x => x * 2).join(",");');
    eq(good, []);
    const bad = check(ts, '/app/b.ts', 'interface P { name: string } const p: P = { name: 1 }; export const n: number = "x".length + p.nope;');
    eq(bad.map((d) => d.code).sort(), [2322, 2339]);
    return 'createProgram + getPreEmitDiagnostics ok (lib.es2020 from fake fs)';
  },
  acorn: () => {
    const acorn = require('acorn');
    const ast = acorn.parse('const a = 1; export default async function* f() { yield a ?? 2; }', { ecmaVersion: 2022, sourceType: 'module' });
    eq(ast.body.map((n) => n.type), ['VariableDeclaration', 'ExportDefaultDeclaration']);
    return acorn.version;
  },
  'acorn:html-comment token': () => {
    const acorn = require('acorn');
    // Annex B: in sloppy scripts an HTML-open-comment sequence starts a line comment
    const ast = acorn.parse('x\n<' + '!-- y\nz', { ecmaVersion: 2022, sourceType: 'script' });
    eq(ast.body.length, 2);
    return 'annex-B html comment tokenised';
  },
  prettier: async () => {
    const prettier = require('prettier/standalone');
    const babel = require('prettier/plugins/babel');
    const estree = require('prettier/plugins/estree');
    const tsPlugin = require('prettier/plugins/typescript');
    const md = require('prettier/plugins/markdown');
    eq(await prettier.format('const a={b:1,c:[1,2]};function f( x ){return x}', { parser: 'babel', plugins: [babel, estree] }), 'const a = { b: 1, c: [1, 2] };\nfunction f(x) {\n  return x;\n}\n');
    eq(await prettier.format('let x:number=1', { parser: 'typescript', plugins: [tsPlugin, estree] }), 'let x: number = 1;\n');
    eq(await prettier.format('*  a\n*  b', { parser: 'markdown', plugins: [md] }), '- a\n- b\n');
    return 'standalone ' + prettier.version + ' (babel, typescript, markdown parsers)';
  },
  chai: () => {
    const { expect, assert } = require('chai');
    expect({ a: [1, 2] }).to.deep.equal({ a: [1, 2] });
    expect([1, 2, 3]).to.include(2).and.have.lengthOf(3);
    let msg; try { expect(1).to.equal(2); } catch (e) { msg = e.message; }
    eq(msg, 'expected 1 to equal 2');
    assert.throws(() => { throw new RangeError('boom'); }, RangeError, /boom/);
    return 'expect/assert ok';
  },
  uvu: async () => {
    const { suite, exec } = require('uvu');
    const assert = require('uvu/assert');
    const s = suite('math'); let ran = 0;
    s('adds', () => { ran++; assert.is(1 + 1, 2); });
    s('deep', () => { ran++; assert.equal({ a: [1] }, { a: [1] }); });
    s.run();
    await exec();
    eq(ran, 2);
    let threw = false; try { assert.is(1, 2); } catch (e) { threw = e.name === 'Assertion'; }
    ok(threw, 'uvu Assertion thrown');
    return 'suite ran 2 tests, exitCode=' + process.exitCode;
  },
  immer: () => {
    const { produce } = require('immer');
    const base = { a: [1], b: { c: 1 } };
    const next = produce(base, (d) => { d.a.push(2); d.b.c++; });
    eq(next, { a: [1, 2], b: { c: 2 } }); eq(base, { a: [1], b: { c: 1 } });
    ok(Object.isFrozen(next), 'frozen result');
    return 'produce ok';
  },
  handlebars: () => {
    const Handlebars = require('handlebars');
    eq(Handlebars.compile('{{#each xs}}<{{this}}>{{/each}} {{up n}}')({ xs: [1, 2], n: 'a' }, { helpers: { up: (s) => s.toUpperCase() } }), '<1><2> A');
    return 'compile (codegen via Function) ok';
  },
  dayjs: () => {
    const dayjs = require('dayjs');
    eq(dayjs('2024-01-15').add(1, 'month').format('YYYY-MM-DD'), '2024-02-15');
    return 'ok';
  },
  minimist: () => {
    eq(require('minimist')(['-a', '1', '--b=x', 'y']), { _: ['y'], a: 1, b: 'x' });
    return 'ok';
  },
  debug: () => {
    const debug = require('debug');
    const d = debug('spike:test'); debug.enable('spike:*');
    const lines = []; debug.log = (...a) => lines.push(a.join(' '));
    d('hello', 5);
    ok(lines.length === 1 && lines[0].includes('spike:test') && lines[0].includes('hello'), 'debug output: ' + JSON.stringify(lines));
    return 'ok';
  },
  rxjs: () => {
    const { of, map, filter, toArray, firstValueFrom } = require('rxjs');
    return firstValueFrom(of(1, 2, 3, 4).pipe(filter((x) => x % 2 === 0), map((x) => x * 10), toArray())).then((v) => { eq(v, [20, 40]); return 'pipe ok'; });
  },
  mustache: () => {
    const Mustache = dflt(require('mustache'));
    eq(Mustache.render('{{a}} {{#b}}x{{/b}}', { a: 1, b: [1, 2] }), '1 xx');
    return 'ok';
  },
  nanoid: () => {
    const { nanoid, customAlphabet } = require('nanoid');
    ok(nanoid().length === 21 && customAlphabet('ab', 5)().length === 5, 'ids');
    return 'ok';
  },
};

exports.list = Object.keys(tests);
exports.run = async (name) => String(await tests[name]());
