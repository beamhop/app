// Step 7: find synchronous child-process (and other blocking) call sites in the installed harness entry bundles.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGETS = {
  pi: ['harnesses/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle'],
  gemini: ['harnesses/gemini/node_modules/@google/gemini-cli/bundle'],
  claude: ['harnesses/claude-js/node_modules/@anthropic-ai/claude-code/cli.js'],
};
const PATTERNS = { execSync: /\bexecSync\s*\(/g, execFileSync: /\bexecFileSync\s*\(/g, spawnSync: /\bspawnSync\s*\(/g, 'Atomics.wait': /Atomics\.wait\s*\(/g, 'readSync(stdin)': /readSync\s*\(\s*(0|process\.stdin\.fd)\b/g, receiveMessageOnPort: /receiveMessageOnPort\s*\(/g };
const out = {};
for (const [name, targets] of Object.entries(TARGETS)) {
  const files = [];
  const walk = (p) => { if (!fs.existsSync(p)) return; const st = fs.statSync(p); if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e)); else if (/\.(c|m)?js$/.test(p)) files.push(p); };
  for (const t of targets) walk(path.join(root, t));
  const res = { filesScanned: files.length, counts: {}, samples: {} };
  const seen = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const [label, re] of Object.entries(PATTERNS)) {
      for (const m of src.matchAll(re)) {
        const ctx = src.slice(m.index, m.index + 110).replace(/\s+/g, ' ');
        const key = label + ctx.slice(0, 70);
        if (seen.has(key)) continue; // identical call sites duplicated across chunk generations
        seen.add(key);
        res.counts[label] = (res.counts[label] || 0) + 1;
        (res.samples[label] ||= []).push(ctx);
      }
    }
  }
  out[name] = res;
}
const file = path.join(root, 'dist/sync-scan.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 1));
if (process.argv.includes('--print')) for (const [n, r] of Object.entries(out)) { console.log('==', n, r.filesScanned, JSON.stringify(r.counts)); for (const [l, s] of Object.entries(r.samples)) for (const x of s) console.log('  ', l, '|', x); }
