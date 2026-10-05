import { ApplicationFailure } from '@temporalio/common';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorClass } from '../lib/errors.js';

/**
 * Workspace checkouts for harness steps. Each step clones into a fresh directory under its own
 * temporary root, with git told to ignore every host config file and credential helper. The
 * token (when the step names one) lives only in the environment of the one fetch command, as an
 * auth header scoped to the configured host; the checkout never stores it, nor the remote URL.
 * Symlinks are checked out as plain files so a repository cannot point a read tool outside it.
 * The caller deletes the root when the step ends.
 */
export interface WorkspaceSpec {
  /** Base URL of the git host: https://..., or http:// on loopback (local git servers, tests). */
  host: string;
  /** `owner/name`. */
  repo: string;
  ref: string;
  baseRef?: string;
  credential?: string;
  depth?: number;
}

export interface Checkout {
  dir: string;
  head: string;
  base?: string;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^(?!.*\.\.)(?!.*\/\/)(?!-)[A-Za-z0-9/_.-]{1,200}$/;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

/** The environment every git command in a workspace runs with: nothing from the host but PATH. */
export function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ALLOW_PROTOCOL: 'https:http',
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost' } : {}),
    ...(process.env.GIT_SSL_CAINFO ? { GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO } : {}),
  };
}

export function workspaceUrl(spec: WorkspaceSpec): string {
  const host = spec.host.replace(/\/+$/, '');
  if (!host.startsWith('https://') && !LOOPBACK.test(`${host}/`)) throw invalid(`workspace host must be https:// (or http:// on loopback), got ${spec.host}`);
  if (!REPO.test(spec.repo)) throw invalid(`workspace repo must be owner/name, got '${spec.repo}'`);
  return `${host}/${spec.repo}.git`;
}

export async function cloneWorkspace(spec: WorkspaceSpec, o: { root: string; home: string; token?: string; timeoutMs: number; signal?: AbortSignal }): Promise<Checkout> {
  const url = workspaceUrl(spec);
  for (const [name, ref] of [['ref', spec.ref], ['base_ref', spec.baseRef]] as const) {
    if (ref !== undefined && !REF.test(ref)) throw invalid(`workspace ${name} '${ref}' is not a plain git ref`);
  }
  const dir = join(o.root, 'repo');
  mkdirSync(dir);
  const base = { ...isolatedGitEnv(o.home), GIT_ALLOW_PROTOCOL: new URL(url).protocol.replace(':', '') };
  const config = (pairs: Array<[string, string]>): NodeJS.ProcessEnv => ({
    GIT_CONFIG_COUNT: String(pairs.length),
    ...Object.fromEntries(pairs.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  });
  const always: Array<[string, string]> = [['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'], ['core.symlinks', 'false'], ['credential.helper', ''], ['advice.detachedHead', 'false']];
  const scrub = (s: string) => (o.token ? s.split(o.token).join('***') : s);
  const git = (args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<string>((resolve, reject) => {
      execFile('git', args, { cwd: dir, env, timeout: o.timeoutMs, signal: o.signal, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout.trim());
        const denied = /could not read Username|authentication failed|returned error: 40[13]/i.test(stderr);
        reject(ApplicationFailure.create({ type: denied ? ErrorClass.authorization : ErrorClass.transient, message: scrub(`git ${args[0]} failed: ${stderr.trim().slice(-500) || err.message}`), nonRetryable: denied }));
      });
    });

  await git(['init', '-q', '.'], { ...base, ...config(always) });
  // Kept in the checkout's own config too, so later git commands (an MCP server's diff) agree with the checkout.
  await git(['config', 'core.symlinks', 'false'], { ...base, ...config(always) });
  const auth: Array<[string, string]> = o.token ? [[`http.${new URL(url).origin}/.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${o.token}`).toString('base64')}`]] : [];
  const refspecs = [`+${spec.ref}:refs/azhi/head`, ...(spec.baseRef ? [`+${spec.baseRef}:refs/azhi/base`] : [])];
  // Fetch by URL: no remote is configured, so neither the URL nor the header is written to .git/config.
  await git(['fetch', '-q', '--no-tags', '--no-recurse-submodules', ...(spec.depth ? [`--depth=${spec.depth}`] : []), url, ...refspecs], { ...base, ...config([...always, ...auth]) });
  await git(['checkout', '-q', '--detach', 'refs/azhi/head'], { ...base, ...config(always) });
  const head = await git(['rev-parse', 'HEAD'], { ...base, ...config(always) });
  const baseSha = spec.baseRef ? await git(['rev-parse', 'refs/azhi/base'], { ...base, ...config(always) }) : undefined;
  return { dir, head, ...(baseSha ? { base: baseSha } : {}) };
}

function invalid(message: string) {
  return ApplicationFailure.create({ type: ErrorClass.invalidInput, message, nonRetryable: true });
}
