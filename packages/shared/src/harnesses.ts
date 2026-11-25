// The coding-agent harnesses Beamhop can run, wherever they run: in a Linux machine in the tab
// (unkernel) or on the owner's computer (the bridge). One list, so both places offer the same
// agents and start them the same way: as an ACP agent on stdio.

export type HarnessId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'fx' | 'custom'

export interface Harness {
  id: HarnessId
  label: string
  /** One line for the picker. */
  blurb: string
  /** The ACP agent: command and arguments. Runs from the harness's working directory. */
  acp: { cmd: string; args: string[] }
  /**
   * Shell steps (Debian, run as root, one at a time) that install the harness in the browser
   * machine. Idempotent. `node`, `npm`, `claude`, `opencode` and `fx` are unkernel launchers that
   * download the official Linux arm64 build on first use.
   */
  machineSetup: string[]
  /** The ACP agent as the bridge starts it on the owner's computer, when it differs from `acp`. */
  bridgeAcp?: { cmd: string; args: string[] }
  /** What to tell a bridge user who doesn't have it installed. */
  bridgeInstall: string
  /** An API key the harness reads from the environment, as an alternative to its own sign-in. */
  keyEnv?: { name: string; label: string; placeholder: string }
  /** Command to run in the machine's terminal to sign in with the harness's own account. */
  login?: string
}

// The node launcher installs Node on first use; npm's global packages go to /usr/local, which is on PATH.
const npmGlobal = (pkgs: string) => ['node --version', `npm i -g --prefix /usr/local --no-audit --no-fund --loglevel=error ${pkgs}`]

export const HARNESSES: Record<HarnessId, Harness> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    blurb: 'Anthropic’s coding agent. Sign in with a Claude plan or use an API key.',
    acp: { cmd: 'claude-agent-acp', args: [] },
    bridgeAcp: { cmd: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
    machineSetup: ['claude --version', ...npmGlobal('@agentclientprotocol/claude-agent-acp')],
    bridgeInstall: 'npm i -g @anthropic-ai/claude-code, then run claude once to sign in',
    keyEnv: { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', placeholder: 'sk-ant-…' },
    login: 'claude /login',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    blurb: 'OpenAI’s coding agent. Sign in with ChatGPT or use an API key.',
    acp: { cmd: 'codex-acp', args: [] },
    bridgeAcp: { cmd: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
    machineSetup: npmGlobal('@openai/codex @zed-industries/codex-acp'),
    bridgeInstall: 'npm i -g @openai/codex, then codex login',
    keyEnv: { name: 'OPENAI_API_KEY', label: 'OpenAI API key', placeholder: 'sk-…' },
    login: 'codex login --device-auth',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    blurb: 'Google’s coding agent. Sign in with Google or use a Gemini API key.',
    acp: { cmd: 'gemini', args: ['--experimental-acp'] },
    machineSetup: npmGlobal('@google/gemini-cli'),
    bridgeInstall: 'npm i -g @google/gemini-cli, then run gemini once to sign in',
    keyEnv: { name: 'GEMINI_API_KEY', label: 'Gemini API key', placeholder: 'AIza…' },
    login: 'gemini',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    blurb: 'Open-source coding agent for any model provider.',
    acp: { cmd: 'opencode', args: ['acp'] },
    machineSetup: ['opencode --version'],
    bridgeInstall: 'npm i -g opencode-ai, then opencode auth login',
    keyEnv: { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', placeholder: 'sk-or-…' },
    login: 'opencode auth login',
  },
  fx: {
    id: 'fx',
    label: 'fx',
    blurb: 'Vercel’s small, fast agent (native build).',
    acp: { cmd: 'fx', args: ['acp'] },
    machineSetup: ['fx --version'],
    bridgeInstall: 'curl -fsSL https://fx.sh/setup.sh | bash, then fx login',
    login: 'fx login',
  },
  custom: {
    id: 'custom',
    label: 'Custom ACP agent',
    blurb: 'Any program that speaks the Agent Client Protocol on stdio.',
    acp: { cmd: 'sh', args: ['/root/.beamhop/custom-agent'] },
    machineSetup: [],
    bridgeInstall: 'pass --acp "<your command>" to the bridge',
  },
}

/** The harnesses offered in pickers, in display order. */
export const HARNESS_ORDER: HarnessId[] = ['claude', 'codex', 'gemini', 'opencode', 'fx', 'custom']

/** The bridge command for a harness. */
export function bridgeAgentFlag(id: HarnessId, customCommand = '<command>') {
  return id === 'custom' ? `--acp "${customCommand.replace(/"/g, '\\"')}"` : `--agent ${id}`
}
