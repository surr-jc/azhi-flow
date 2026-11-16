import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** What a `gh` run may be given besides its arguments: a body on stdin, its own environment and folder. */
export interface GhRunOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxBuffer?: number;
}

/** Runs `gh` with these arguments and returns its output; replaced in tests. */
export type GhRunner = (args: string[], timeoutMs: number, opts?: GhRunOptions) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: GhRunner = (args, timeoutMs, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.env.AZHI_GH_BIN || 'gh',
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: opts.maxBuffer ?? 1 << 20, ...(opts.env ? { env: opts.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) },
      (err, stdout, stderr) => {
        if (err) return reject(Object.assign(err, { stdout, stderr }));
        resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
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

/** `gh` could not give an HTTP answer at all (not installed, not signed in, its own network failure, timed out). */
export class GhApiError extends Error {}

export interface GhApiReply {
  status: number;
  header(name: string): string | null;
  text: string;
}

/** Splits the output of `gh api --include` (status line, headers, blank line, body); undefined when there is no HTTP answer in it. */
export function parseGhApiOutput(out: string): GhApiReply | undefined {
  const m = /^HTTP\/\S+ (\d{3})/.exec(out);
  if (!m) return undefined;
  const split = /\r?\n\r?\n/.exec(out);
  const head = split ? out.slice(0, split.index) : out;
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return { status: Number(m[1]), header: (n) => headers.get(n.toLowerCase()) ?? null, text: split ? out.slice(split.index + split[0].length) : '' };
}

/** The environment `gh` runs with: the server's own, minus every token variable, so it uses its login unless a token is given on purpose. */
function ghEnv(host: string, token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GH|GITHUB)_(ENTERPRISE_)?TOKEN$/i.test(k)) env[k] = v;
  Object.assign(env, { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '' });
  if (token) env[host.toLowerCase() === 'github.com' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'] = token;
  return env;
}

/**
 * One GitHub REST call made by `gh api` instead of by Node (the fallback of the GitHub tools). Without `token`
 * `gh` uses its own login; with one, that token. The body goes on stdin (it may hold untrusted text, and a
 * command line is short on Windows), and `gh` runs in an empty folder so `{owner}`/`{repo}` have no repository
 * to be filled from. Returns the HTTP answer whatever its status; throws GhApiError when there is none.
 */
export async function ghApi(o: { host: string; method: string; path: string; body?: unknown; token?: string; timeoutMs: number }): Promise<GhApiReply> {
  if (!o.path.startsWith('/') || /[{}\s]/.test(o.path)) throw new GhApiError(`gh is not given the path '${o.path.slice(0, 80)}'`);
  const args = ['api', '--method', o.method, '--hostname', o.host, '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (o.body !== undefined) args.push('-H', 'Content-Type: application/json', '--input', '-');
  args.push(o.path.slice(1));
  const cwd = await mkdtemp(join(tmpdir(), 'azhi-gh-'));
  const scrub = (s: string) => (o.token ? s.split(o.token).join('***') : s);
  try {
    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await runner(args, o.timeoutMs, { cwd, env: ghEnv(o.host, o.token), maxBuffer: 16 << 20, ...(o.body !== undefined ? { input: JSON.stringify(o.body) } : {}) }));
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (e.code === 'ENOENT') throw new GhApiError(`the GitHub CLI (gh) was not found on the server's machine. ${INSTALL}`);
      stdout = e.stdout ?? '';
      stderr = e.stderr || e.message || '';
    }
    // gh exits 1 on a non-2xx answer but still prints it, so the answer is what counts, not the exit code.
    const reply = parseGhApiOutput(stdout);
    if (reply) return reply;
    throw new GhApiError(scrub(String(stderr).replace(/\s+/g, ' ').trim().slice(0, 200)) || 'gh gave no HTTP answer');
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
