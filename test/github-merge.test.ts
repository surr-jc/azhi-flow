import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executorFor } from '../src/gateway/executors.js';
import type { ToolSpec } from '../src/gateway/types.js';
import { startFakeGithub } from '../src/testing/fake-github.js';

/**
 * The PR review's optional merge step: it merges only the commit the reviewers read, refuses a pull
 * request that moved, closed, is a draft or conflicts, treats an already merged one as done, and
 * takes the merge method from the registration, never from the arguments.
 */
const TOKEN = 'ghp_merge_write_1';
const HEAD = 'a'.repeat(40);
const spec = (url: string, method?: string): ToolSpec =>
  ({ id: 'github.merge-pr', version: 1, description: 'merge', effect: 'write-idempotent', source: 'github', transport: { kind: 'builtin', name: 'github.merge-pr', config: { repos: ['acme/shop'], api_url: url, ...(method ? { merge_method: method } : {}) } }, input_schema: { type: 'object' }, output_schema: { type: 'object' } }) as ToolSpec;
const pull = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `PR ${number}`, base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: `f${number}`, sha: HEAD }, files: [], ...extra });

describe('github merge-pr', () => {
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  const run = (s: ToolSpec, args: Record<string, unknown>) => executorFor(s).call(s, args, { credential: TOKEN, idempotencyKey: 'act_1', timeoutMs: 5000 });

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    gh = await startFakeGithub({ runs: [], issues: [], pulls: [pull(1), pull(2), pull(3, { state: 'closed' }), pull(4, { draft: true }), pull(5, { mergeable: false, mergeable_state: 'dirty' }), pull(6, { state: 'closed', merged: true }), pull(7)] }, { token: TOKEN });
  });
  afterAll(async () => {
    delete process.env.AZHI_EGRESS_ALLOW;
    await gh.stop();
  });

  it('merges the reviewed commit with the registered method (squash by default)', async () => {
    const r = (await run(spec(gh.url), { repo: 'acme/shop', number: 1, sha: HEAD })).value as any;
    expect(r).toMatchObject({ merged: true, already_merged: false });
    expect(gh.merges).toEqual([{ repo: 'acme/shop', number: 1, sha: HEAD, method: 'squash' }]);
  });

  it('uses the registered merge_method and ignores one in the arguments', async () => {
    await run(spec(gh.url, 'rebase'), { repo: 'acme/shop', number: 2, sha: HEAD, merge_method: 'merge' });
    expect(gh.merges.at(-1)).toMatchObject({ number: 2, method: 'rebase' });
  });

  it('treats a pull request that is already merged as done, without merging again', async () => {
    const before = gh.merges.length;
    expect((await run(spec(gh.url), { repo: 'acme/shop', number: 6, sha: HEAD })).value).toMatchObject({ merged: true, already_merged: true });
    expect(gh.merges).toHaveLength(before);
  });

  it('refuses a head that moved since the review, a closed, a draft and a conflicting pull request', async () => {
    const before = gh.merges.length;
    await expect(run(spec(gh.url), { repo: 'acme/shop', number: 3, sha: HEAD })).rejects.toThrow(/closed/);
    await expect(run(spec(gh.url), { repo: 'acme/shop', number: 4, sha: HEAD })).rejects.toThrow(/draft/);
    await expect(run(spec(gh.url), { repo: 'acme/shop', number: 5, sha: HEAD })).rejects.toThrow(/405/);
    await expect(run(spec(gh.url), { repo: 'acme/shop', number: 7, sha: 'c'.repeat(40) })).rejects.toThrow(/new commits/);
    expect(gh.merges).toHaveLength(before);
  });

  it('refuses a missing or short sha, an unlisted repository and an unknown merge method', async () => {
    await expect(run(spec(gh.url), { repo: 'acme/shop', number: 1 })).rejects.toThrow(/sha/);
    await expect(run(spec(gh.url), { repo: 'acme/other', number: 1, sha: HEAD })).rejects.toThrow(/not one of the repositories/);
    await expect(run(spec(gh.url, 'fast-forward'), { repo: 'acme/shop', number: 1, sha: HEAD })).rejects.toThrow(/merge_method/);
  });
});
