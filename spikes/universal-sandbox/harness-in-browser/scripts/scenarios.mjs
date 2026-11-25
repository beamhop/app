// Worker run configurations shared by the dev driver and the spike runner.
import { FILE_NAME } from '../servers/mock-model.mjs';

const PROMPT = `Write ${FILE_NAME} then read it back with bash.`;
export const ENTRY = {
  pi: '/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  gemini: '/opt/gemini/node_modules/@google/gemini-cli/bundle/gemini.js',
};
export function scenario(harness, { mockPort, proxyPort, relayPort, variant = 'plain', netMode = 'bridge', args = null, timeoutMs = 60000, lockdownOptions, sesEvaluateOptions }) {
  const mock = `http://127.0.0.1:${mockPort}`;
  const base = {
    variant, timeoutMs, lockdownOptions, sesEvaluateOptions,
    images: [{ url: `${harness}.img` }],
    cwd: '/work',
    net: { mode: netMode, proxyUrl: `http://127.0.0.1:${proxyPort}`, relayUrl: `ws://127.0.0.1:${relayPort}` },
    readBack: ['/work/' + FILE_NAME], listDirs: ['/work'],
  };
  if (harness === 'pi') return {
    ...base, entry: ENTRY.pi,
    args: args || ['--mode', 'json', '--model', 'mock/mock-model', '--no-session', '--offline', PROMPT],
    env: { HOME: '/home/user', PATH: '/usr/local/bin:/usr/bin:/bin', USER: 'user', SHELL: '/bin/bash', LANG: 'C.UTF-8', TERM: 'dumb', PI_OFFLINE: '1' },
    files: { '/home/user/.pi/agent/models.json': JSON.stringify({ providers: { mock: { baseUrl: mock + '/v1', api: 'openai-completions', apiKey: 'mock-key', models: [{ id: 'mock-model' }] } } }) },
  };
  if (harness === 'gemini') return {
    ...base, entry: ENTRY.gemini,
    args: args || ['-p', PROMPT, '--yolo', '--output-format', 'json'],
    env: { HOME: '/home/user', PATH: '/usr/local/bin:/usr/bin:/bin', USER: 'user', SHELL: '/bin/bash', LANG: 'C.UTF-8', TERM: 'dumb', GEMINI_API_KEY: 'mock-key', GOOGLE_GEMINI_BASE_URL: mock, GEMINI_CLI_NO_RELAUNCH: 'true', NO_COLOR: '1', GEMINI_TELEMETRY_ENABLED: 'false' },
    files: { '/home/user/.gemini/settings.json': JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, general: { disableAutoUpdate: true, disableUpdateNag: true }, privacy: { usageStatisticsEnabled: false }, telemetry: { enabled: false } }) },
  };
  throw new Error('unknown harness ' + harness);
}
