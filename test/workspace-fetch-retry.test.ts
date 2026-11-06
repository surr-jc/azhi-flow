import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGit } from '../src/testing/fake-git.js';
import { cloneWorkspace, type WorkspaceSpec } from '../src/worker/workspace.js';

/**
 * The fetch of a workspace is retried when the connection drops (a real transport failure from the fake git host),
 * at most three attempts within one time budget, and never for a missing ref, a refused token or a cancellation.
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('workspace fetch retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'azhi-ws-retry-'));
  let sha = '';
  const servers: Array<Awaited<ReturnType<typeof startFakeGit>>> = [];

  beforeAll(() => {
    const work = join(root, 'work');
    mkdirSync(work, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'd@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'd@example.com' };
    const g = (...a: string[]) => execFileSync('git', a, { cwd: work, env }).toString().trim();
    g('init', '-q', '-b', 'main', '.');
    writeFileSync(join(work, 'a.txt'), 'hello\n');
    g('add', '.');
    g('commit', '-qm', 'start');
    sha = g('rev-parse', 'HEAD');
    mkdirSync(join(root, 'srv/acme'), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', work, join(root, 'srv/acme/shop.git')], { env });
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    rmSync(root, { recursive: true, force: true });
  });

  let n = 0;
  const run = async (opts: { dropFetches: number; token?: string; ref?: string; sendToken?: string; signal?: AbortSignal; waits?: number[]; timeoutMs?: number; onServer?: (git: Awaited<ReturnType<typeof startFakeGit>>) => void }) => {
    const git = await startFakeGit(join(root, 'srv'), { dropFetches: opts.dropFetches, ...(opts.token ? { token: opts.token } : {}) });
    servers.push(git);
    opts.onServer?.(git);
    const step = join(root, `step${n++}`);
    const home = join(step, 'home');
    mkdirSync(home, { recursive: true });
    const spec: WorkspaceSpec = { host: git.url, repo: 'acme/shop', ref: opts.ref ?? 'refs/heads/main', credential: 'x' };
    const result = await cloneWorkspace(spec, { root: step, home, ...(opts.sendToken ? { token: opts.sendToken } : {}), timeoutMs: opts.timeoutMs ?? 60_000, ...(opts.signal ? { signal: opts.signal } : {}), fetchRetryWaitsMs: opts.waits ?? [50, 50] }).then(
      (c) => ({ c, error: undefined }),
      (error: unknown) => ({ c: undefined, error }),
    );
    return { git, ...result, step };
  };

  it('retries a dropped connection and checks out the right commit', async () => {
    const { git, c, error } = await run({ dropFetches: 2 });
    expect(error).toBeUndefined();
    expect(git.packRequests).toBe(3);
    expect(c!.head).toBe(sha);
    expect(readFileSync(join(c!.dir, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(c!.dir, '.git'))).toBe(true);
  });

  it('gives up after three attempts with the last failure, still retryable', async () => {
    const { git, error } = await run({ dropFetches: 10 });
    expect(git.packRequests).toBe(3);
    expect(error).toBeInstanceOf(ApplicationFailure);
    const f = error as ApplicationFailure;
    expect(f.message).toMatch(/^git fetch failed:/);
    expect(f.nonRetryable).toBe(false);
    expect(f.type).toBe('transient');
  });

  it('makes one attempt for a missing ref', async () => {
    const { git, error } = await run({ dropFetches: 0, ref: 'refs/heads/nope' });
    expect(git.packRequests).toBe(0);
    expect((error as ApplicationFailure).message).toMatch(/^git fetch failed:.*couldn't find remote ref/s);
    // One ref listing only: a retry would have listed again.
    expect(git.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('makes one attempt for a refused credential, and it is final', async () => {
    const { git, error } = await run({ dropFetches: 0, token: 'ghp_good', sendToken: 'ghp_bad' });
    const f = error as ApplicationFailure;
    expect(f.nonRetryable).toBe(true);
    expect(f.message).not.toContain('ghp_bad');
    // One attempt asks the info/refs endpoint once; a retry would ask again.
    expect(git.requests.filter((r) => r.url.includes('info/refs'))).toHaveLength(1);
  });

  it('stops retrying when the signal aborts', async () => {
    const ac = new AbortController();
    const { git, error } = await run({ dropFetches: 10, signal: ac.signal, waits: [30_000, 30_000], onServer: (g) => {
      // Abort once the first attempt has been dropped, while the wait before the second is running.
      const timer = setInterval(() => g.packRequests >= 1 && (clearInterval(timer), setTimeout(() => ac.abort(), 500)), 20);
    } });
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(git.packRequests).toBe(1);
  }, 20_000);

  it('makes no new attempt when the budget is used up', async () => {
    const { git, error } = await run({ dropFetches: 10, waits: [5_000, 5_000], timeoutMs: 3_000 });
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(git.packRequests).toBe(1);
  });
});
