import { ApplicationFailure } from '@temporalio/common';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ErrorClass } from '../lib/errors.js';
import { REF, invalid, isolatedGitEnv, type Checkout, type WorkspaceSpec } from './workspace.js';

/**
 * Local workspaces (docs/local-workspaces.md): a run works in a git worktree of a folder on this machine
 * instead of a fresh clone. The worktree is made once per run and folder, under the worker's own data
 * directory and on the run's own branch, and every step of the run that names the folder reuses it. A step
 * never deletes it: it stays for the person to open, until `azhi worktree remove`.
 *
 * Git runs as it does for a clone: no host config, hooks and fsmonitor off, so nothing in the repository's own
 * settings starts a program. The repository gains one branch and one worktree entry; its own working tree and
 * HEAD are not touched. Nothing is merged or pushed.
 */
export interface LocalWorkspace {
  /** The registered name of the folder. */
  name: string;
  /** Its absolute path on this machine, from the workspace's registry (never from workflow text). */
  path: string;
  /** What the worktree starts from; HEAD when absent. */
  ref?: string;
  baseRef?: string;
  mode?: 'write';
  test?: WorkspaceSpec['test'];
}

/** What is kept beside a worktree so later steps, a restarted worker and the CLI can find it. */
export interface WorktreeRecord {
  run: string;
  folder: string;
  /** The worktree folder. */
  path: string;
  /** The repository it is a worktree of. */
  repo: string;
  branch: string;
  base_sha: string;
  git_dir: string;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const FOLDER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const STALE_LOCK_MS = 12 * 60 * 60 * 1000;
const IDENTITY = { GIT_AUTHOR_NAME: 'azhi', GIT_AUTHOR_EMAIL: 'azhi@localhost', GIT_COMMITTER_NAME: 'azhi', GIT_COMMITTER_EMAIL: 'azhi@localhost' };
const SETTINGS: Array<[string, string]> = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['core.symlinks', 'false'], ['credential.helper', ''], ['advice.detachedHead', 'false']];

function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...isolatedGitEnv(home),
    ...IDENTITY,
    GIT_CONFIG_COUNT: String(SETTINGS.length),
    ...Object.fromEntries(SETTINGS.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  };
}

function run(cwd: string, home: string, args: string[], o: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...gitEnv(home), ...(o.env ?? {}) }, timeout: o.timeoutMs ?? 120_000, signal: o.signal, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      reject(new Error(`git ${args[0]} failed: ${stderr.trim().slice(-500) || err.message}`));
    });
  });
}

/** A path as git and Node agree on it: real, forward slashes, no trailing slash, lower case on Windows. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let real = p;
    try {
      real = realpathSync.native(p);
    } catch {
      /* compared as written */
    }
    const s = real.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

const sidecar = (worktreeDir: string, run: string, folder: string) => join(worktreeDir, `${run}-${folder}.json`);

