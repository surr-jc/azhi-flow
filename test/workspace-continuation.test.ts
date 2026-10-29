import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGit } from '../src/testing/fake-git.js';
import { applyContinuation, resolveWorkspace, unsafePath, validateContinuation, type Continuation, type ContinuationFile } from '../src/worker/continuation.js';
import { cloneWorkspace, collectChange, isolatedGitEnv, stageChange, type Checkout } from '../src/worker/workspace.js';

/**
 * Workspace continuation on the worker. No OpenCode here: the "agent" is this test.
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

describe.skipIf(!hasGit)('workspace continuation', () => {
  const root = mkdtempSync(join(tmpdir(), 'azhi-ws-cont-'));
  let git: Awaited<ReturnType<typeof startFakeGit>>;
  let first = '';
  let tip = '';

  beforeAll(async () => {
    const work = join(root, 'work');
    mkdirSync(join(work, 'src'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'd@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'd@example.com' };
    const g = (...a: string[]) => execFileSync('git', a, { cwd: work, env }).toString().trim();
    g('init', '-q', '-b', 'main', '.');
    writeFileSync(join(work, 'src/cart.js'), 'export const total = (items) => items.length;\n');
    writeFileSync(join(work, 'old.txt'), 'remove me\n');
    writeFileSync(join(work, 'run.sh'), '#!/bin/sh\necho hi\n');
    g('add', '.');
    g('commit', '-qm', 'first');
    first = g('rev-parse', 'HEAD');
    // The branch moves on after the producer ran: the base the change was made against is no longer the tip.
    writeFileSync(join(work, 'README.md'), 'later\n');
    g('add', '.');
    g('commit', '-qm', 'second');
    tip = g('rev-parse', 'HEAD');
    mkdirSync(join(root, 'srv/acme'), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', work, join(root, 'srv/acme/shop.git')], { env });
    git = await startFakeGit(join(root, 'srv'), { token: 'ghp_read_ws' });
  });
  afterAll(async () => {
    await git?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  /** What the earlier step handed on: a modified file, a new one (text and binary), a deleted one, and a mode change. */
  const change = (over: Partial<Continuation> = {}): Continuation => ({
    baseSha: first,
    files: [
      { path: 'src/cart.js', status: 'modified', mode: '100644', encoding: 'utf-8', content: 'export const total = (items) => items.reduce((n, i) => n + i.price, 0);\n' },
      { path: 'src/cart.test.js', status: 'added', mode: '100644', encoding: 'utf-8', content: 'import assert from "node:assert";\n' },
      { path: 'logo.bin', status: 'added', mode: '100644', encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') },
      { path: 'old.txt', status: 'deleted', mode: '100644' },
      { path: 'run.sh', status: 'modified', mode: '100755', encoding: 'utf-8', content: '#!/bin/sh\necho hello\n' },
    ],
    ...over,
  });

  let n = 0;
  const clone = async (continuation: Continuation | undefined, o: { ref?: string; mode?: 'write'; baseRef?: string } = {}) => {
    const step = join(root, `step${n++}`);
    const home = join(step, 'home');
    mkdirSync(home, { recursive: true });
    const c = await cloneWorkspace(
      { host: git.url, repo: 'acme/shop', ref: o.ref ?? 'HEAD', credential: 'x', ...(o.mode ? { mode: o.mode } : {}), ...(o.baseRef ? { baseRef: o.baseRef } : {}), ...(continuation ? { continuation } : {}) },
      { root: step, home, token: 'ghp_read_ws', timeoutMs: 30_000 },
    );
    return { c, home, step };
  };
  /** Git in a read-mode checkout, as an MCP diff tool runs it. */
  const gitIn = (c: Checkout, home: string, ...args: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: c.dir, env: isolatedGitEnv(home) }).toString().trim();

  it('can fetch a commit that is no longer the tip of any branch, by its SHA', async () => {
    expect(first).not.toBe(tip);
    const { c } = await clone(change({ files: [] }));
    expect(c.head).toBe(first);
    expect(existsSync(join(c.dir, 'README.md'))).toBe(false);
    expect(readFileSync(join(c.dir, 'src/cart.js'), 'utf8')).toContain('items.length');
  });

  it('starts from the change\'s own base, whatever the step\'s ref now points at', async () => {
    const { c } = await clone(change(), { ref: 'refs/heads/main' });
    expect(c.head).toBe(first);
    expect(c.base).toBe(first);
    expect(existsSync(join(c.dir, 'README.md'))).toBe(false); // the later commit on main is not in it
  });

  it('applies added, modified, deleted, binary and executable files, and commits them locally', async () => {
    const { c, home } = await clone(change());
    expect(readFileSync(join(c.dir, 'src/cart.js'), 'utf8')).toContain('reduce');
    expect(readFileSync(join(c.dir, 'src/cart.test.js'), 'utf8')).toContain('node:assert');
    expect(readFileSync(join(c.dir, 'logo.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(existsSync(join(c.dir, 'old.txt'))).toBe(false);
    expect(readFileSync(join(c.dir, 'run.sh'), 'utf8')).toContain('hello');

    // The same range the pull request tools diff: it must show the change, not "no changes".
    const names = gitIn(c, home, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', 'refs/azhi/base...HEAD').split('\n').sort();
    expect(names).toEqual(['logo.bin', 'old.txt', 'run.sh', 'src/cart.js', 'src/cart.test.js']);
    expect(gitIn(c, home, 'rev-parse', 'refs/azhi/base')).toBe(first);
    expect(gitIn(c, home, 'rev-parse', 'HEAD')).not.toBe(first);
    expect(gitIn(c, home, 'log', '-1', '--format=%an <%ae>')).toBe('azhi <azhi@localhost>');
    expect(gitIn(c, home, 'status', '--porcelain')).toBe('');
    // The recorded mode survives a file system that cannot show it.
    expect(gitIn(c, home, 'ls-files', '-s', 'run.sh')).toMatch(/^100755 /);
    expect(gitIn(c, home, 'ls-files', '-s', 'src/cart.js')).toMatch(/^100644 /);
  });

  it('an empty change makes no commit', async () => {
    const { c, home } = await clone(change({ files: [] }));
    expect(gitIn(c, home, 'rev-parse', 'HEAD')).toBe(first);
    expect(gitIn(c, home, 'rev-parse', 'refs/azhi/base')).toBe(first);
  });

  it('write mode: git metadata stays out of the folder, and the next change is the total from the real base', async () => {
    const { c, home } = await clone(change(), { mode: 'write' });
    expect(existsSync(join(c.dir, '.git'))).toBe(false);
    expect(c.gitDir && existsSync(join(c.gitDir, 'HEAD'))).toBe(true);
    expect(c.head).toBe(first);

    // The continuing agent edits one more file and leaves the rest.
    writeFileSync(join(c.dir, 'NOTES.md'), 'more\n');
    const tree = await stageChange(c, home);
    const out = await collectChange(c, home, tree, { repo: 'acme/shop', ref: 'HEAD', tests: { status: 'not_run', command: '', exit_code: null, attempts: 0, output: '' } });
    expect(out.base_sha).toBe(first); // a commit that exists on the remote, not the local one
    expect(out.files.map((f) => f.path).sort()).toEqual(['NOTES.md', 'logo.bin', 'old.txt', 'run.sh', 'src/cart.js', 'src/cart.test.js']);
    expect(out.files.find((f) => f.path === 'run.sh')).toMatchObject({ status: 'modified', mode: '100755' });
    expect(out.files.find((f) => f.path === 'old.txt')).toMatchObject({ status: 'deleted' });
  });

  it('starts every attempt from a fresh checkout', async () => {
    const a = await clone(change());
    writeFileSync(join(a.c.dir, 'stray.txt'), 'left by attempt 1');
    const b = await clone(change());
    expect(existsSync(join(b.c.dir, 'stray.txt'))).toBe(false);
    expect(b.c.dir).not.toBe(a.c.dir);
  });

  it('refuses a change that does not match its base: modify a missing file, add an existing one, delete a missing one', async () => {
    const f = (x: Partial<ContinuationFile> & Pick<ContinuationFile, 'path' | 'status'>): ContinuationFile => ({ mode: '100644', encoding: 'utf-8', content: 'x\n', ...x });
    await expect(clone(change({ files: [f({ path: 'nope.txt', status: 'modified' })] }))).rejects.toThrow(/does not match its base_sha/);
    await expect(clone(change({ files: [f({ path: 'src/cart.js', status: 'added' })] }))).rejects.toThrow(/already in the base commit/);
    await expect(clone(change({ files: [f({ path: 'nope.txt', status: 'deleted' })] }))).rejects.toThrow(/does not match its base_sha/);
  });

  it('refuses base_ref together with a continuation, and a base that is not a full SHA', async () => {
    await expect(clone(change(), { baseRef: 'refs/heads/main' })).rejects.toThrow(/base_ref/);
    await expect(clone(change({ baseSha: 'main' }))).rejects.toThrow(/not a full commit SHA/);
    await expect(clone(change({ baseSha: first.slice(0, 12) }))).rejects.toThrow(/not a full commit SHA/);
  });

  it('rejects an unsafe path before anything is cloned or written', async () => {
    const step = join(root, `step${n}`);
    await expect(clone(change({ files: [{ path: '../escape.txt', status: 'added', mode: '100644', encoding: 'utf-8', content: 'x' }] }))).rejects.toThrow(/'\.\.' segment/);
    expect(existsSync(join(step, 'repo'))).toBe(false);
    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
  });
});

describe('resolveWorkspace', () => {
  const base = 'c'.repeat(40);
  const spec = { host: 'https://github.com', repo: 'acme/shop', ref: 'HEAD' };
  const api = (body: string | Error) => ({ raw: async () => (body instanceof Error ? Promise.reject(body) : Buffer.from(body)) });

  it('returns the spec unchanged when there is no continuation', async () => {
    expect(await resolveWorkspace(spec, api(new Error('must not be called')))).toEqual(spec);
  });

  it('fetches the artifact by hash and fills in the files', async () => {
    const asked: string[] = [];
    const files = [{ path: 'a.js', status: 'added', mode: '100644', content: 'x', encoding: 'utf-8' }];
    const client = { raw: async (p: string) => (asked.push(p), Buffer.from(JSON.stringify({ baseSha: base, files }))) };
    const r = await resolveWorkspace({ ...spec, continuation: { artifact: 'sha256:abc', baseSha: base } }, client);
    expect(asked).toEqual(['/v1/artifacts/sha256%3Aabc']);
    expect(r.continuation).toEqual({ baseSha: base, files });
    expect(r).toMatchObject(spec);
  });

  it('retries a fetch that failed, but not a change that is wrong', async () => {
    await expect(resolveWorkspace({ ...spec, continuation: { artifact: 'sha256:abc', baseSha: base } }, api(new Error('503')))).rejects.toMatchObject({ type: 'transient', nonRetryable: false });
    await expect(resolveWorkspace({ ...spec, continuation: { artifact: 'sha256:abc', baseSha: base } }, api('not json'))).rejects.toMatchObject({ type: 'invalid_input', nonRetryable: true });
    await expect(resolveWorkspace({ ...spec, continuation: { artifact: 'sha256:abc', baseSha: base } }, api(JSON.stringify({ baseSha: 'd'.repeat(40), files: [] })))).rejects.toThrow(/does not match the one the server prepared/);
    await expect(resolveWorkspace({ ...spec, continuation: { artifact: 'sha256:abc', baseSha: base } }, api(JSON.stringify({ baseSha: base })))).rejects.toThrow(/does not match/);
  });
});

describe('continuation path rules', () => {
  const BAD: Array<[string, RegExp]> = [
    ['', /empty/],
    ['/etc/passwd', /absolute/],
    ['../x', /'\.\.'/],
    ['a/../../x', /'\.\.'/],
    ['a/./b', /'\.'/],
    ['a//b', /empty segment/],
    ['a\\b', /backslash/],
    ['a\0b', /NUL/],
    ['a\nb', /control/],
    ['.git/config', /git metadata/],
    ['sub/.GIT/hooks/pre-commit', /git metadata/],
    ['GIT~1/config', /git metadata/],
    ['C:/Windows/x', /':'/],
    ['dir/file.txt:stream', /':'/],
    ['dir/name.', /dot or a space/],
    ['dir/name ', /dot or a space/],
    ['CON', /reserved/],
    ['dir/nul.txt', /reserved/],
    ['LPT1', /reserved/],
    ['x'.repeat(1025), /1024/],
  ];
  it.each(BAD)('rejects %j', (path, why) => {
    expect(unsafePath(path)).toMatch(why);
  });

  it.each(['a', 'src/cart.js', '.github/workflows/ci.yml', '.gitignore', '.gitattributes', 'dir/console.txt', 'a b/c d.txt', 'ünï/çödé.md', 'a.b.c/d'])('accepts %j', (path) => {
    expect(unsafePath(path)).toBeUndefined();
  });

  const sha = 'a'.repeat(40);
  const file = (path: string, over: Partial<ContinuationFile> = {}): ContinuationFile => ({ path, status: 'added', mode: '100644', encoding: 'utf-8', content: 'x', ...over });

  it('rejects case-insensitive duplicates and a file that is also a folder', () => {
    expect(() => validateContinuation({ baseSha: sha, files: [file('README.md'), file('readme.MD')] })).toThrow(/same path on a case-insensitive/);
    expect(() => validateContinuation({ baseSha: sha, files: [file('lib'), file('LIB/a.js')] })).toThrow(/both a file and a folder/);
    expect(() => validateContinuation({ baseSha: sha, files: [file('lib/a.js'), file('lib/b.js')] })).not.toThrow();
  });

  it('rejects odd modes, statuses and encodings, and a file with no content', () => {
    expect(() => validateContinuation({ baseSha: sha, files: [file('a', { mode: '120000' as never })] })).toThrow(/only regular files/);
    expect(() => validateContinuation({ baseSha: sha, files: [file('a', { status: 'renamed' as never })] })).toThrow(/status/);
    expect(() => validateContinuation({ baseSha: sha, files: [file('a', { encoding: 'latin1' as never })] })).toThrow(/encoding/);
    expect(() => validateContinuation({ baseSha: sha, files: [file('a', { content: undefined })] })).toThrow(/no content/);
    expect(() => validateContinuation({ baseSha: sha, files: [file('a', { status: 'deleted', content: undefined })] })).not.toThrow();
  });

  it('enforces the ceiling a step may hand on', () => {
    const many = Array.from({ length: 301 }, (_, i) => file(`f${i}.txt`));
    expect(() => validateContinuation({ baseSha: sha, files: many })).toThrow(/at most 300/);
    expect(() => validateContinuation({ baseSha: sha, files: [file('big.txt', { content: 'x'.repeat(1_000_001) })] })).toThrow(/1000000 bytes/);
    // Counted as decoded bytes, not as the length of the base64 text.
    const b64 = Buffer.alloc(1_000_001, 1).toString('base64');
    expect(() => validateContinuation({ baseSha: sha, files: [file('big.bin', { encoding: 'base64', content: b64 })] })).toThrow(/1000000 bytes/);
    expect(() => validateContinuation({ baseSha: sha, files: [file('ok.bin', { encoding: 'base64', content: Buffer.alloc(900_000, 1).toString('base64') })] })).not.toThrow();
  });

  it('refuses to write below a file, as if it were a folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-cont-plain-'));
    try {
      writeFileSync(join(dir, 'plain'), 'x');
      expect(() => applyContinuation(dir, [file('plain/x.txt')])).toThrow(/file, not a folder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(win)('refuses to write through a symbolic link', () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-cont-links-'));
    const outside = mkdtempSync(join(tmpdir(), 'azhi-cont-outside-'));
    try {
      symlinkSync(outside, join(dir, 'link'));
      expect(() => applyContinuation(dir, [file('link/evil.txt')])).toThrow(/symbolic link, not a folder/);
      expect(existsSync(join(outside, 'evil.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
