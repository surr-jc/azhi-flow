import { ApplicationFailure } from '@temporalio/common';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorClass } from '../lib/errors.js';
import { killTree, windowsSystemEnv } from '../lib/process.js';

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
  /** `write`: the agent may edit the checkout, and its git metadata is kept outside it. */
  mode?: 'write';
  /** Write mode: a shell command run in the checkout after the agent submits. */
  test?: { command: string; timeoutMs: number; attempts: number };
}

export interface Checkout {
  dir: string;
  head: string;
  base?: string;
  /** Write mode: the git directory, outside the checkout so the agent's edits cannot reach it. */
  gitDir?: string;
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
    // Windows: git and an MCP server need the system variables to start and reach the network; the home folder is the step's.
    ...(process.platform === 'win32' ? { ...windowsSystemEnv(), USERPROFILE: home } : {}),
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
  if (spec.mode !== 'write') return { dir, head, ...(baseSha ? { base: baseSha } : {}) };
  // An agent that may write files must not be able to write git's own files (hooks, config, filters run
  // commands): the git directory moves out of the folder it edits.
  const gitDir = join(o.root, 'git');
  renameSync(join(dir, '.git'), gitDir);
  return { dir, head, gitDir, ...(baseSha ? { base: baseSha } : {}) };
}

/** Changed files Azhi hands on (and the most it will carry in a step's output). */
export const CHANGE_LIMITS = { files: 300, contentBytes: 1_000_000, diffChars: 200_000, testOutputChars: 8000 };

export interface WorkspaceChange {
  repo: string;
  ref: string;
  base_sha: string;
  files: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; mode: '100644' | '100755'; content?: string; encoding?: 'utf-8' | 'base64'; additions: number; deletions: number }>;
  diff: string;
  diff_truncated: boolean;
  stats: { files: number; additions: number; deletions: number };
  tests: { status: 'passed' | 'failed' | 'not_run'; command: string; exit_code: number | null; attempts: number; output: string };
}

/**
 * Git in a write-mode checkout, after the agent has had it: plumbing only where possible, the step's
 * isolated environment, and the settings that would run commands (hooks, fsmonitor) switched off.
 */
