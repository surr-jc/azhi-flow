import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where Azhi keeps tools it provisions itself: AZHI_TOOLS_DIR, else ~/.azhi/tools (set it to another drive on a small disk). */
export function toolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AZHI_TOOLS_DIR ?? join(env.AZHI_HOME ?? join(homedir(), '.azhi'), 'tools');
}

function which(cmd: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env });
    return out.split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * ripgrep (`rg`): AZHI_RG_BIN, the tools folder, or PATH. OpenCode's grep and glob tools run it; it looks on PATH,
 * then in its own per-step data folder, and otherwise downloads a copy on every step (the folder is new each time).
 */
export function ripgrepBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AZHI_RG_BIN) return existsSync(env.AZHI_RG_BIN) ? env.AZHI_RG_BIN : undefined;
  const local = join(toolsDir(env), 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
  return existsSync(local) ? local : which('rg', env);
}

export function ripgrepVersion(path: string): string | undefined {
  try {
    return /ripgrep\s+(\S+)/.exec(execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }))?.[1];
  } catch {
    return undefined;
  }
}

/** PATH for an OpenCode step: the folder holding rg first when rg is not already on PATH, so OpenCode never downloads it. */
export function pathWithRipgrep(path: string | undefined, rg: string | undefined): string | undefined {
  if (!rg) return path;
  const dir = dirname(rg);
  const parts = (path ?? '').split(delimiter);
  return parts.includes(dir) ? path : [dir, ...parts.filter(Boolean)].join(delimiter);
}

/** Install commands per platform, for `azhi setup` and doctor messages. */
export function ripgrepInstallHint(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'darwin') return 'brew install ripgrep';
  if (platform === 'win32') return `winget install BurntSushi.ripgrep.MSVC, then open a new terminal; or put rg.exe in ${join(toolsDir(env), 'bin')} or set AZHI_RG_BIN`;
  const wsl = Boolean(env.WSL_DISTRO_NAME);
  return `sudo apt install ripgrep (Debian, Ubuntu${wsl ? ', WSL' : ''}) or sudo dnf install ripgrep (Fedora, RHEL); without root, download the release from github.com/BurntSushi/ripgrep and put rg in ${join(toolsDir(env), 'bin')} or set AZHI_RG_BIN`;
}

/** Added to an OpenCode step's prompt when token saving is on: file reads stack up across turns, searches do not. */
export const SEARCH_FIRST_GUIDANCE = `Reading rules: find things with grep and glob first, then read only the lines you need (use offset and limit). Do not read a whole large file, and do not read the same file twice; keep the facts you need in your notes instead.`;

/** Whether token saving applies to a step: the profile's choice, else AZHI_OPENCODE_TOKEN_SAVING (on or off; default off). */
export function tokenSavingOn(profileSetting: 'on' | 'off' | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return (profileSetting ?? (env.AZHI_OPENCODE_TOKEN_SAVING === 'on' ? 'on' : 'off')) === 'on';
}

/**
 * DCP (dynamic context pruning, github.com/Opencode-DCP/opencode-dynamic-context-pruning), an OpenCode plugin.
 * It is AGPL-3.0-or-later, so Azhi does not ship it: `azhi setup --dcp` installs this exact version from npm into the tools folder.
 */
export const DCP_PACKAGE = '@tarquinen/opencode-dcp';
export const DCP_VERSION = '3.2.0';

export function dcpDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolsDir(env), 'dcp');
}

/**
 * The installed plugin when it is the pinned version: its entry file (OpenCode 1.x loads that) and its package folder
 * (OpenCode 2 loads only a folder, and DCP's package carries its own OpenCode 2 build).
 */
export function dcpPlugin(env: NodeJS.ProcessEnv = process.env): { version: string; path: string; dir: string } | undefined {
  const root = join(dcpDir(env), 'node_modules', ...DCP_PACKAGE.split('/'));
  try {
    const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version;
    const entry = join(root, 'dist', 'index.js');
    return version === DCP_VERSION && existsSync(entry) ? { version, path: entry, dir: root } : undefined;
  } catch {
    return undefined;
  }
}

