// Build step (runs in Node on the build machine):
//  - packs unmodified npm package files into dist/image.json (the fake-fs image)
//  - pre-transforms ESM files to CJS with esbuild (stored next to the originals,
//    in a separate `cjs` map, originals are kept untouched)
//  - copies ses / esbuild-wasm browser assets, bundles @endo/module-source
//  - generates perf fixtures
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const nm = path.join(root, 'node_modules');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

// Root packages that guests may require(). Dependencies are followed.
const ROOTS = [
  'lodash', 'zod', 'marked', 'markdown-it', 'yaml', 'semver', 'date-fns', 'ajv',
  'chalk', 'commander', 'uuid', 'preact', 'preact-render-to-string', 'typescript',
  'acorn', 'prettier', 'chai', 'uvu',
  // extras for more compatibility signal
  'immer', 'handlebars', 'dayjs', 'minimist', 'debug', 'rxjs', 'mustache', 'nanoid',
  // browser shims used as Node core modules
  'path-browserify', 'util', 'events', 'assert', 'buffer',
];

// Per-package file filters (only to keep the image small; files are unmodified).
const FILTERS = {
  typescript: (rel) => rel === 'package.json' || rel === 'lib/typescript.js' || /^lib\/lib\..*\.d\.ts$/.test(rel),
  prettier: (rel) => rel === 'package.json' || rel === 'standalone.js' || /^plugins\/(babel|estree|typescript|markdown|postcss)\.js$/.test(rel),
  'date-fns': (rel) => !rel.startsWith('fp/') && !rel.startsWith('docs/') && (!rel.startsWith('locale/') || rel.startsWith('locale/en-US') || rel.startsWith('locale/_lib')) && !/cdn(\.min)?\.js$/.test(rel),
  rxjs: (rel) => rel === 'package.json' || rel.startsWith('dist/cjs/'),
  handlebars: (rel) => rel === 'package.json' || rel.startsWith('dist/cjs/') || rel.startsWith('lib/'),
};
const EXT_OK = /\.(js|cjs|mjs|json)$/;
const SKIP_DIR = /^(test|tests|__tests__|docs|example|examples|\.github|node_modules|src-xs|benchmark|benchmarks)$/;

function walk(dir, rel, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIR.test(ent.name)) continue;
      walk(path.join(dir, ent.name), r, out);
    } else if (ent.isFile()) out.push(r);
  }
}

const seen = new Set();
const queue = [...ROOTS];
const files = {};
const cjs = {};
const pkgStats = {};
const esmErrors = [];
const typeCache = new Map();

function pkgTypeFor(absFile) {
  let d = path.dirname(absFile);
  for (;;) {
    if (typeCache.has(d)) return typeCache.get(d);
    const pj = path.join(d, 'package.json');
    if (fs.existsSync(pj)) {
      let t = 'commonjs';
      try { t = JSON.parse(fs.readFileSync(pj, 'utf8')).type || 'commonjs'; } catch {}
      typeCache.set(d, t);
      return t;
    }
    const up = path.dirname(d);
    if (up === d || d === nm) return 'commonjs';
    d = up;
  }
}

const tBuild = Date.now();
let esmTransformMs = 0;
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const dir = path.join(nm, name);
  if (!fs.existsSync(dir)) { console.warn('missing package', name); continue; }
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pj.dependencies || {})) queue.push(dep);
  const list = [];
  walk(dir, '', list);
  const filter = FILTERS[name];
  let bytes = 0, count = 0, esmCount = 0;
  for (const rel of list) {
    const isDts = /\.d\.(ts|cts|mts)$/.test(rel);
    if (filter) { if (!filter(rel)) continue; }
    else if (!EXT_OK.test(rel) || isDts) continue;
    if (/\.map$/.test(rel)) continue;
    const abs = path.join(dir, rel);
    const src = fs.readFileSync(abs, 'utf8');
    const vpath = `/node_modules/${name}/${rel}`;
    files[vpath] = src;
    bytes += src.length; count++;
    const isEsm = /\.mjs$/.test(rel) || (/\.js$/.test(rel) && pkgTypeFor(abs) === 'module');
    if (isEsm) {
      const t = performance.now();
      try {
        const r = esbuild.transformSync(src, {
          format: 'cjs', target: 'es2022', loader: 'js', sourcefile: vpath,
          supported: { 'dynamic-import': false }, logLevel: 'silent',
        });
        cjs[vpath] = r.code;
        esmCount++;
      } catch (e) {
        esmErrors.push({ file: vpath, error: String(e.message).split('\n')[0] });
      }
      esmTransformMs += performance.now() - t;
    }
  }
  pkgStats[name] = { version: pj.version, type: pj.type || 'commonjs', files: count, bytes, esmFiles: esmCount, root: ROOTS.includes(name) };
}

