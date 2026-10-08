import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executorFor } from '../src/gateway/executors.js';
import { branchName } from '../src/gateway/tools/github.js';
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
