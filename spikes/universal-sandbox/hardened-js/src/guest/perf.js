'use strict';
// CPU-bound workloads. setup() builds inputs (not timed), run(state) is timed by the kernel.
const fs = require('fs');
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

exports.tscheck = {
  setup() { return { ts: require('typescript'), check: require('./tscheck.js'), src: fs.readFileSync('/fixtures/big.ts', 'utf8') }; },
  run(s) { const d = s.check(s.ts, '/fixtures/big.ts', s.src); if (d.length) throw new Error('unexpected diagnostics: ' + JSON.stringify(d.slice(0, 3))); return s.src.length; },
};
exports.marked = {
  setup() { return { marked: require('marked').marked, md: fs.readFileSync('/fixtures/big.md', 'utf8') }; },
  run(s) { return s.marked.parse(s.md).length; },
};
exports.zod = {
  setup() {
    const { z } = require('zod');
    const schema = z.object({ id: z.number().int().nonnegative(), name: z.string().min(1).max(40), email: z.string().email(), tags: z.array(z.string()).max(8), nested: z.object({ a: z.number(), b: z.boolean(), c: z.enum(['x', 'y', 'z']) }), opt: z.string().optional() });
    const r = lcg(1); const objs = [];
    for (let i = 0; i < 100000; i++) objs.push({ id: i, name: 'user' + i, email: `u${i}@example.com`, tags: ['a', 'b', 'c'].slice(0, 1 + (i % 3)), nested: { a: r(), b: i % 2 === 0, c: 'xyz'[i % 3] }, opt: i % 5 === 0 ? undefined : 'o' });
    for (let i = 0; i < 100000; i += 100) objs[i] = { ...objs[i], email: 'not-an-email' };
    return { schema, objs };
  },
  run(s) { let okCount = 0; for (const o of s.objs) if (s.schema.safeParse(o).success) okCount++; if (okCount !== 99000) throw new Error('zod count ' + okCount); return okCount; },
};
// Tight loop that only touches local variables.
exports.numericLocals = {
  setup() { return {}; },
  run() {
    let acc = 0;
    for (let py = 0; py < 300; py++) for (let px = 0; px < 400; px++) {
      const cx = (px / 400) * 3.5 - 2.5, cy = (py / 300) * 2 - 1;
      let x = 0, y = 0, i = 0;
      while (x * x + y * y < 4 && i < 200) { const t = x * x - y * y + cx; y = 2 * x * y + cy; x = t; i++; }
      acc += i;
    }
    return acc;
  },
};
// Same idea but every iteration references free global names (Math, Number, Array),
// which inside a Compartment resolve through SES's `with` scope chain.
exports.numericGlobals = {
  setup() { return {}; },
  run() {
    let acc = 0;
    for (let i = 0; i < 6000000; i++) {
      acc = (acc + Math.imul(i, 31) + Math.floor(Math.sqrt(i)) + (Number.isInteger(acc) ? 1 : 0)) | 0;
      if (Array.isArray(acc)) acc = 0;
    }
    return acc;
  },
};
exports.json = {
  setup() {
    const r = lcg(7); const rows = [];
    for (let i = 0; i < 60000; i++) rows.push({ id: i, name: 'row-' + i, score: r() * 1000, flags: [i % 2 === 0, i % 3 === 0], meta: { tag: 't' + (i % 97), text: 'lorem ipsum dolor sit amet '.repeat(1 + (i % 3)) } });
    return { rows };
  },
  run(s) { let n = 0; for (let k = 0; k < 3; k++) { const text = JSON.stringify(s.rows); n += JSON.parse(text).length + text.length; } return n; },
};
exports.lodash = {
  setup() {
    const _ = require('lodash'); const r = lcg(3); const rows = [];
    for (let i = 0; i < 150000; i++) rows.push({ id: i, team: 'team' + Math.floor(r() * 200), score: Math.floor(r() * 1000), tags: ['a' + (i % 7), 'b' + (i % 11)], user: { name: 'u' + (i % 5000), active: r() > 0.3 } });
    return { _, rows };
  },
  run(s) {
    const _ = s._;
    const out = _.chain(s.rows).filter('user.active').groupBy('team').mapValues((g) => ({ n: g.length, mean: _.meanBy(g, 'score'), top: _.take(_.orderBy(g, ['score', 'id'], ['desc', 'asc']), 3).map((x) => _.pick(x, ['id', 'score'])), tags: _.uniq(_.flatMap(g, 'tags')).length })).toPairs().sortBy(([, v]) => -v.mean).take(50).fromPairs().value();
    const clone = _.cloneDeep(s.rows.slice(0, 20000));
    return _.size(out) + _.sumBy(clone, 'score') + _.keys(_.countBy(s.rows, (x) => x.user.name)).length;
  },
};
exports.acorn = {
  setup() { return { acorn: require('acorn'), src: fs.readFileSync('/node_modules/lodash/lodash.js', 'utf8') }; },
  run(s) { let n = 0; for (let i = 0; i < 4; i++) n += s.acorn.parse(s.src, { ecmaVersion: 2022 }).body.length; return n; },
};
