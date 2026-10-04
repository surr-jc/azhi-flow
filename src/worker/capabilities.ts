import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface WorkerCapabilities {
  platform: NodeJS.Platform;
  arch: string;
  runtimes: { python?: { version: string; via: 'uv' | 'python3' }; bun?: { version: string }; opencode?: { version: string; path: string } };
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
  if (!python) {
    const v = tryRun('python3', ['-c', 'import platform;print(platform.python_version())']);
    if (v) python = { version: v, via: 'python3' };
  }
  const bun = tryRun('bun', ['--version']);
  const ocPath = opencodeBinary();
  const oc = ocPath ? tryRun(ocPath, ['--version']) : undefined;
  return {
    platform: process.platform,
    arch: process.arch,
    runtimes: { ...(python ? { python } : {}), ...(bun ? { bun: { version: bun } } : {}), ...(oc && ocPath ? { opencode: { version: oc, path: ocPath } } : {}) },
    limits: { memory: process.platform === 'linux' && Boolean(tryRun('prlimit', ['--version'])), time: true },
    executors: ['script', ...(oc ? ['opencode'] : [])],
  };
}

/** AZHI_OPENCODE_BIN, the pinned copy in node_modules, or `opencode` on PATH. */
export function opencodeBinary(): string | undefined {
  if (process.env.AZHI_OPENCODE_BIN) return process.env.AZHI_OPENCODE_BIN;
  const pinned = fileURLToPath(new URL('../../node_modules/.bin/opencode', import.meta.url));
  if (existsSync(pinned)) return pinned;
  return tryRun('which', ['opencode']) || undefined;
}