// Guest programs and tiny core-module stubs (evaluated inside the compartment).
for (const f of fs.readdirSync(path.join(root, 'src/guest'))) {
  files['/app/' + f] = fs.readFileSync(path.join(root, 'src/guest', f), 'utf8');
}

// ---- fixtures -------------------------------------------------------------
function genTs(targetLines) {
  const out = [];
  out.push(`type Json = string | number | boolean | null | Json[] | { [k: string]: Json };`);
  out.push(`interface Entity<T extends string = string> { id: number; kind: T; tags: readonly string[]; meta?: Record<string, Json>; }`);
  out.push(`type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };`);
  out.push(`type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };`);
  out.push(`function ok<T>(value: T): Result<T, never> { return { ok: true, value }; }`);
  out.push(`function err<E>(error: E): Result<never, E> { return { ok: false, error }; }`);
  let i = 0;
  while (out.length < targetLines) {
    const n = i++;
    out.push(`
interface Model${n} extends Entity<"m${n}"> {
  name: string;
  score: number;
  parent?: Model${Math.max(0, n - 1)};
  children: Array<Model${n}>;
  payload: { a: number; b: string; c: [number, string, boolean?] };
}
class Repo${n}<T extends Model${n} = Model${n}> {
  private items = new Map<number, T>();
  constructor(private readonly label: string) {}
  add(item: T): this { this.items.set(item.id, item); return this; }
  get(id: number): Result<T, string> {
    const v = this.items.get(id);
    return v ? ok(v) : err(\`\${this.label}: missing \${id}\`);
  }
  map<U>(fn: (item: T, index: number) => U): U[] {
    return [...this.items.values()].map(fn);
  }
  total(): number {
    return this.map((x) => x.score + x.payload.a).reduce((a, b) => a + b, 0);
  }
  patch(id: number, p: DeepPartial<T>): Result<T, string> {
    const r = this.get(id);
    if (!r.ok) return r;
    const next = { ...r.value, ...p } as T;
    this.items.set(id, next);
    return ok(next);
  }
}
function make${n}(id: number): Model${n} {
  return { id, kind: "m${n}", tags: ["t${n}", String(id)], name: "n" + id, score: id * ${n + 1}, children: [], payload: { a: id, b: "b", c: [id, "x"] } };
}
function pick${n}<K extends keyof Model${n}>(m: Model${n}, ...keys: K[]): Pick<Model${n}, K> {
  const o = {} as Pick<Model${n}, K>;
  for (const k of keys) o[k] = m[k];
  return o;
}
const repo${n} = new Repo${n}("r${n}").add(make${n}(1)).add(make${n}(2));
const picked${n} = pick${n}(make${n}(3), "name", "score");
const total${n}: number = repo${n}.total() + picked${n}.score + picked${n}.name.length;
type Keys${n} = { [K in keyof Model${n} as \`get\${Capitalize<K & string>}\`]: () => Model${n}[K] };
async function load${n}(ids: number[]): Promise<Array<Result<Model${n}, string>>> {
  const rs = await Promise.all(ids.map(async (id) => repo${n}.get(id)));
  return rs.filter((r) => r.ok || r.error.length > 0);
}`.trim());
  }
  const text = out.join('\n');
  return text + `\nexport const grand: number = ${Array.from({ length: i }, (_, k) => 'total' + k).join(' + ')};\n`;
}
// genTs counts array entries (one model block each); grow until ~2k lines
function genTsLines(lines) {
  let n = 6; let t = genTs(n);
  while (t.split('\n').length < lines) { n += 1; t = genTs(n); }
  return t;
}
const tsFixture = genTsLines(2000);
files['/fixtures/big.ts'] = tsFixture;

