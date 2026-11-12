import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectChange, stageChange } from '../src/worker/workspace.js';
import { finishLocalStep, listWorktrees, localWorktree, openLocalWorkspace, removeWorktree } from '../src/worker/worktree.js';

/**
 * A local workspace on the worker: the run gets a git worktree of a folder on this machine, on its own
 * branch, and keeps it. The folder's own working tree is never touched, nothing in its git settings runs a
 * program, and the worktree is removed only when asked. No OpenCode here: the "agent" is this test writing files.
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('local workspace (git worktree)', () => {
  const root = mkdtempSync(join(tmpdir(), 'azhi-ws-local-'));
  const repo = join(root, 'repo');
  const worktreeDir = join(root, 'worktrees');
  const home = join(root, 'home');
  const marker = join(root, 'hook-ran');
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'd@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'd@example.com' };
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env }).toString().trim();
  let base = '';
  const opts = (runId: string) => ({ runId, worktreeDir, home, timeoutMs: 30_000 });

  beforeAll(() => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(home);
    g('init', '-q', '-b', 'main', '.');
    writeFileSync(join(repo, 'src/cart.js'), 'export const total = (items) => items.length;\n');
    writeFileSync(join(repo, 'old.txt'), 'remove me\n');
    g('add', '.');
    g('commit', '-qm', 'start');
    base = g('rev-parse', 'HEAD');
    // Hooks that would leave a marker if anything ran them.
    for (const hook of ['post-checkout', 'pre-commit', 'post-commit']) {
      writeFileSync(join(repo, '.git/hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    }
    // The person's own uncommitted work, which a run must leave alone.
    writeFileSync(join(repo, 'notes.txt'), 'mine\n');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('makes a worktree on the run branch, reuses it, and leaves the folder alone', async () => {
    const a = await localWorktree({ name: 'shop', path: repo }, opts('run_a'));
    a.release();
    expect(a.created).toBe(true);
    expect(a.record.branch).toBe('azhi/run_a');
    expect(a.record.base_sha).toBe(base);
    expect(a.checkout.head).toBe(base);
    expect(a.checkout.gitDir).toBeUndefined(); // read mode
    expect(readFileSync(join(a.checkout.dir, 'src/cart.js'), 'utf8')).toContain('items.length');
    expect(a.checkout.dir.startsWith(worktreeDir)).toBe(true);

    const again = await localWorktree({ name: 'shop', path: repo }, opts('run_a'));
    again.release();
    expect(again.created).toBe(false);
    expect(again.record.path).toBe(a.record.path);

    // The folder: still on main at the same commit, its untracked file in place, one new branch.
    expect(g('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(g('rev-parse', 'HEAD')).toBe(base);
    expect(g('status', '--porcelain')).toBe('?? notes.txt');
    expect(g('branch', '--list', 'azhi/run_a')).toContain('azhi/run_a');
    expect(existsSync(marker)).toBe(false);
  });

  it('commits a write step to the run branch and measures the change from where the run started', async () => {
    const w = await localWorktree({ name: 'shop', path: repo, mode: 'write' }, opts('run_b'));
    expect(w.checkout.gitDir).toBe(w.record.git_dir);
    writeFileSync(join(w.checkout.dir, 'src/cart.js'), 'export const total = (items) => items.reduce((n, i) => n + i.price, 0);\n');
    rmSync(join(w.checkout.dir, 'old.txt'));
    const tree = await stageChange(w.checkout, home);
    const change = await collectChange(w.checkout, home, tree, { repo: 'local:shop', ref: w.record.branch, tests: { status: 'not_run', command: '', exit_code: null, attempts: 0, output: '' } });
    expect(change.base_sha).toBe(base);
    expect(change.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['deleted old.txt', 'modified src/cart.js']);
    expect(await finishLocalStep(w.record, home, { nodeId: 'implement', commit: true })).toEqual({ pointer_restored: false, committed: true });
    w.release();
    expect(g('log', '-1', '--format=%s', 'azhi/run_b')).toBe('azhi: implement');
    expect(g('rev-parse', 'azhi/run_b^')).toBe(base);

    // A second step adds a file: its change is the run's whole change, from the same base.
    const next = await localWorktree({ name: 'shop', path: repo, mode: 'write' }, opts('run_b'));
    expect(next.created).toBe(false);
    writeFileSync(join(next.checkout.dir, 'src/cart.test.js'), 'import assert from "node:assert";\n');
    const tree2 = await stageChange(next.checkout, home);
    const change2 = await collectChange(next.checkout, home, tree2, { repo: 'local:shop', ref: next.record.branch, tests: { status: 'not_run', command: '', exit_code: null, attempts: 0, output: '' } });
    expect(change2.base_sha).toBe(base);
    expect(change2.files.map((f) => f.path).sort()).toEqual(['old.txt', 'src/cart.js', 'src/cart.test.js']);
    await finishLocalStep(next.record, home, { nodeId: 'tests', commit: true });
    next.release();

    // Nothing ran the folder's hooks, and the folder itself is as it was.
    expect(existsSync(marker)).toBe(false);
    expect(g('rev-parse', 'HEAD')).toBe(base);
    expect(g('status', '--porcelain')).toBe('?? notes.txt');
  });

  it('puts the .git pointer back when the agent changed it', async () => {
    const w = await localWorktree({ name: 'shop', path: repo, mode: 'write' }, opts('run_c'));
    const pointer = join(w.checkout.dir, '.git');
    const before = readFileSync(pointer, 'utf8');
    // Replaced, not rewritten in place: git marks the file hidden on Windows, where Node cannot truncate a hidden file.
    rmSync(pointer);
    writeFileSync(pointer, 'gitdir: ./evil\n');
    const r = await finishLocalStep(w.record, home, { nodeId: 'n', commit: false });
    w.release();
    expect(r.pointer_restored).toBe(true);
    expect(readFileSync(pointer, 'utf8').trim()).toBe(before.trim());
  });

  it('refuses a folder that is not the top of a repository, and a ref that is not plain', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    await expect(localWorktree({ name: 'plain', path: plain }, opts('run_d'))).rejects.toThrow(/not the top folder of a git repository/);
    await expect(localWorktree({ name: 'sub', path: join(repo, 'src') }, opts('run_d'))).rejects.toThrow(/not the top folder of a git repository/);
    await expect(localWorktree({ name: 'gone', path: join(root, 'missing') }, opts('run_d'))).rejects.toThrow(/does not exist/);
    await expect(localWorktree({ name: 'shop', path: 'relative/path' }, opts('run_d'))).rejects.toThrow(/absolute path/);
    await expect(localWorktree({ name: 'shop', path: repo, ref: '--upload-pack=x' }, opts('run_d'))).rejects.toThrow(/not a plain git ref/);
    await expect(localWorktree({ name: 'shop', path: repo, ref: 'a..b' }, opts('run_d'))).rejects.toThrow(/not a plain git ref/);
    await expect(localWorktree({ name: 'shop', path: repo, ref: 'no-such-branch' }, opts('run_d'))).rejects.toThrow(/is not a commit/);
    await expect(localWorktree({ name: 'shop', path: repo }, opts('../escape'))).rejects.toThrow(/cannot name a branch/);
    expect(listWorktrees(worktreeDir).some((r) => r.run === 'run_d')).toBe(false);
  });

  it('lets one step at a time work in a run\'s worktree', async () => {
    const first = await localWorktree({ name: 'shop', path: repo }, opts('run_e'));
    let entered = false;
    const second = localWorktree({ name: 'shop', path: repo }, opts('run_e')).then((w) => {
      entered = true;
      return w;
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(entered).toBe(false);
    first.release();
    (await second).release();
    expect(entered).toBe(true);
  });

  it('opens only on a worker that allows local folders, and reports the worktree', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const api = { post: async (path: string, body?: unknown) => void posts.push({ path, body }) };
    await expect(openLocalWorkspace({ name: 'shop', path: repo }, { workerId: 'w1', api, runId: 'run_f', home, timeoutMs: 30_000 })).rejects.toThrow(/does not allow local folders/);
    const open = await openLocalWorkspace({ name: 'shop', path: repo, mode: 'write' }, { worktreeDir, workerId: 'w1', api, runId: 'run_f', home, timeoutMs: 30_000 });
    expect(posts).toEqual([{ path: '/v1/gateway/worktree', body: { folder: 'shop', path: open.record.path, branch: 'azhi/run_f', base_sha: base, worker_id: 'w1' } }]);
    writeFileSync(join(open.checkout.dir, 'new.txt'), 'x\n');
    await open.close('step');
    expect(g('log', '-1', '--format=%s', 'azhi/run_f')).toBe('azhi: step');
    // A server that cannot be reached does not fail the step.
    const offline = await openLocalWorkspace({ name: 'shop', path: repo }, { worktreeDir, workerId: 'w1', api: { post: async () => Promise.reject(new Error('offline')) }, runId: 'run_f', home, timeoutMs: 30_000 });
    expect(offline.reportError).toBe('offline');
    await offline.close('step');
  });

  it('removes a worktree only when asked, refuses a dirty one without force, and keeps the branch', async () => {
    const w = await localWorktree({ name: 'shop', path: repo }, opts('run_g'));
    w.release();
    writeFileSync(join(w.checkout.dir, 'scratch.txt'), 'untracked\n');
    const rec = listWorktrees(worktreeDir).find((r) => r.run === 'run_g')!;
    expect(rec.path).toBe(w.record.path);
    await expect(removeWorktree(worktreeDir, rec)).rejects.toThrow(/worktree/);
    expect(existsSync(w.checkout.dir)).toBe(true);
    await removeWorktree(worktreeDir, rec, { force: true });
    expect(existsSync(w.checkout.dir)).toBe(false);
    expect(listWorktrees(worktreeDir).some((r) => r.run === 'run_g')).toBe(false);
    expect(g('branch', '--list', 'azhi/run_g')).toContain('azhi/run_g');
  });
});
