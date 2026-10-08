import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGit } from '../src/testing/fake-git.js';
import { cloneWorkspace, collectChange, restoreTree, runWorkspaceTests, stageChange, type Checkout } from '../src/worker/workspace.js';

/**
 * A write-mode workspace on the worker: git metadata moves out of the folder the agent edits, the change
 * is staged as a tree, a test run cannot add to it, and the change comes back as files with their new
 * content plus a diff. No OpenCode here: the "agent" is this test writing files.
 */
const win = process.platform === 'win32';
const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('write-mode workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'azhi-ws-write-'));
  let git: Awaited<ReturnType<typeof startFakeGit>>;
  let base = '';

  beforeAll(async () => {
    const work = join(root, 'work');
    mkdirSync(join(work, 'src'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'd@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'd@example.com' };
    const g = (...a: string[]) => execFileSync('git', a, { cwd: work, env }).toString().trim();
    g('init', '-q', '-b', 'main', '.');
    writeFileSync(join(work, 'src/cart.js'), 'export function total(items) {\n  return items.length;\n}\n');
    writeFileSync(join(work, 'old.txt'), 'remove me\n');
    writeFileSync(join(work, '.gitignore'), 'node_modules/\n');
    g('add', '.');
    g('commit', '-qm', 'start');
    base = g('rev-parse', 'HEAD');
    mkdirSync(join(root, 'srv/acme'), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', work, join(root, 'srv/acme/shop.git')], { env });
    git = await startFakeGit(join(root, 'srv'), { token: 'ghp_read_ws' });
  });
  afterAll(async () => {
    await git?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const clone = async (name: string): Promise<{ c: Checkout; home: string; step: string }> => {
    const step = join(root, name);
    const home = join(step, 'home');
    mkdirSync(home, { recursive: true });
    const c = await cloneWorkspace({ host: git.url, repo: 'acme/shop', ref: 'HEAD', credential: 'x', mode: 'write' }, { root: step, home, token: 'ghp_read_ws', timeoutMs: 30_000 });
    return { c, home, step };
  };

  it('keeps git metadata out of the checkout and hands back the change with its tests', async () => {
    const { c, home, step } = await clone('a');
    expect(c.head).toBe(base);
    expect(existsSync(join(c.dir, '.git'))).toBe(false);
    expect(c.gitDir && existsSync(join(c.gitDir, 'HEAD'))).toBe(true);

    // The agent's edits: one changed file, one new, one deleted, a binary file, and an ignored folder.
    writeFileSync(join(c.dir, 'src/cart.js'), 'export function total(items) {\n  return items.reduce((n, i) => n + i.price, 0);\n}\n');
    writeFileSync(join(c.dir, 'src/cart.test.js'), 'import assert from "node:assert";\n');
    rmSync(join(c.dir, 'old.txt'));
    writeFileSync(join(c.dir, 'logo.bin'), Buffer.from([0, 1, 2, 255]));
    mkdirSync(join(c.dir, 'node_modules/x'), { recursive: true });
    writeFileSync(join(c.dir, 'node_modules/x/index.js'), 'ignored');
    const tree = await stageChange(c, home);

    // The test command writes a stray file and edits a tracked one; neither may reach the change.
    const script = win ? 'echo stray> stray.txt && echo changed> src\\cart.js && echo tests-ran && exit /b 0' : 'echo stray > stray.txt; echo changed > src/cart.js; echo tests-ran; echo "home=$HOME token=${GITHUB_TOKEN:-none}"';
    process.env.GITHUB_TOKEN = 'must-not-leak';
    const r = await runWorkspaceTests(c, { command: script, home, tmp: step, timeoutMs: 30_000 });
    delete process.env.GITHUB_TOKEN;
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain('tests-ran');
    if (!win) expect(r.output).toContain(`home=${home} token=none`);
    await restoreTree(c, home, tree);
    expect(existsSync(join(c.dir, 'stray.txt'))).toBe(false);
    expect(readFileSync(join(c.dir, 'src/cart.js'), 'utf8')).toContain('reduce');
    expect(existsSync(join(c.dir, 'node_modules/x/index.js'))).toBe(true);

    const change = await collectChange(c, home, tree, { repo: 'acme/shop', ref: 'HEAD', tests: { status: 'passed', command: script, exit_code: 0, attempts: 1, output: r.output } });
    expect(change.base_sha).toBe(base);
    const byPath = Object.fromEntries(change.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['logo.bin', 'old.txt', 'src/cart.js', 'src/cart.test.js']);
    expect(byPath['src/cart.js']).toMatchObject({ status: 'modified', mode: '100644', encoding: 'utf-8', additions: 1, deletions: 1 });
    expect(byPath['src/cart.js']!.content).toContain('reduce');
    expect(byPath['src/cart.test.js']).toMatchObject({ status: 'added', additions: 1 });
    expect(byPath['old.txt']).toMatchObject({ status: 'deleted' });
    expect(byPath['old.txt']!.content).toBeUndefined();
    expect(byPath['logo.bin']).toMatchObject({ status: 'added', encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') });
    expect(change.diff).toContain('+  return items.reduce');
    expect(change.stats).toMatchObject({ files: 4 });
    expect(change.tests.status).toBe('passed');
  });

  it('reports a failing or slow test command', async () => {
    const { c, home, step } = await clone('b');
    const failed = await runWorkspaceTests(c, { command: win ? 'echo boom && exit /b 3' : 'echo boom; exit 3', home, tmp: step, timeoutMs: 30_000 });
    expect(failed).toMatchObject({ exit_code: 3, timed_out: false });
    expect(failed.output).toContain('boom');
    if (!win) {
      const slow = await runWorkspaceTests(c, { command: 'sleep 20', home, tmp: step, timeoutMs: 500 });
      expect(slow).toMatchObject({ exit_code: null, timed_out: true });
    }
  });

  it.skipIf(win)('refuses to hand on a symbolic link the change adds', async () => {
    const { c, home } = await clone('c');
    // core.symlinks is off for the checkout; a link made on disk anyway is still a link to git add.
    symlinkSync('/etc/passwd', join(c.dir, 'link'));
    writeFileSync(join(c.dir, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(c.dir, 'run.sh'), 0o755);
    const tree = await stageChange(c, home);
    await expect(collectChange(c, home, tree, { repo: 'acme/shop', ref: 'HEAD', tests: { status: 'not_run', command: '', exit_code: null, attempts: 0, output: '' } })).rejects.toThrow(/symbolic link/);
  });
});
