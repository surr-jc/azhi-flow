import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executorFor } from '../src/gateway/executors.js';
import type { ToolSpec } from '../src/gateway/types.js';
import { startFakeGithub } from '../src/testing/fake-github.js';

/**
 * The PR review comment with `sticky` set: the first run posts it, every later run edits that same
 * comment, a retry of a run finds the comment by its action, and a comment someone else wrote with the
 * marker pasted in is never edited. Without `sticky`, every run posts a new comment as before.
 */
const TOKEN = 'ghp_comment_write_3';
const spec = (url: string, sticky?: string): ToolSpec =>
  ({ id: 'github.comment-on-pr', version: 1, description: 'comment', effect: 'write-dedupable', source: 'github', transport: { kind: 'builtin', name: 'github.pr-comment', config: { repos: ['acme/shop'], api_url: url, ...(sticky ? { sticky } : {}) } }, input_schema: { type: 'object' }, output_schema: { type: 'object' } }) as ToolSpec;

describe('github PR comment, sticky', () => {
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  const run = (s: ToolSpec, args: Record<string, unknown>, key: string) => executorFor(s).call(s, args, { credential: TOKEN, idempotencyKey: key, timeoutMs: 5000 });
  const find = (s: ToolSpec, args: Record<string, unknown>, key: string) => executorFor(s).lookup!(s, args, key, new Date(0), { credential: TOKEN, idempotencyKey: key, timeoutMs: 5000 });
  const on = (n: number) => gh.comments.filter((c) => c.number === n);

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    gh = await startFakeGithub(
      { runs: [], issues: [] },
      // On PR 9 someone else pasted the marker into their own comment.
      { token: TOKEN, comments: [{ id: 500, repo: 'acme/shop', number: 9, body: 'mine <!-- azhi-sticky:azhi-pr-review -->', user: 'mallory' }, { id: 501, repo: 'acme/shop', number: 17, body: `x <!-- azhi-sticky:azhi-pr-review --> <!-- azhi-reviewed:${'c'.repeat(64)} -->`, user: 'mallory' }] },
    );
  });
  afterAll(async () => {
    delete process.env.AZHI_EGRESS_ALLOW;
    await gh.stop();
  });

  it('posts the review the first time and edits that comment on every later run', async () => {
    const s = spec(gh.url, 'azhi-pr-review');
    const first = (await run(s, { repo: 'acme/shop', number: 7, body: 'Review 1' }, 'act_run_1')).value as any;
    expect(first).toMatchObject({ updated: false });
    const second = (await run(s, { repo: 'acme/shop', number: 7, body: 'Review 2' }, 'act_run_2')).value as any;
    expect(second).toMatchObject({ id: first.id, updated: true });
    expect(on(7)).toHaveLength(1);
    expect(on(7)[0]).toMatchObject({ edits: 1 });
    // The edited comment holds only the latest review and the latest run's action.
    expect(on(7)[0]!.body).toContain('Review 2');
    expect(on(7)[0]!.body).not.toContain('Review 1');
    expect(on(7)[0]!.body).toContain('<!-- azhi-action:act_run_2 -->');
    expect(on(7)[0]!.body).not.toContain('act_run_1');
    expect(on(7)[0]!.body).toContain('<!-- azhi-sticky:azhi-pr-review -->');
  });

  it("finds the edited comment by the latest run's action, so a retry sends nothing", async () => {
    const s = spec(gh.url, 'azhi-pr-review');
    expect((await find(s, { repo: 'acme/shop', number: 7 }, 'act_run_2'))?.value).toMatchObject({ id: on(7)[0]!.id });
    expect(await find(s, { repo: 'acme/shop', number: 7 }, 'act_run_1')).toBeNull();
  });

  it('never edits a comment by someone else that carries the marker; it posts its own', async () => {
    const s = spec(gh.url, 'azhi-pr-review');
    const r = (await run(s, { repo: 'acme/shop', number: 9, body: 'Review' }, 'act_run_9')).value as any;
    expect(r).toMatchObject({ updated: false });
    expect(gh.comments.find((c) => c.id === 500)).toMatchObject({ body: 'mine <!-- azhi-sticky:azhi-pr-review -->' });
    expect(gh.comments.find((c) => c.id === 500)!.edits).toBeUndefined();
    expect(on(9)).toHaveLength(2);
    // The next run edits the comment it posted, still not the other one.
    expect((await run(s, { repo: 'acme/shop', number: 9, body: 'Review again' }, 'act_run_10')).value).toMatchObject({ id: r.id, updated: true });
  });

  it('posts a new comment every run when sticky is not set', async () => {
    const s = spec(gh.url);
    await run(s, { repo: 'acme/shop', number: 11, body: 'A' }, 'act_a');
    await run(s, { repo: 'acme/shop', number: 11, body: 'B' }, 'act_b');
    expect(on(11)).toHaveLength(2);
    expect(on(11).every((c) => !c.body.includes('azhi-sticky'))).toBe(true);
  });

  it('reads back what the sticky review says it reviewed: found or not, and its fingerprint, from its own account only', async () => {
    const s = spec(gh.url, 'azhi-pr-review');
    const sticky = { ...s, id: 'github.pr-sticky', effect: 'read', transport: { ...s.transport, name: 'github.pr-sticky' } } as ToolSpec;
    const read = async (n: number) => (await executorFor(sticky).call(sticky, { repo: 'acme/shop', number: n }, { credential: TOKEN, timeoutMs: 5000 })).value as any;
    const fp = 'a'.repeat(63) + 'b';
    expect(await read(13)).toEqual({ found: false, id: 0, url: '', fingerprint: '', updated_at: '' });
    const posted = (await run(s, { repo: 'acme/shop', number: 13, body: `Review <!-- azhi-reviewed:${fp} -->` }, 'act_r13')).value as any;
    expect(await read(13)).toMatchObject({ found: true, id: posted.id, fingerprint: fp });
    // A later run's review replaces the fingerprint; a review without one reads as an empty fingerprint.
    await run(s, { repo: 'acme/shop', number: 13, body: 'Review without a marker' }, 'act_r13b');
    expect(await read(13)).toMatchObject({ found: true, id: posted.id, fingerprint: '' });
    // Someone else's comment with the sticky and reviewed markers pasted in is not this review.
    expect(await read(17)).toMatchObject({ found: false, fingerprint: '' });
    // A marker that is not 64 hex digits is ignored.
    await run(s, { repo: 'acme/shop', number: 15, body: 'x <!-- azhi-reviewed:abc -->' }, 'act_r15');
    expect((await read(15)).fingerprint).toBe('');
    // The tool needs the sticky name, so it can only look at the comment the comment tool keeps.
    const bare = { ...sticky, transport: { ...sticky.transport, config: { repos: ['acme/shop'], api_url: gh.url } } } as ToolSpec;
    await expect(executorFor(bare).call(bare, { repo: 'acme/shop', number: 13 }, { credential: TOKEN, timeoutMs: 5000 })).rejects.toThrow(/sticky/);
  });
});
