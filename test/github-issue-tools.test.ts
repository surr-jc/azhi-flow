import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executorFor } from '../src/gateway/executors.js';
import type { ToolSpec } from '../src/gateway/types.js';
import { startFakeGithub } from '../src/testing/fake-github.js';

/**
 * The issue splitter's tools against a local stand-in for GitHub: an issue is created once per ledger
 * action (a retry finds it by its marker), is linked under its parent when GitHub supports sub-issues
 * and reported as not linked when it does not, and labels are added without duplicates.
 */
const TOKEN = 'ghp_issues_write_9';
const spec = (name: string, url: string, effect: ToolSpec['effect']): ToolSpec =>
  ({ id: name, version: 1, description: name, effect, source: 'github', transport: { kind: 'builtin', name, config: { repos: ['acme/shop'], api_url: url } }, input_schema: { type: 'object' }, output_schema: { type: 'object' } }) as ToolSpec;

describe('github issue tools', () => {
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  let old: Awaited<ReturnType<typeof startFakeGithub>>;
  const run = (s: ToolSpec, args: Record<string, unknown>, key = 'act_1') => executorFor(s).call(s, args, { credential: TOKEN, idempotencyKey: key, timeoutMs: 5000 });
  const find = (s: ToolSpec, args: Record<string, unknown>, key: string) => executorFor(s).lookup!(s, args, key, new Date(0), { credential: TOKEN, idempotencyKey: key, timeoutMs: 5000 });

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    gh = await startFakeGithub({ runs: [], issues: [{ number: 27, repo: 'acme/shop', title: 'Big ticket', labels: [], body: 'a lot' }] }, { token: TOKEN });
    old = await startFakeGithub({ runs: [], issues: [{ number: 5, repo: 'acme/shop', title: 'Parent', labels: [] }] }, { token: TOKEN, noSubIssues: true });
  });
  afterAll(async () => {
    delete process.env.AZHI_EGRESS_ALLOW;
    await gh.stop();
    await old.stop();
  });

  it('creates an issue under its parent, with labels and a hidden marker in the body', async () => {
    const s = spec('github.create-issue', gh.url, 'write-dedupable');
    const r = (await run(s, { repo: 'acme/shop', title: '  Slice 1:   toggles ', body: 'Part of #27', labels: ['azhi-split', 'ready'], parent: 27 }, 'act_slice_1')).value as any;
    expect(r).toMatchObject({ repo: 'acme/shop', number: 100, title: 'Slice 1: toggles', parent: 27, linked: true, created: true });
    expect(gh.created[0]).toMatchObject({ labels: ['azhi-split', 'ready'] });
    expect(gh.created[0]!.body).toContain('Part of #27');
    expect(gh.created[0]!.body).toContain('<!-- azhi-action:act_slice_1 -->');
    expect(gh.links).toEqual([{ repo: 'acme/shop', parent: 27, child: r.id }]);
  });

  it('finds the issue again by its action, so a retry creates nothing, and keeps it linked', async () => {
    const s = spec('github.create-issue', gh.url, 'write-dedupable');
    const before = gh.created.length;
    const hit = (await find(s, { repo: 'acme/shop', parent: 27 }, 'act_slice_1'))!.value as any;
    expect(hit).toMatchObject({ number: 100, created: false, linked: true });
    expect(gh.created).toHaveLength(before);
    expect(await find(s, { repo: 'acme/shop', parent: 27 }, 'act_never_sent')).toBeNull();
  });

  it('creates a plain issue when there is no parent', async () => {
    const s = spec('github.create-issue', gh.url, 'write-dedupable');
    const r = (await run(s, { repo: 'acme/shop', title: 'From text', body: 'b' }, 'act_plain')).value as any;
    expect(r).toMatchObject({ parent: null, linked: false, link_error: '' });
  });

  it('reports a failed link instead of failing, because the issue already exists', async () => {
    const s = spec('github.create-issue', old.url, 'write-dedupable');
    const r = (await run(s, { repo: 'acme/shop', title: 'Child', body: 'Part of #5', parent: 5 }, 'act_old')).value as any;
    expect(r).toMatchObject({ created: true, linked: false, parent: 5 });
    expect(r.link_error).toMatch(/404/);
    expect(old.created).toHaveLength(1);
  });

  it('refuses a repository it was not registered for, an empty title and a bad label', async () => {
    const s = spec('github.create-issue', gh.url, 'write-dedupable');
    await expect(run(s, { repo: 'evil/other', title: 'x' })).rejects.toThrow(/not one of the repositories/);
    await expect(run(s, { repo: 'acme/shop', title: '   ' })).rejects.toThrow(/title is empty/);
    await expect(run(s, { repo: 'acme/shop', title: 'x', labels: ['a,b'] })).rejects.toThrow(/not a label name/);
    await expect(run(s, { repo: 'acme/shop', title: 'x', labels: Array(11).fill('l') })).rejects.toThrow(/at most 10/);
  });

  it('adds labels to an issue once', async () => {
    const s = spec('github.label-issue', gh.url, 'write-idempotent');
    expect(((await run(s, { repo: 'acme/shop', number: 27, labels: ['ready'] })).value as any).labels).toEqual(['ready']);
    expect(((await run(s, { repo: 'acme/shop', number: 27, labels: ['ready', 'azhi-split'] })).value as any).labels).toEqual(['ready', 'azhi-split']);
    await expect(run(s, { repo: 'acme/shop', number: 27, labels: [] })).rejects.toThrow(/no labels/);
    await expect(run(s, { repo: 'acme/shop', number: 999, labels: ['x'] })).rejects.toThrow(/404/);
  });
});