export function installDcp(env: NodeJS.ProcessEnv = process.env): void {
  const dir = dcpDir(env);
  // Scripts off: nothing from the package's dependency tree runs at install time.
  execFileSync('npm', ['install', '--prefix', dir, `${DCP_PACKAGE}@${DCP_VERSION}`, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { stdio: 'inherit', shell: process.platform === 'win32', timeout: 600_000 });
}

/**
 * OpenCode 2 (npm @opencode/cli), used when a worker sets AZHI_OPENCODE_MAJOR=2. Not an npm dependency of Azhi (each
 * platform binary is about 250 MB): `azhi setup --opencode2` installs this exact version into the tools folder.
 */
export const OPENCODE2_PACKAGE = '@opencode/cli';
export const OPENCODE2_VERSION = '2.1.4';

export function opencode2Dir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolsDir(env), 'opencode2');
}

/**
 * AZHI_OPENCODE2_BIN, the copy in the tools folder, or `opencode2` on PATH (the package's second command name).
 * The install runs without scripts, so the program is taken from the platform package npm put next to it; the
 * baseline build is the fallback for CPUs without AVX2 (AZHI_OPENCODE2_BIN picks one by hand).
 */
export function opencode2Binary(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (env.AZHI_OPENCODE2_BIN) return env.AZHI_OPENCODE2_BIN;
  const os = platform === 'win32' ? 'windows' : platform;
  const exe = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const modules = join(opencode2Dir(env), 'node_modules', '@opencode');
  const candidates = [join(modules, 'cli', 'bin', exe), ...['', '-musl', '-baseline', '-baseline-musl'].map((v) => join(modules, `cli-${os}-${arch}${v}`, 'bin', exe))];
  return candidates.find((p) => existsSync(p)) ?? which('opencode2', env);
}

export function installOpencode2(env: NodeJS.ProcessEnv = process.env): void {
  // Scripts off, like DCP: the platform binary arrives as an optional dependency, so nothing needs to run at install.
  execFileSync('npm', ['install', '--prefix', opencode2Dir(env), `${OPENCODE2_PACKAGE}@${OPENCODE2_VERSION}`, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { stdio: 'inherit', shell: process.platform === 'win32', timeout: 900_000 });
}

/**
 * The transcript note that tells the run page DCP is loaded for a step. The fixed id is how the page knows that a
 * bare `compress` tool call is DCP pruning the context (gateway and package MCP tools are always prefixed).
 */
export function dcpNote(version: string, limits: { minContextLimit?: number | string; maxContextLimit?: number | string } = {}): { id: 'dcp'; kind: 'note'; text: string; at: number } {
  const n = (v: number | string | undefined, dflt: string) => (v === undefined ? dflt : typeof v === 'number' ? `${v.toLocaleString('en-US')} tokens` : `${v} of the context window`);
  return {
    id: 'dcp',
    kind: 'note',
    text: `DCP ${version} context pruning is on for this step. When the model calls DCP's compress tool, older messages and OpenCode tool output are replaced by a summary, so later model calls send fewer tokens; Azhi gateway tool results are always kept. DCP asks the model to compress from ${n(limits.minContextLimit, '50,000 tokens')} of context, and insists past ${n(limits.maxContextLimit, '100,000 tokens')}.`,
    at: Date.now(),
  };
}

/**
 * Tools DCP may never prune: the Azhi gateway, bridged as `azhi_*` (submit_output included). Their results carry the
 * excerpt ids the model cites and the ledger records, so DCP works only on OpenCode's own tools. A protected result
 * is kept word for word inside a compressed block, and skipped by deduplication and error purging. DCP adds these
 * to its own defaults (task, skill, todo tools).
 */
export const DCP_PROTECTED_TOOLS = ['azhi_*'];

/**
 * DCP's own config for a step. In 3.2.0 its deduplication and error-purging run only when the model calls its
 * `compress` tool, so that tool is allowed; update checks, notifications and slash commands are off.
 */
export const DCP_CONFIG = {
  enabled: true,
  autoUpdate: false,
  pruneNotification: 'off',
  commands: { enabled: false, protectedTools: DCP_PROTECTED_TOOLS },
  compress: { permission: 'allow', showCompression: false, protectedTools: DCP_PROTECTED_TOOLS },
  strategies: { deduplication: { enabled: true, protectedTools: DCP_PROTECTED_TOOLS }, purgeErrors: { enabled: true, turns: 4, protectedTools: DCP_PROTECTED_TOOLS } },
};

/** A DCP context limit: a token count, or a share of the model's context window ("40%"). */
type DcpLimit = number | `${number}%`;

function dcpLimit(name: string, value: string | undefined): DcpLimit | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(v);
  if (pct && Number(pct[1]) > 0 && Number(pct[1]) <= 100) return `${Number(pct[1])}%`;
  if (/^\d+$/.test(v) && Number(v) > 0) return Number(v);
  throw new Error(`${name} must be a token count (e.g. 30000) or a share of the model's context window (e.g. 40%), not '${value}'`);
}

