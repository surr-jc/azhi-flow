import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ripgrepBinary, ripgrepVersion } from './tools.js';

export interface WorkerCapabilities {
  platform: NodeJS.Platform;
  arch: string;
  runtimes: { python?: { version: string; via: 'uv' | 'python3' | 'python' | 'py' }; bun?: { version: string }; opencode?: { version: string; path: string }; ripgrep?: { version: string; path: string }; 'claude-agent-sdk'?: { version: string }; codex?: { version: string; path: string }; git?: { version: string } };
  limits: { memory: boolean; time: boolean };
  executors: string[];
}

function tryRun(cmd: string, args: string[]): string | undefined {
  try {
    // Probing must never trigger a Python download.
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, env: { ...process.env, UV_PYTHON_DOWNLOADS: 'never' } }).trim();
  } catch {
    return undefined;
  }
}

/** Probes what this host can run. Advertised to the server and used by the run plan. */
export function detectCapabilities(pythonVersion = process.env.AZHI_PYTHON_VERSION ?? '3.12'): WorkerCapabilities {
  const uv = tryRun('uv', ['--version']);
  let python: WorkerCapabilities['runtimes']['python'];
  if (uv) {
    const v = tryRun('uv', ['run', '--no-project', '--python', pythonVersion, 'python', '-c', 'import platform;print(platform.python_version())']);
    if (v) python = { version: v, via: 'uv' };
  }
  // Windows installs Python as `python` or the `py` launcher, not `python3`.
  const plain = process.platform === 'win32' ? (['python', 'py'] as const) : ([] as const);
  for (const via of ['python3', ...plain] as const) {
    if (python) break;
    const v = tryRun(via, [...(via === 'py' ? ['-3'] : []), '-c', 'import platform;print(platform.python_version())']);
    if (v) python = { version: v, via };
  }
  const bun = tryRun('bun', ['--version']);
  // Agent steps with a workspace clone with git.
  const git = tryRun('git', ['--version'])?.replace(/^git version\s+/, '');
  const ocPath = opencodeBinary();
  const oc = ocPath ? tryRun(ocPath, ['--version']) : undefined;
  const rgPath = oc ? ripgrepBinary() : undefined;
  const rg = rgPath ? ripgrepVersion(rgPath) : undefined;
  const sdk = claudeAgentSdkVersion();
  // Experimental: see the codex entry in src/executors/capabilities.ts. Off unless asked for.
  const codexPath = process.env.AZHI_EXPERIMENTAL_CODEX === '1' ? codexBinary() : undefined;
  const codex = codexPath ? tryRun(codexPath, ['--version'])?.replace(/^codex(-cli)?\s+/i, '') : undefined;
  return {
    platform: process.platform,
    arch: process.arch,
    runtimes: {
      ...(python ? { python } : {}),
      ...(bun ? { bun: { version: bun } } : {}),
      ...(oc && ocPath ? { opencode: { version: oc, path: ocPath } } : {}),
      ...(rg && rgPath ? { ripgrep: { version: rg, path: rgPath } } : {}),
      ...(sdk ? { 'claude-agent-sdk': { version: sdk } } : {}),
      ...(codex && codexPath ? { codex: { version: codex, path: codexPath } } : {}),
      ...(git ? { git: { version: git } } : {}),
    },
    limits: { memory: process.platform === 'linux' && Boolean(tryRun('prlimit', ['--version'])), time: true },
    executors: ['script', ...(oc ? ['opencode'] : []), ...(sdk ? ['claude-agent-sdk'] : []), ...(codex ? ['codex'] : [])],
  };
}

/** AZHI_OPENCODE_BIN, the pinned copy in node_modules, or `opencode` on PATH. */
export function opencodeBinary(): string | undefined {
  if (process.env.AZHI_OPENCODE_BIN) return process.env.AZHI_OPENCODE_BIN;
  const win = process.platform === 'win32';
  const pinned = fileURLToPath(new URL(`../../node_modules/.bin/opencode${win ? '.cmd' : ''}`, import.meta.url));
  if (existsSync(pinned)) return pinned;
  return tryRun(win ? 'where' : 'which', ['opencode'])?.split(/\r?\n/)[0] || undefined;
}

/**
 * The installed Claude Agent SDK, when it and its native runtime for this platform are present
 * (it is an optional dependency). `AZHI_CLAUDE_CODE_BIN` points at another Claude Code binary.
 */
export function claudeAgentSdkVersion(): string | undefined {
  try {
    const modules = (name: string) => fileURLToPath(new URL(`../../node_modules/${name}`, import.meta.url));
    const version = (JSON.parse(readFileSync(modules('@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')) as { version: string }).version;
    if (process.env.AZHI_CLAUDE_CODE_BIN) return existsSync(process.env.AZHI_CLAUDE_CODE_BIN) ? version : undefined;
    const os = process.platform;
    const native = [`${os}-${process.arch}`, `${os}-${process.arch}-musl`].some((n) => existsSync(modules(`@anthropic-ai/claude-agent-sdk-${n}`)));
    return native ? version : undefined;
  } catch {
    return undefined;
  }
}

/** AZHI_CODEX_BIN, the pinned copy in node_modules, or `codex` on PATH. */
export function codexBinary(): string | undefined {
  if (process.env.AZHI_CODEX_BIN) return process.env.AZHI_CODEX_BIN;
  const win = process.platform === 'win32';
  const pinned = fileURLToPath(new URL(`../../node_modules/.bin/codex${win ? '.cmd' : ''}`, import.meta.url));
  if (existsSync(pinned)) return pinned;
  return tryRun(win ? 'where' : 'which', ['codex'])?.split(/\r?\n/)[0] || undefined;
}
