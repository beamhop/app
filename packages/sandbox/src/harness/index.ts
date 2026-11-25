// Harness definitions: what the app (and the image builder) needs to know about each coding-agent CLI.
// Declarative on purpose. Everything specific to one harness lives here: its package, where its image is
// mounted, the command that starts it, and the environment and files that make it run headless. The Node
// layer knows none of this.
//
// Claude Code is deliberately absent: its current releases are native executables (decided: treated as a
// native harness, run through the desktop bridge).

/** A model endpoint for a headless run. With the e2e tests this is a local mock; in the app it is the user's provider. */
export interface ModelEndpoint {
  /** Base URL of the provider API, e.g. "https://api.example.com/v1". */
  baseUrl: string
  apiKey: string
  /** Model id as the provider knows it. */
  model: string
}

export interface HeadlessOptions {
  prompt: string
  /** Omit to use whatever the harness is already configured with inside the machine (its own login). */
  endpoint?: ModelEndpoint
  home?: string
}

/** Everything needed to start one run: pass `argv`, `env`, `cwd` to spawn after writing `files`. */
export interface HarnessRun {
  argv: string[]
  env: Record<string, string>
  /** Files to write before spawning (absolute path -> content). */
  files: Record<string, string>
  stdin: 'pipe' | 'none'
}

export interface HarnessDefinition {
  name: string
  /** npm spec the image is built from. Pinned: an upgrade is a deliberate change, each one can touch a new Node API. */
  npmSpec: string
  /** Image name; the file is "<image>-<hash>.bhi" (see images.json next to the images). */
  image: string
  /** Where the app mounts the image. */
  mountAt: string
  /** Command on PATH after mounting (the package's "bin"). */
  command: string
  /** The script behind `command`, relative to the image root. */
  entry: string
  /** Extra directories (relative to the image root) whose ES modules are precompiled although the entry does not import them statically. */
  precompileDirs?: string[]
  /** Regular expressions (source text) for files reached through computed `import()` that the builder cannot see. */
  precompileExtra?: string[]
  /** Environment the harness needs in every run, headless or not. */
  env: Record<string, string>
  headless(options: HeadlessOptions): HarnessRun
}

const pi: HarnessDefinition = {
  name: 'pi',
  npmSpec: '@earendil-works/pi-coding-agent@1.6.0',
  image: 'pi',
  mountAt: '/opt/pi',
  command: 'pi',
  entry: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  // The bundle is split into chunks that are loaded with computed import(); precompile all of them.
  precompileDirs: ['node_modules/@earendil-works/pi-coding-agent/dist/bundle'],
  env: { PI_OFFLINE: '1' },
  headless({ prompt, endpoint, home = '/home/user' }) {
    const files: Record<string, string> = {}
    const args = ['--mode', 'json', '--no-session', '--offline']
    if (endpoint) {
      // A custom provider entry; pi addresses it as "<provider>/<model>".
      files[`${home}/.pi/agent/models.json`] = JSON.stringify({
        providers: { beamhop: { baseUrl: endpoint.baseUrl, api: 'openai-completions', apiKey: endpoint.apiKey, models: [{ id: endpoint.model }] } },
      })
      args.push('--model', `beamhop/${endpoint.model}`)
    }
    return { argv: ['pi', ...args, prompt], env: { ...pi.env }, files, stdin: 'none' }
  },
}

const gemini: HarnessDefinition = {
  name: 'gemini',
  npmSpec: '@google/gemini-cli@0.71.1',
  image: 'gemini',
  mountAt: '/opt/gemini',
  command: 'gemini',
  entry: 'node_modules/@google/gemini-cli/bundle/gemini.js',
  precompileExtra: ['/bundle/(tree-sitter[^/]*|liteRtServerManager-[A-Z0-9]+)\\.js$'],
  env: {
    // The launcher re-spawns itself with an IPC channel to set V8 heap flags; a Node child with IPC does not exist here.
    GEMINI_CLI_NO_RELAUNCH: 'true',
    // Headless runs refuse an untrusted folder; native runs need this too.
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
    NO_COLOR: '1',
  },
  headless({ prompt, endpoint, home = '/home/user' }) {
    const env: Record<string, string> = { ...gemini.env }
    const settings: Record<string, unknown> = { general: { disableAutoUpdate: true, disableUpdateNag: true }, privacy: { usageStatisticsEnabled: false }, telemetry: { enabled: false } }
    if (endpoint) {
      env.GEMINI_API_KEY = endpoint.apiKey
      env.GOOGLE_GEMINI_BASE_URL = endpoint.baseUrl
      settings.security = { auth: { selectedType: 'gemini-api-key' } }
    }
    const args = ['-p', prompt, '--yolo', '--output-format', 'json']
    if (endpoint?.model) args.push('--model', endpoint.model)
    return { argv: ['gemini', ...args], env, files: { [`${home}/.gemini/settings.json`]: JSON.stringify(settings) }, stdin: 'none' }
  },
}

export const harnesses: Record<string, HarnessDefinition> = { pi, gemini }

export function getHarness(name: string): HarnessDefinition {
  const h = harnesses[name]
  if (!h) throw new Error(`unknown harness "${name}" (known: ${Object.keys(harnesses).join(', ')})`)
  return h
}