function readRecord(file: string): WorktreeRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as WorktreeRecord;
    return typeof r.path === 'string' && typeof r.repo === 'string' && typeof r.branch === 'string' && typeof r.base_sha === 'string' && typeof r.git_dir === 'string' ? r : undefined;
  } catch {
    return undefined;
  }
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One step at a time works in a run's worktree: parallel steps of the run take turns. */
async function lock(dir: string, timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
  const held = `${dir}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(held);
      return () => rmSync(held, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // A lock left by a step that was killed: nothing has held one this long.
    try {
      if (Date.now() - statSync(held).mtimeMs > STALE_LOCK_MS) rmSync(held, { recursive: true, force: true });
    } catch {
      /* released meanwhile */
    }
    if (signal?.aborted || Date.now() > deadline) throw ApplicationFailure.create({ type: ErrorClass.transient, nonRetryable: true, message: `another step of this run is still working in ${dir}; this step waited ${Math.round(timeoutMs / 1000)} s for it` });
    await pause(250);
  }
}

/**
 * The run's worktree of a local folder: made on first use, reused after. Returns it as a `Checkout`
 * (`head` is the commit the run started from, so a change is always measured from there) with the lock
 * the caller releases when its step ends.
 */
export async function localWorktree(w: LocalWorkspace, o: { runId: string; worktreeDir: string; home: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ checkout: Checkout; record: WorktreeRecord; created: boolean; release: () => void }> {
  if (!FOLDER.test(w.name)) throw invalid(`'${w.name}' is not a local folder name`);
  if (!RUN_ID.test(o.runId)) throw invalid(`run id '${o.runId}' cannot name a branch`);
  if (typeof w.path !== 'string' || !isAbsolute(w.path) || w.path.includes('\0')) throw invalid(`local folder '${w.name}' has no absolute path on this worker`);
  const ref = w.ref || 'HEAD';
  for (const [name, r] of [['ref', ref], ['base_ref', w.baseRef]] as const) {
    if (r !== undefined && !REF.test(r)) throw invalid(`workspace ${name} '${r}' is not a plain git ref`);
  }
  if (!existsSync(w.path)) throw invalid(`local folder '${w.name}' (${w.path}) does not exist on this worker`);
  const git = (cwd: string, args: string[]) => run(cwd, o.home, args, { timeoutMs: o.timeoutMs, signal: o.signal });
  const top = await git(w.path, ['rev-parse', '--show-toplevel']).catch(() => undefined);
  if (top === undefined || !samePath(top, w.path)) throw invalid(`local folder '${w.name}' (${w.path}) is not the top folder of a git repository on this worker`);

  // Absolute: git runs in the folder's repository, where a relative path would land inside it.
  const worktreeDir = resolve(o.worktreeDir);
  mkdirSync(worktreeDir, { recursive: true });
  const dir = join(worktreeDir, `${o.runId}-${w.name}`);
  const branch = `azhi/${o.runId}`;
  const file = sidecar(worktreeDir, o.runId, w.name);
  const release = await lock(dir, o.timeoutMs, o.signal);
  try {
    let record = readRecord(file);
    let created = false;
    if (!record || !existsSync(join(dir, '.git'))) {
      // A folder deleted by hand leaves a stale entry in the repository; clear it before adding again.
      await git(w.path, ['worktree', 'prune']);
      const start = await git(w.path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => {
        throw invalid(`workspace ref '${ref}' is not a commit in local folder '${w.name}'`);
      });
      const exists = await git(w.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
      try {
        await git(w.path, exists ? ['worktree', 'add', '-q', dir, branch] : ['worktree', 'add', '-q', '-b', branch, dir, start]);
      } catch (e) {
        throw ApplicationFailure.create({ type: ErrorClass.transient, nonRetryable: true, message: `could not make a worktree of local folder '${w.name}': ${(e as Error).message}` });
      }
      // A branch that was already there (the folder was removed and the run went on) keeps the base it started from.
      const base = record?.base_sha ?? (exists ? await git(w.path, ['merge-base', branch, start]).catch(() => start) : start);
      record = { run: o.runId, folder: w.name, path: dir, repo: w.path, branch, base_sha: base, git_dir: await git(dir, ['rev-parse', '--absolute-git-dir']) };
      writeFileSync(file, JSON.stringify(record, null, 2));
      created = true;
    }
    const baseRef = w.baseRef
      ? await git(w.path, ['rev-parse', '--verify', '--quiet', `${w.baseRef}^{commit}`]).catch(() => {
          throw invalid(`workspace base_ref '${w.baseRef}' is not a commit in local folder '${w.name}'`);
        })
      : undefined;
    // Kept as its own ref in the worktree, as a clone has it, so tools can diff refs/azhi/base...HEAD.
    if (baseRef) await run(dir, o.home, ['update-ref', 'refs/azhi/base', baseRef], { env: { GIT_DIR: record.git_dir, GIT_WORK_TREE: dir } });
    // As for a clone, `gitDir` is set only when the agent may write: that is how a harness tells the two apart.
    return { checkout: { dir, head: record.base_sha, ...(w.mode === 'write' ? { gitDir: record.git_dir } : {}), ...(baseRef ? { base: baseRef } : {}) }, record, created, release };
  } catch (e) {
    release();
    throw e;
  }
}

/**
 * After a step: the worktree's `.git` pointer is put back if the agent changed it (it sits in the folder
 * the agent edits, and an editor opening the folder follows it), and a write step's change is committed to
 * the run branch, so the next step and the person both start from a clean tree.
 */
export async function finishLocalStep(r: WorktreeRecord, home: string, o: { nodeId: string; commit: boolean }): Promise<{ pointer_restored: boolean; committed: boolean }> {
  const c = { dir: r.path, gitDir: r.git_dir };
  const pointer = join(c.dir, '.git');
  const want = `gitdir: ${c.gitDir.replace(/\\/g, '/')}\n`;
  let ok = false;
  try {
    ok = lstatSync(pointer).isFile() && readFileSync(pointer, 'utf8').trim().replace(/\\/g, '/') === want.trim();
  } catch {
    /* missing */
  }
  if (!ok) {
    rmSync(pointer, { recursive: true, force: true });
    writeFileSync(pointer, want);
  }
  let committed = false;
  if (o.commit) {
    const env = { GIT_DIR: c.gitDir, GIT_WORK_TREE: c.dir };
    await run(c.dir, home, ['add', '-A', '--', '.'], { env });
    const changed = await run(c.dir, home, ['diff', '--cached', '--name-only', 'HEAD'], { env });
    if (changed) {
      await run(c.dir, home, ['commit', '-q', '--no-verify', '--no-gpg-sign', '-m', `azhi: ${o.nodeId}`], { env });
      committed = true;
    }
  }
  return { pointer_restored: !ok, committed };
}

/** A harness step's local workspace: the worktree, held for the step, and reported to the server so the run page can show it. */
export interface OpenLocalWorkspace {
  checkout: Checkout;
  record: WorktreeRecord;
  /** Set when the server could not be told; the step goes on. */
  reportError?: string;
  /** Ends the step in the worktree: restores the pointer, commits a write step's change, releases the lock. */
  close(nodeId: string): Promise<void>;
}

export async function openLocalWorkspace(
  w: LocalWorkspace,
  o: { worktreeDir?: string; workerId: string; api: { post: (path: string, body?: unknown) => Promise<unknown> }; runId: string; home: string; timeoutMs: number; signal?: AbortSignal },
): Promise<OpenLocalWorkspace> {
  if (!o.worktreeDir) throw ApplicationFailure.create({ type: ErrorClass.unsupportedCapability, nonRetryable: true, message: 'this worker does not allow local folders; start it with --local-folders' });
  const { checkout, record, release } = await localWorktree(w, { runId: o.runId, worktreeDir: o.worktreeDir, home: o.home, timeoutMs: o.timeoutMs, signal: o.signal });
  const reportError = await o.api
    .post('/v1/gateway/worktree', { folder: record.folder, path: record.path, branch: record.branch, base_sha: record.base_sha, worker_id: o.workerId })
    .then(() => undefined, (e: Error) => e.message);
  return {
    checkout,
    record,
    ...(reportError ? { reportError } : {}),
    async close(nodeId) {
      try {
        await finishLocalStep(record, o.home, { nodeId, commit: w.mode === 'write' });
      } finally {
        release();
      }
    },
  };
}

/** Every worktree recorded on this machine. */
export function listWorktrees(worktreeDir: string): WorktreeRecord[] {
  if (!existsSync(worktreeDir)) return [];
  return readdirSync(worktreeDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readRecord(join(worktreeDir, f)))
    .filter((r): r is WorktreeRecord => Boolean(r))
    .sort((a, b) => a.run.localeCompare(b.run) || a.folder.localeCompare(b.folder));
}

/**
 * Removes a run's worktree folder. Git refuses a folder with uncommitted or untracked files unless
 * `force` is set. The run's branch is left in the repository: deleting work is the person's call.
 */
export async function removeWorktree(worktreeDir: string, r: WorktreeRecord, o: { force?: boolean } = {}): Promise<void> {
  const home = tmpdir();
  if (existsSync(r.path)) await run(r.repo, home, ['worktree', 'remove', ...(o.force ? ['--force'] : []), r.path]);
  else if (existsSync(r.repo)) await run(r.repo, home, ['worktree', 'prune']);
  rmSync(sidecar(worktreeDir, r.run, r.folder), { force: true });
  rmSync(`${r.path}.lock`, { recursive: true, force: true });
}