function genMd(targetBytes) {
  const parts = [];
  let i = 0;
  let size = 0;
  while (size < targetBytes) {
    const s = `
# Section ${i}: the *quick* brown **fox**

Paragraph ${i} with [a link](https://example.com/${i}) and \`inline code\`, plus some
~~strikethrough~~ and an image ![alt](img${i}.png "title"). Lorem ipsum dolor sit amet,
consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

## Subsection ${i}.1

- item one with **bold**
- item two with *emphasis*
  - nested item \`x${i}\`
  - another nested item
1. ordered
2. list

> A blockquote with a [reference][ref${i}] inside it.
> Second line of the quote.

\`\`\`js
function f${i}(a, b) { return a + b * ${i}; }
\`\`\`

| col a | col b | col c |
|-------|:-----:|------:|
| ${i} | text | **x** |
| ${i + 1} | more | \`y\` |

[ref${i}]: https://example.org/ref/${i}

---
`;
    parts.push(s); size += s.length; i++;
  }
  return parts.join('');
}
files['/fixtures/big.md'] = genMd(400_000);

const image = { files, cjs };
const json = JSON.stringify(image);
fs.writeFileSync(path.join(dist, 'image.json'), json);

// A small image (no typescript/prettier) for the restart-time measurement.
const small = { files: {}, cjs: {} };
for (const k of Object.keys(files)) if (!/^\/node_modules\/(typescript|prettier|date-fns|rxjs)\//.test(k)) small.files[k] = files[k];
for (const k of Object.keys(cjs)) if (small.files[k] !== undefined) small.cjs[k] = cjs[k];
const smallJson = JSON.stringify(small);
fs.writeFileSync(path.join(dist, 'image-small.json'), smallJson);

// ---- browser assets ---------------------------------------------------------
fs.copyFileSync(path.join(nm, 'ses/dist/ses.umd.js'), path.join(dist, 'ses.umd.js'));
fs.copyFileSync(path.join(nm, 'esbuild-wasm/lib/browser.js'), path.join(dist, 'esbuild-browser.js'));
fs.copyFileSync(path.join(nm, 'esbuild-wasm/esbuild.wasm'), path.join(dist, 'esbuild.wasm'));
await esbuild.build({
  stdin: { contents: `export { ModuleSource } from '@endo/module-source';`, resolveDir: root },
  bundle: true, format: 'iife', globalName: 'EndoModuleSource', platform: 'browser',
  outfile: path.join(dist, 'module-source.js'), logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.BABEL_TYPES_8_BREAKING': 'false', 'process.env.BABEL_8_BREAKING': 'false' },
});

const sesPkg = JSON.parse(fs.readFileSync(path.join(nm, 'ses/package.json'), 'utf8'));
const meta = {
  builtAt: new Date().toISOString(),
  ses: sesPkg.version,
  esbuild: esbuild.version,
  imageBytes: json.length,
  smallImageBytes: smallJson.length,
  fileCount: Object.keys(files).length,
  esmFilesPretransformed: Object.keys(cjs).length,
  esmPretransformMsOnBuildMachine: Math.round(esmTransformMs),
  esmErrors,
  tsFixtureLines: tsFixture.split('\n').length,
  mdFixtureBytes: files['/fixtures/big.md'].length,
  moduleSourceBundleBytes: fs.statSync(path.join(dist, 'module-source.js')).size,
  sesBytes: fs.statSync(path.join(dist, 'ses.umd.js')).size,
  packages: pkgStats,
};
fs.writeFileSync(path.join(dist, 'meta.json'), JSON.stringify(meta, null, 2));
console.error(`[build] image ${(json.length / 1e6).toFixed(1)} MB, ${meta.fileCount} files, ${meta.esmFilesPretransformed} ESM files pre-transformed in ${meta.esmPretransformMsOnBuildMachine} ms, ${esmErrors.length} ESM transform errors, total ${Date.now() - tBuild} ms`);
if (esmErrors.length) console.error(esmErrors.slice(0, 10));
