// Renders markdown tables from dist/results.json (used to fill RESULTS.md).
// Usage: node tables.mjs [compat|perf|confine|all]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const R = JSON.parse(fs.readFileSync(path.join(root, 'dist/results.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(root, 'dist/meta.json'), 'utf8'));
const which = process.argv[2] || 'all';
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const out = [];

// test name -> [package, note / fix]
const PKG = {
  'core:fs': ['(kernel fs)', ''], 'core:path': ['path-browserify', ''], 'core:util': ['util', ''], 'core:events': ['events', ''], 'core:assert': ['assert', ''], 'core:buffer': ['buffer', ''],
  lodash: ['lodash', ''], 'lodash:_.template': ['lodash', ''], zod: ['zod', ''], marked: ['marked', ''], 'marked:html-comment input': ['marked', ''], 'markdown-it': ['markdown-it', ''], yaml: ['yaml', ''], semver: ['semver', ''],
  'date-fns': ['date-fns', ''], ajv: ['ajv', ''], chalk: ['chalk', ''], commander: ['commander', ''], uuid: ['uuid', ''], 'preact+render-to-string': ['preact', ''],
  'typescript:transpile': ['typescript', ''], 'typescript:typecheck': ['typescript', ''], acorn: ['acorn', ''], 'acorn:html-comment token': ['acorn', ''], prettier: ['prettier', ''], chai: ['chai', ''], uvu: ['uvu', ''],
  immer: ['immer', ''], handlebars: ['handlebars', ''], dayjs: ['dayjs', ''], minimist: ['minimist', ''], debug: ['debug', ''], rxjs: ['rxjs', ''], mustache: ['mustache', ''], nanoid: ['nanoid', ''],
};

if ((which === 'all' || which === 'compat') && R.compat) {
  const cols = ['plain', 'ses-moderate', 'ses-severe', 'ses-min', 'ses-moderate-minimal', 'ses-moderate-no-evade'];
  out.push('| test | package | kind | plain worker | SES moderate | SES severe | SES min | SES moderate, brief-only endowments | SES moderate, default censorship (no evade) |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const [test, by] of Object.entries(R.compat.tests)) {
    const [pkg] = PKG[test] || [test];
    const p = meta.packages[pkg];
    const kind = p ? (p.type === 'module' ? 'ESM-only*' : p.esmFiles && by['ses-moderate'].esmModules ? 'CJS+ESM files*' : 'CJS') : '';
    const cell = (c) => { const v = by[c]; if (!v) return ''; return v.ok ? 'pass' : 'FAIL: ' + esc(v.error.replace(/guest:\/\//g, '').slice(0, 110)); };
    out.push(`| ${esc(test)} | ${p ? pkg + '@' + p.version : pkg} | ${kind} | ${cols.map(cell).join(' | ')} |`);
  }
  out.push('');
  out.push('Totals: ' + Object.entries(R.compat.summary).map(([k, v]) => `${k} ${v}`).join(', '));
  out.push('');
}

if ((which === 'all' || which === 'perf') && R.perf) {
  out.push('| workload | plain median ms (min-max) | SES compartment median ms (min-max) | slowdown | SES + pinned globals median ms (min-max) | slowdown | n per mode |');
  out.push('|---|---|---|---|---|---|---|');
  const f = (x) => `${x.medianMs} (${x.minMs}-${x.maxMs})`;
  for (const [w, row] of Object.entries(R.perf.workloads)) out.push(`| ${w} | ${f(row.plain)} | ${f(row.ses)} | ${row.slowdownSes}x | ${f(row['ses+pinnedGlobals'])} | ${row.slowdownSesPinned}x | ${row.plain.n} |`);
  out.push('');
  out.push('| module (first require in a fresh worker) | source | plain cold ms (runs) | SES cold ms (runs) | slowdown | SES+pinned cold ms | re-require in a fresh guest, same worker: plain / SES ms |');
  out.push('|---|---|---|---|---|---|---|');
  for (const [spec, row] of Object.entries(R.perf.moduleLoad)) out.push(`| ${spec} | ${row.plain.modules} files, ${(row.plain.sourceBytes / 1e6).toFixed(2)} MB | ${row.plain.coldFirstLoadMedianMs} (${row.plain.coldFirstLoadMs.join(', ')}) | ${row.ses.coldFirstLoadMedianMs} (${row.ses.coldFirstLoadMs.join(', ')}) | ${row.slowdownColdSes}x | ${row['ses+pinnedGlobals'].coldFirstLoadMedianMs} | ${row.plain.reloadInFreshGuestMedianMs} / ${row.ses.reloadInFreshGuestMedianMs} |`);
  out.push('');
}

if ((which === 'all' || which === 'confine') && R.confinement) {
  out.push('| group | probe (run inside the compartment) | result | how / what the guest saw | same probe, plain worker |');
  out.push('|---|---|---|---|---|');
  const rs = R.confinement.results;
  const typeofs = rs.filter((r) => r.group === 'globals' && r.name.startsWith('typeof '));
  const blockedNames = typeofs.filter((r) => r.status === 'blocked').map((r) => r.name.slice(7));
  const reach = typeofs.filter((r) => r.status !== 'blocked');
  const plainUndefined = typeofs.filter((r) => r.controlPlain === 'blocked').map((r) => r.name.slice(7));
  out.push(`| globals | \`typeof X\` for ${blockedNames.map((n) => '`' + n + '`').join(', ')} | blocked | all \`"undefined"\`: the name is not a property of the compartment global, lookup ends at SES's scope-terminator proxy | reachable (except ${plainUndefined.map((n) => '`' + n + '`').join(', ')}, which do not exist in a non-isolated dedicated worker either) |`);
  for (const r of reach) out.push(`| globals | ${esc(r.name)} | **${r.status}** | ${esc(r.how)} | ${r.controlPlain} |`);
  for (const r of rs) {
    if (typeofs.includes(r)) continue;
    const status = r.status === 'reachable' ? '**REACHABLE**' + (r.whatIf ? ' (deliberate what-if)' : '') : r.status;
    let how = esc(r.how.replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://host'));
    if (how.length > 520) how = how.slice(0, 520) + '…';
    if (r.errorTamingSafe) how += ` — with errorTaming:'safe': ${esc(r.errorTamingSafe.how.replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://host').slice(0, 160))}`;
    out.push(`| ${r.group} | ${esc(r.name)} | ${status} | ${how} | ${r.controlPlain} |`);
  }
  out.push('');
  out.push('Counts: ' + JSON.stringify(R.confinement.counts) + '; side effects found on the real worker global afterwards: ' + JSON.stringify(R.confinement.realGlobalSideEffects));
  out.push('');
}
console.log(out.join('\n'));