function workGit(c: Checkout, home: string, timeoutMs: number) {
  const pairs: Array<[string, string]> = [['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'], ['core.fsmonitor', 'false'], ['core.symlinks', 'false'], ['core.autocrlf', 'false'], ['core.quotePath', 'false']];
  const env = {
    ...isolatedGitEnv(home),
    GIT_DIR: c.gitDir!,
    GIT_WORK_TREE: c.dir,
    GIT_CONFIG_COUNT: String(pairs.length),
    ...Object.fromEntries(pairs.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  };
  return (args: string[]) =>
    new Promise<Buffer>((resolve, reject) => {
      execFile('git', args, { cwd: c.dir, env, timeout: timeoutMs, maxBuffer: 64 << 20, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        reject(ApplicationFailure.create({ type: ErrorClass.transient, message: `git ${args[0]} failed in the checkout: ${stderr.toString().trim().slice(-500) || err.message}`, nonRetryable: true }));
      });
    });
}

/** Stages everything the agent changed (ignored files stay out) and returns the tree it makes. */
export async function stageChange(c: Checkout, home: string, timeoutMs = 120_000): Promise<string> {
  const git = workGit(c, home, timeoutMs);
  await git(['add', '-A', '--', '.']);
  return (await git(['write-tree'])).toString().trim();
}

/** Puts the checkout back to a staged tree: undoes what a test run changed or left behind (ignored files such as node_modules stay). */
export async function restoreTree(c: Checkout, home: string, tree: string, timeoutMs = 120_000) {
  const git = workGit(c, home, timeoutMs);
  await git(['read-tree', tree]);
  await git(['checkout-index', '-a', '-f']);
  await git(['clean', '-fdq']);
}

/** The change from the checked-out commit to `tree`, with each changed file's new content. */
export async function collectChange(c: Checkout, home: string, tree: string, meta: { repo: string; ref: string; tests: WorkspaceChange['tests'] }, timeoutMs = 120_000): Promise<WorkspaceChange> {
  const git = workGit(c, home, timeoutMs);
  // --raw gives modes and status; -z keeps unusual path names intact.
  const raw = (await git(['diff-tree', '-r', '--no-renames', '--raw', '-z', c.head, tree])).toString('utf8').split('\0');
  const numstat = (await git(['diff-tree', '-r', '--no-renames', '--numstat', '-z', c.head, tree])).toString('utf8').split('\0');
  const counts = new Map<string, { add: number | null; del: number | null }>();
  for (const entry of numstat) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
    if (m) counts.set(m[3]!, { add: m[1] === '-' ? null : Number(m[1]), del: m[2] === '-' ? null : Number(m[2]) });
  }
  const files: WorkspaceChange['files'] = [];
  let bytes = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([AMDT])/.exec(raw[i]!);
    if (!m) continue;
    const path = raw[i + 1]!;
    const [, , newMode, blob, letter] = m;
    if (letter === 'D') {
      files.push({ path, status: 'deleted', mode: '100644', additions: 0, deletions: counts.get(path)?.del ?? 0 });
      continue;
    }
    if (newMode !== '100644' && newMode !== '100755') {
      throw ApplicationFailure.create({ type: ErrorClass.contractViolation, nonRetryable: true, message: `the change makes '${path}' a ${newMode === '120000' ? 'symbolic link' : newMode === '160000' ? 'nested repository' : `mode ${newMode} entry`}; Azhi only hands on regular files` });
    }
    const data = await git(['cat-file', 'blob', blob!]);
    bytes += data.length;
    if (files.length >= CHANGE_LIMITS.files || bytes > CHANGE_LIMITS.contentBytes) {
      throw ApplicationFailure.create({ type: ErrorClass.contractViolation, nonRetryable: true, message: `the change is larger than a step may hand on (${CHANGE_LIMITS.files} files, ${CHANGE_LIMITS.contentBytes} bytes of content); split the ticket` });
    }
    const n = counts.get(path);
    const binary = n?.add === null || data.includes(0);
    files.push({ path, status: letter === 'A' ? 'added' : 'modified', mode: newMode, ...(binary ? { content: data.toString('base64'), encoding: 'base64' as const } : { content: data.toString('utf8'), encoding: 'utf-8' as const }), additions: n?.add ?? 0, deletions: n?.del ?? 0 });
  }
  const patch = (await git(['diff-tree', '-r', '--no-renames', '-p', '--no-color', '--no-ext-diff', c.head, tree])).toString('utf8');
  const truncated = patch.length > CHANGE_LIMITS.diffChars;
  return {
    repo: meta.repo,
    ref: meta.ref,
    base_sha: c.head,
    files,
    diff: truncated ? `${patch.slice(0, CHANGE_LIMITS.diffChars)}\n[diff truncated at ${CHANGE_LIMITS.diffChars} characters]` : patch,
    diff_truncated: truncated,
    stats: { files: files.length, additions: files.reduce((s, f) => s + f.additions, 0), deletions: files.reduce((s, f) => s + f.deletions, 0) },
    tests: meta.tests,
  };
}

/**
 * Runs the step's test command in the checkout. This is repository code (possibly written by the agent)
 * running on the worker, so its environment carries no secrets: PATH, the step's own home and temp
 * folders, CI=true and the proxy settings. The command comes from the workflow, never from the agent.
 */
export function runWorkspaceTests(c: Checkout, o: { command: string; home: string; tmp: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ exit_code: number | null; output: string; timed_out: boolean }> {
  const win = process.platform === 'win32';
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: o.home,
    TMPDIR: o.tmp,
    CI: 'true',
    ...(win ? { ...windowsSystemEnv(), USERPROFILE: o.home, APPDATA: join(o.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(o.home, 'AppData', 'Local'), TEMP: o.tmp, TMP: o.tmp } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost' } : {}),
    ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
  };
  return new Promise((resolve) => {
    let out = '';
    const keep = (b: Buffer) => {
      out = (out + b.toString()).slice(-CHANGE_LIMITS.testOutputChars * 4);
    };
    const proc = spawn(o.command, { cwd: c.dir, env, shell: true, detached: !win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', keep);
    proc.stderr!.on('data', keep);
    let timedOut = false;
    const stop = () => {
      try {
        killTree(proc.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);
    o.signal?.addEventListener('abort', stop, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', stop);
      const tail = out.length > CHANGE_LIMITS.testOutputChars ? `[...]\n${out.slice(-CHANGE_LIMITS.testOutputChars)}` : out;
      resolve({ exit_code: timedOut ? null : code, output: timedOut ? `${tail}\n[stopped after ${Math.round(o.timeoutMs / 1000)} s]` : tail, timed_out: timedOut });
    };
    proc.once('error', (e) => {
      out += `\n${e.message}`;
      done(null);
    });
    proc.once('close', (code) => done(code));
  });
}

function invalid(message: string) {
  return ApplicationFailure.create({ type: ErrorClass.invalidInput, message, nonRetryable: true });
}