/**
 * When DCP asks the model to compress: from AZHI_DCP_MIN_CONTEXT it starts nudging, past AZHI_DCP_MAX_CONTEXT it
 * insists. Unset, DCP's own defaults apply (50000 and 100000 tokens in 3.2.0), so short steps never compress.
 */
export function dcpLimits(env: NodeJS.ProcessEnv = process.env): { minContextLimit?: DcpLimit; maxContextLimit?: DcpLimit } {
  const min = dcpLimit('AZHI_DCP_MIN_CONTEXT', env.AZHI_DCP_MIN_CONTEXT);
  const max = dcpLimit('AZHI_DCP_MAX_CONTEXT', env.AZHI_DCP_MAX_CONTEXT);
  if (typeof min === 'number' && typeof max === 'number' && min > max) throw new Error(`AZHI_DCP_MIN_CONTEXT (${min}) must not be above AZHI_DCP_MAX_CONTEXT (${max})`);
  if (typeof min === 'string' && typeof max === 'string' && parseFloat(min) > parseFloat(max)) throw new Error(`AZHI_DCP_MIN_CONTEXT (${min}) must not be above AZHI_DCP_MAX_CONTEXT (${max})`);
  return { ...(min !== undefined ? { minContextLimit: min } : {}), ...(max !== undefined ? { maxContextLimit: max } : {}) };
}

/** DCP's config for a step on this worker: DCP_CONFIG with the worker's context limits. */
export function dcpConfig(env: NodeJS.ProcessEnv = process.env) {
  return { ...DCP_CONFIG, compress: { ...DCP_CONFIG.compress, ...dcpLimits(env) } };
}

/**
 * DCP also reads `.opencode/dcp.json(c)`, and with experimental.customPrompts its prompt overrides, from the nearest
 * `.opencode` folder at or above the directory OpenCode hands it, and applies that last, over DCP_CONFIG. In a
 * workspace step that directory is a checkout of an untrusted repository, and DCP 3.2.0 has no setting to skip it.
 * So a step loads DCP through this wrapper, which hands DCP a folder of the step's own: its empty `.opencode` ends
 * DCP's search there, before the checkout or any parent folder. DCP uses the directory only to find its config and
 * prompts, and to shorten paths in its slash commands, which are off.
 * OpenCode 1.x loads the wrapper's file (`path`), OpenCode 2 its package folder (`dir`).
 */
export function writeDcpWrapper(root: string, dcp: { path: string }): { path: string; dir: string } {
  const dir = join(root, 'dcp-plugin');
  const directory = join(dir, 'directory');
  mkdirSync(join(directory, '.opencode'), { recursive: true });
  // OpenCode 2 loads a plugin folder's `server.js` (DCP's own package has one), so the wrapper is that file.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'azhi-dcp', private: true, type: 'module', main: 'server.js', exports: { '.': './server.js', './server': './server.js' } }));
  writeFileSync(
    join(dir, 'server.js'),
    [
      `import dcp from ${JSON.stringify(pathToFileURL(dcp.path).href)};`,
      `const directory = ${JSON.stringify(directory)};`,
      `const swap = (ctx, key, value) => new Proxy(ctx, { get: (target, k) => (k === key ? value : Reflect.get(target, k)) });`,
      `// OpenCode 1.x hands the server plugin ctx.directory; OpenCode 2 hands setup ctx.location.directory.`,
      `export default {`,
      `  ...dcp,`,
      `  server: (ctx, ...rest) => dcp.server(swap(ctx, 'directory', directory), ...rest),`,
      `  setup: (ctx, ...rest) => dcp.setup(swap(ctx, 'location', { ...ctx.location, directory }), ...rest),`,
      `};`,
      '',
    ].join('\n'),
  );
  return { path: join(dir, 'server.js'), dir };
}
