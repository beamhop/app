// Plain `npm install` of each harness into harnesses/<name>/ (git-ignored). Nothing is modified afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WANT = {
  pi: ['@earendil-works/pi-coding-agent@1.6.0'],
  gemini: ['@google/gemini-cli@0.71.1'],
  claude: ['@anthropic-ai/claude-code@2.1.332'], // native launcher; installed only to document its packaging
  'claude-js': ['@anthropic-ai/claude-code@2.1.112', '--ignore-scripts'], // last release with a JS entry (cli.js)
};
for (const [name, args] of Object.entries(WANT)) {
  const dir = path.join(root, 'harnesses', name);
  if (fs.existsSync(path.join(dir, 'node_modules'))) continue;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'harness-' + name, private: true }));
  console.error(`[install] ${name}: npm install ${args.join(' ')}`);
  execSync(`npm install --no-audit --no-fund ${args.join(' ')}`, { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
}
