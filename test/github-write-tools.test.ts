import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executorFor } from '../src/gateway/executors.js';
import type { SendError } from '../src/gateway/ledger.js';
import { branchName, pushBranch } from '../src/gateway/tools/github.js';
import type { ToolSpec } from '../src/gateway/types.js';
import { startFakeGithub } from '../src/testing/fake-github.js';

/**
 * The write tools of the SDLC implement example against a local stand-in for GitHub: a change becomes
 * one commit on an `azhi/` branch through the Git Data API, a re-run moves the branch only when Azhi
 * made it, the ledger finds a push by its action ID, and the pull request is opened once per branch.
 */
const READ = 'ghp_read_only_7';
const WRITE = 'ghp_contents_write_8';
const BASE = 'a'.repeat(40);

const spec = (name: string): ToolSpec =>
  ({ id: name, version: 1, effect: 'write-dedupable', source: 'github', transport: { kind: 'builtin', name, config: { repos: ['acme/shop'], api_url: '' } }, input_schema: { type: 'object' }, output_schema: { type: 'object' } }) as unknown as ToolSpec;

describe('github write tools', () => {
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  let push: ToolSpec;
  let pr: ToolSpec;
  const files = [
    { path: 'src/cart.js', status: 'modified', mode: '100644', content: 'export const total = 1;\n', encoding: 'utf-8' },
    { path: 'test/cart.test.js', status: 'added', mode: '100644', content: 'test("total", () => {});\n', encoding: 'utf-8' },
    { path: 'old.txt', status: 'deleted', mode: '100644' },
  ];
  const call = (s: ToolSpec, args: Record<string, unknown>, key: string, credential = WRITE) => executorFor(s).call(s, args, { credential, idempotencyKey: key, timeoutMs: 5000 });

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    gh = await startFakeGithub({ runs: [], issues: [] }, { token: [READ, WRITE], defaultBranch: 'trunk', refs: { 'azhi/someone-else': { sha: 'b'.repeat(40), message: 'hand-made' } } });
    push = spec('github.push-branch');
    pr = spec('github.create-pull-request');
    for (const s of [push, pr]) (s.transport as any).config.api_url = gh.url;
  });
  afterAll(async () => {
    delete process.env.AZHI_EGRESS_ALLOW;
    await gh.stop();
  });

  it('makes branch names git-safe and keeps them under the prefix', () => {
    expect(branchName({}, 'azhi/acme/shop#42')).toBe('azhi/acme/shop-42');
    expect(branchName({}, 'azhi/PAY-142 Retry..timeouts')).toBe('azhi/pay-142-retry.timeouts');
    expect(() => branchName({}, 'main')).toThrow(/must start with azhi\//);
    expect(() => branchName({}, 'azhi/')).toThrow(/needs a name/);
    expect(branchName({ branch_prefix: 'bot/' }, 'bot/x')).toBe('bot/x');
  });

  it('commits the change onto the base commit and creates the branch', async () => {
    const r = (await call(push, { repo: 'acme/shop', branch: 'azhi/acme/shop#42', base_sha: BASE, message: 'Apply the cart discount', files }, 'act-1')).value as any;
    expect(r).toMatchObject({ repo: 'acme/shop', branch: 'azhi/acme/shop-42', base_sha: BASE, files: 3, created: true, url: 'https://github.com/acme/shop/tree/azhi/acme/shop-42' });
    expect(gh.branchFiles('azhi/acme/shop-42')).toEqual({ 'src/cart.js': 'export const total = 1;\n', 'test/cart.test.js': 'test("total", () => {});\n', 'old.txt': null });
    const commit = gh.git.commits.get(r.commit_sha)!;
    expect(commit.parents).toEqual([BASE]);
    expect(commit.message).toBe('Apply the cart discount\n\nAzhi-Action: act-1');
    expect(gh.git.trees.get(commit.tree)!.base_tree).toBe(`tree-${BASE}`);
  });

  describe('with a merge_parent', () => {
    const HEAD = 'c'.repeat(40);
    const one = [{ path: 'a.txt', status: 'modified', content: 'a\n' }];
    const blobPosts = (from: number) => gh.requests.slice(from).filter((r) => r.startsWith('POST /repos/acme/shop/git/blobs')).length;

    it('makes a merge commit of [base, merge_parent], base first, and finds it again by its action ID', async () => {
      const args = { repo: 'acme/shop', branch: 'azhi/merge-ok', base_sha: BASE, merge_parent: HEAD, message: 'Resolve', files: one };
      const r = (await call(push, args, 'act-m1')).value as any;
      const commit = gh.git.commits.get(r.commit_sha)!;
      expect(commit.parents).toEqual([BASE, HEAD]);
      expect(commit.message).toBe('Resolve\n\nAzhi-Action: act-m1');
      expect(gh.git.trees.get(commit.tree)!.base_tree).toBe(`tree-${BASE}`);
      expect(r).toMatchObject({ base_sha: BASE, created: true });
      const found = await executorFor(push).lookup!(push, args, 'act-m1', new Date(), { credential: WRITE, timeoutMs: 5000 });
      expect(found?.value).toMatchObject({ commit_sha: r.commit_sha, base_sha: BASE });
      // A retry under a new action ID moves Azhi's own branch to another two-parent commit.
      const again = (await call(push, args, 'act-m2')).value as any;
      expect(again.created).toBe(false);
      expect(gh.git.commits.get(again.commit_sha)!.parents).toEqual([BASE, HEAD]);
      expect(gh.git.refs.get('azhi/merge-ok')).toBe(again.commit_sha);
    });

    it('keeps a single parent without it, and treats null as absent', async () => {
      const r = (await call(push, { repo: 'acme/shop', branch: 'azhi/merge-none', base_sha: BASE, message: 'x', files: one }, 'act-m3')).value as any;
      expect(gh.git.commits.get(r.commit_sha)!.parents).toEqual([BASE]);
      const n = (await call(push, { repo: 'acme/shop', branch: 'azhi/merge-null', base_sha: BASE, merge_parent: null, message: 'x', files: one }, 'act-m4')).value as any;
      expect(gh.git.commits.get(n.commit_sha)!.parents).toEqual([BASE]);
    });

    it('writes nothing for a malformed merge_parent or one equal to base_sha', async () => {
      const from = gh.requests.length;
      for (const bad of ['abc123', 'z'.repeat(40), HEAD.toUpperCase(), 'main', BASE]) {
        await expect(call(push, { repo: 'acme/shop', branch: 'azhi/merge-bad', base_sha: BASE, merge_parent: bad, message: 'x', files: one }, 'act-m5')).rejects.toThrow(/merge_parent/);
      }
      expect(gh.requests.slice(from).filter((r) => r.startsWith('POST'))).toEqual([]);
      expect(gh.git.refs.has('azhi/merge-bad')).toBe(false);
    });

    it('writes nothing when the merge_parent commit does not exist in the repository', async () => {
      const from = gh.requests.length;
      gh.faults.push({ on: `GET /repos/acme/shop/git/commits/${HEAD}`, status: 404, times: 1 });
      const err = await call(push, { repo: 'acme/shop', branch: 'azhi/merge-missing', base_sha: BASE, merge_parent: HEAD, message: 'x', files: one }, 'act-m6').catch((e: SendError) => e);
      gh.faults.length = 0;
      expect(err).toMatchObject({ definite: true, errorClass: 'invalid_input' });
      expect((err as Error).message).toMatch(/merge_parent cccccccccccc is not a commit in acme\/shop/);
      expect(blobPosts(from)).toBe(0);
      expect(gh.requests.slice(from).filter((r) => r.startsWith('POST'))).toEqual([]);
      expect(gh.git.refs.has('azhi/merge-missing')).toBe(false);
    });

    it('still refuses a branch outside the prefix and a branch Azhi did not make', async () => {
      await expect(call(push, { repo: 'acme/shop', branch: 'feature/x', base_sha: BASE, merge_parent: HEAD, message: 'x', files: one }, 'act-m7')).rejects.toThrow(/must start with azhi\//);
      await expect(call(push, { repo: 'acme/shop', branch: 'azhi/someone-else', base_sha: BASE, merge_parent: HEAD, message: 'x', files: one }, 'act-m8')).rejects.toThrow(/not made by Azhi/);
    });
  });

  it('is found again by its action ID, and a re-run moves its own branch', async () => {
    const found = await executorFor(push).lookup!(push, { repo: 'acme/shop', branch: 'azhi/acme/shop#42', base_sha: BASE, files }, 'act-1', new Date(), { credential: WRITE, timeoutMs: 5000 });
    expect(found?.value).toMatchObject({ branch: 'azhi/acme/shop-42' });
    expect(await executorFor(push).lookup!(push, { repo: 'acme/shop', branch: 'azhi/acme/shop#42' }, 'act-other', new Date(), { credential: WRITE, timeoutMs: 5000 })).toBeNull();
    const again = (await call(push, { repo: 'acme/shop', branch: 'azhi/acme/shop#42', base_sha: BASE, message: 'Apply the discount, second try', files: files.slice(0, 1) }, 'act-2')).value as any;
    expect(again.created).toBe(false);
    expect(gh.git.refs.get('azhi/acme/shop-42')).toBe(again.commit_sha);
  });

  it('refuses branches it did not make, other repositories, bad paths and the read-only token', async () => {
    await expect(call(push, { repo: 'acme/shop', branch: 'azhi/someone-else', base_sha: BASE, message: 'x', files }, 'k1')).rejects.toThrow(/not made by Azhi/);
    await expect(call(push, { repo: 'acme/other', branch: 'azhi/x', base_sha: BASE, message: 'x', files }, 'k2')).rejects.toThrow(/not one of the repositories/);
    await expect(call(push, { repo: 'acme/shop', branch: 'main', base_sha: BASE, message: 'x', files }, 'k3')).rejects.toThrow(/must start with azhi\//);
    for (const path of ['../etc/passwd', '.git/config', '/abs', 'a//b']) {
      await expect(call(push, { repo: 'acme/shop', branch: 'azhi/x', base_sha: BASE, message: 'x', files: [{ path, status: 'added', content: 'x' }] }, 'k4')).rejects.toThrow(/not a plain path/);
    }
    await expect(call(push, { repo: 'acme/shop', branch: 'azhi/x', base_sha: BASE, message: 'x', files: [{ path: 'link', status: 'added', mode: '120000', content: '/etc' }] }, 'k5')).rejects.toThrow(/only regular files/);
    await expect(call(push, { repo: 'acme/shop', branch: 'azhi/x', base_sha: BASE, message: 'x', files: [] }, 'k6')).rejects.toThrow(/no changed files/);
    await expect(call(push, { repo: 'acme/shop', branch: 'azhi/x', base_sha: BASE, message: 'x', files }, 'k7', READ)).rejects.toThrow(/403/);
    expect(gh.git.refs.has('azhi/x')).toBe(false);
  });

  describe('when GitHub answers 5xx while the objects are made', () => {
    const one = [{ path: 'a.txt', status: 'added', content: 'a\n' }];
    const run = async (branch: string, faults: Array<{ on: string; status: number; times: number }>) => {
      const cfg = { repos: ['acme/shop'], api_url: gh.url };
      const from = gh.requests.length;
      gh.faults.push(...faults);
      const outcome: { error?: SendError } = await pushBranch(cfg, { repo: 'acme/shop', branch, base_sha: BASE, message: 'x', files: one }, WRITE, 'act-r', 5000, [1, 1, 1]).then(
        () => ({}),
        (error: SendError) => ({ error }),
      );
      gh.faults.length = 0;
      return { ...outcome, calls: (path: string) => gh.requests.slice(from).filter((r) => r.startsWith(`POST /repos/acme/shop/git/${path}`)).length };
    };

    it.each(['blobs', 'trees', 'commits'])('repeats a %s call that failed once and completes the push', async (what) => {
      const r = await run(`azhi/retry-${what}`, [{ on: `POST /repos/acme/shop/git/${what}`, status: 500, times: 1 }]);
      expect(r.error).toBeUndefined();
      expect(r.calls(what)).toBe(2);
      expect(r.calls('refs')).toBe(1);
      expect(gh.branchFiles(`azhi/retry-${what}`)).toEqual({ 'a.txt': 'a\n' });
    });

    it('gives up after four tries as a transient failure that names the call', async () => {
      const r = await run('azhi/retry-never', [{ on: 'POST /repos/acme/shop/git/blobs', status: 502, times: 99 }]);
      expect(r.error?.definite).toBe(false);
      expect(r.error?.errorClass).toBe('transient');
      expect(r.error?.status).toBe(502);
      expect(r.error?.message).toMatch(/^GitHub HTTP 502: \(empty response to POST \/repos\/acme\/shop\/git\/blobs, request id FAKE:0001\)/);
      expect(r.calls('blobs')).toBe(4);
      expect(r.calls('trees')).toBe(0);
      expect(gh.git.refs.has('azhi/retry-never')).toBe(false);
    });

    it('does not repeat a 4xx answer', async () => {
      const r = await run('azhi/retry-422', [{ on: 'POST /repos/acme/shop/git/blobs', status: 422, times: 99 }]);
      expect(r.error?.definite).toBe(true);
      expect(r.error?.message).toMatch(/GitHub HTTP 422/);
      expect(r.calls('blobs')).toBe(1);
    });

    it('sends the ref once, and does not make another when it fails', async () => {
      const r = await run('azhi/retry-ref', [{ on: 'POST /repos/acme/shop/git/refs', status: 500, times: 99 }]);
      expect(r.error?.definite).toBe(false);
      expect(r.calls('refs')).toBe(1);
      expect(r.calls('blobs')).toBe(1);
    });

    it('stops repeating when the time budget cannot cover the wait', async () => {
      gh.faults.push({ on: 'POST /repos/acme/shop/git/blobs', status: 500, times: 99 });
      const from = gh.requests.length;
      await expect(pushBranch({ repos: ['acme/shop'], api_url: gh.url }, { repo: 'acme/shop', branch: 'azhi/retry-budget', base_sha: BASE, message: 'x', files: one }, WRITE, 'act-b', 5000, [60_000])).rejects.toThrow(/GitHub HTTP 500/);
      gh.faults.length = 0;
      expect(gh.requests.slice(from).filter((r) => r.startsWith('POST /repos/acme/shop/git/blobs'))).toHaveLength(1);
    });
  });

  it('opens one pull request per branch, against the default branch unless told', async () => {
    const r = (await call(pr, { repo: 'acme/shop', head: 'azhi/acme/shop#42', base: '', title: 'Apply the cart discount', body: 'Fixes the discount.', draft: false }, 'pr-1')).value as any;
    expect(r).toMatchObject({ number: 101, head: 'azhi/acme/shop-42', base: 'trunk', created: true, url: 'https://github.com/acme/shop/pull/101' });
    expect(gh.git.pulls[0]!.body).toContain('Fixes the discount.\n\n<!-- azhi-action:pr-1 -->');
    const again = (await call(pr, { repo: 'acme/shop', head: 'azhi/acme/shop#42', title: 'Again', body: '' }, 'pr-2')).value as any;
    expect(again).toMatchObject({ number: 101, created: false });
    expect(gh.git.pulls).toHaveLength(1);
    const found = await executorFor(pr).lookup!(pr, { repo: 'acme/shop', head: 'azhi/acme/shop#42' }, 'pr-1', new Date(), { credential: WRITE, timeoutMs: 5000 });
    expect(found?.value).toMatchObject({ number: 101 });
    await expect(call(pr, { repo: 'acme/shop', head: 'feature/x', title: 't' }, 'pr-3')).rejects.toThrow(/must start with azhi\//);
  });
});
