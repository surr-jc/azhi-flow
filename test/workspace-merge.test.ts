import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGit } from '../src/testing/fake-git.js';
import { cloneWorkspace, collectChange, stageChange, type WorkspaceSpec } from '../src/worker/workspace.js';

/**
 * A workspace with merge_ref: the base branch is merged into a pull request's head on the worker, conflicts stay
 * in the tree as diff3 markers, the unmerged paths are reported by kind, and the change handed on is measured from
 * the merged tip, so it is the pull request's own change plus the resolutions, not everything the base gained.
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const NONE = { status: 'not_run' as const, command: '', exit_code: null, attempts: 0, output: '' };

describe.skipIf(!hasGit)('workspace merge_ref', () => {
  const root = mkdtempSync(join(tmpdir(), 'azhi-ws-merge-'));
  let git: Awaited<ReturnType<typeof startFakeGit>>;
  const sha: Record<string, string> = {};

  beforeAll(async () => {
    const work = join(root, 'work');
    mkdirSync(join(work, 'src'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'd@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'd@example.com' };
    const g = (...a: string[]) => execFileSync('git', a, { cwd: work, env }).toString().trim();
    const write = (p: string, text: string) => writeFileSync(join(work, p), text);
    g('init', '-q', '-b', 'main', '.');
    write('src/cart.js', 'export function total(items) {\n  return items.length;\n}\n');
    write('old.txt', 'remove me\n');
    g('add', '.');
    g('commit', '-qm', 'start');
    sha.start = g('rev-parse', 'HEAD');
    g('branch', 'old');
    g('branch', 'clean');
    // The pull request: edits the same line, adds a file, deletes old.txt.
    g('checkout', '-q', '-b', 'feature');
    write('src/cart.js', 'export function total(items) {\n  return items.length + 1;\n}\n');
    write('feature.txt', 'feature\n');
    g('rm', '-q', 'old.txt');
    g('add', '.');
    g('commit', '-qm', 'feature');
    sha.feature = g('rev-parse', 'HEAD');
    // The base moved: the same line differently, old.txt edited, a new file.
    g('checkout', '-q', 'main');
    write('src/cart.js', 'export function total(items) {\n  return items.length * 2;\n}\n');
    write('old.txt', 'changed on main\n');
    write('main-only.txt', 'main\n');
    g('add', '.');
    g('commit', '-qm', 'main moved');
    sha.main = g('rev-parse', 'HEAD');
    // A pull request that touches only a file the base did not.
    g('checkout', '-q', 'clean');
    write('clean.txt', 'clean\n');
    g('add', '.');
    g('commit', '-qm', 'clean change');
    mkdirSync(join(root, 'srv/acme'), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', work, join(root, 'srv/acme/shop.git')], { env });
    git = await startFakeGit(join(root, 'srv'), { token: 'ghp_read_merge' });
  });
  afterAll(async () => {
    await git?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const clone = async (name: string, spec: Partial<WorkspaceSpec>) => {
    const step = join(root, name);
    const home = join(step, 'home');
    mkdirSync(home, { recursive: true });
    const c = await cloneWorkspace({ host: git.url, repo: 'acme/shop', ref: 'refs/heads/feature', credential: 'x', mode: 'write', mergeRef: 'refs/heads/main', ...spec }, { root: step, home, token: 'ghp_read_merge', timeoutMs: 30_000 });
    return { c, home };
  };

  it('leaves conflicts as diff3 markers and reports each unmerged path by kind', async () => {
    const { c } = await clone('conflict', {});
    expect(c.merge).toEqual({
      base_sha: sha.main,
      head_sha: sha.feature,
      conflicts: [
        { path: 'old.txt', kind: 'deleted_by_us' },
        { path: 'src/cart.js', kind: 'both_modified' },
      ],
    });
    const text = readFileSync(join(c.dir, 'src/cart.js'), 'utf8');
    expect(text).toContain('<<<<<<<');
    expect(text).toContain('|||||||');
    expect(text).toContain('>>>>>>>');
  });

  it('measures the change from the merged tip: the pull request plus resolutions, not what the base gained', async () => {
    const { c, home } = await clone('change', {});
    expect(c.head).toBe(sha.main);
    writeFileSync(join(c.dir, 'src/cart.js'), 'export function total(items) {\n  return items.length * 2 + 1;\n}\n');
    writeFileSync(join(c.dir, 'old.txt'), 'changed on main\n');
    const change = await collectChange(c, home, await stageChange(c, home), { repo: 'acme/shop', ref: 'refs/heads/feature', tests: NONE });
    expect(change.base_sha).toBe(sha.main);
    expect(change.merge?.head_sha).toBe(sha.feature);
    const paths = change.files.map((f) => f.path).sort();
    expect(paths).toEqual(['feature.txt', 'src/cart.js']);
    expect(change.files.find((f) => f.path === 'src/cart.js')?.content).not.toContain('<<<<<<<');
  });

  it('merges cleanly when nothing conflicts', async () => {
    const { c, home } = await clone('clean', { ref: 'refs/heads/clean' });
    expect(c.merge?.conflicts).toEqual([]);
    const change = await collectChange(c, home, await stageChange(c, home), { repo: 'acme/shop', ref: 'refs/heads/clean', tests: NONE });
    expect(change.files.map((f) => f.path)).toEqual(['clean.txt']);
  });

  it('refuses a ref the checkout already contains, and a shallow or based clone', async () => {
    await expect(clone('contained', { ref: 'refs/heads/main', mergeRef: 'refs/heads/old' })).rejects.toThrow(/already contains merge_ref/);
    await expect(clone('shallow', { depth: 1 })).rejects.toThrow(/full history/);
    await expect(clone('based', { baseRef: 'refs/heads/main' })).rejects.toThrow(/full history/);
    await expect(clone('badref', { mergeRef: '../etc' })).rejects.toThrow(/not a plain git ref/);
  });
});
