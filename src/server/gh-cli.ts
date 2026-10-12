import { execFile } from 'node:child_process';
import { AzhiError, ErrorClass } from '../lib/errors.js';

/**
 * A secret can point at the GitHub CLI's login instead of holding a token. Its stored value is
 * `azhi:gh-cli` (github.com) or `azhi:gh-cli:HOST` (an Enterprise server), and the token itself is asked of
 * `gh auth token` on the machine the server runs on each time a step needs it. The token is never stored,
 * logged or shown, so signing out of `gh` (or `gh auth login` again) takes effect at once.
 *
 * The token acts as the person who signed in to `gh`, with the scopes of that sign-in. It is broader than a
 * fine-grained token for one repository, so the tools' own repository lists (`repos`) are what keep a
 * workflow to the repositories it names.
 */
export const GH_CLI_POINTER = 'azhi:gh-cli';
const CACHE_MS = 60_000;

export interface GhCliPointer {
  host: string;
}

/** The pointer a secret value stands for, or undefined when the value is an ordinary token. */
export function parseGhCliPointer(value: string): GhCliPointer | undefined {
  const v = value.trim();
  if (v === GH_CLI_POINTER) return { host: 'github.com' };
  if (!v.startsWith(`${GH_CLI_POINTER}:`)) return undefined;
  const host = v.slice(GH_CLI_POINTER.length + 1).trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) ? { host } : undefined;
}

export const ghCliPointer = (host = 'github.com') => (host.toLowerCase() === 'github.com' ? GH_CLI_POINTER : `${GH_CLI_POINTER}:${host.toLowerCase()}`);

/** Runs `gh` with these arguments and returns its output; replaced in tests. */
export type GhRunner = (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: GhRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(process.env.AZHI_GH_BIN || 'gh', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });

let runner: GhRunner = defaultRunner;
const cache = new Map<string, { token: string; at: number }>();

/** For tests: replaces the `gh` runner (undefined restores the real one) and clears the token cache. */
export function setGhRunnerForTests(r?: GhRunner) {
  runner = r ?? defaultRunner;
  cache.clear();
}

const INSTALL = 'Install the GitHub CLI on the machine the server runs on (Windows: winget install GitHub.cli), then run: gh auth login';

/** The token of the `gh` login for a host, cached for a minute. Errors say what to do about them. */
export async function ghCliToken(host = 'github.com'): Promise<string> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.token;
  let out: string;
  try {
    out = (await runner(['auth', 'token', '--hostname', host], 10_000)).stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new AzhiError(ErrorClass.authorization, `The GitHub CLI (gh) was not found on the server's machine. ${INSTALL}`);
    const detail = String(e.stderr ?? e.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new AzhiError(ErrorClass.authorization, `The GitHub CLI is not signed in to ${host}${detail ? ` (${detail})` : ''}. Run on the server's machine: gh auth login${host === 'github.com' ? '' : ` --hostname ${host}`}`);
  }
  const token = out.trim();
  if (!token || /\s/.test(token)) throw new AzhiError(ErrorClass.authorization, `The GitHub CLI gave no usable token for ${host}. Run: gh auth login${host === 'github.com' ? '' : ` --hostname ${host}`}`);
  cache.set(host, { token, at: Date.now() });
  return token;
}
