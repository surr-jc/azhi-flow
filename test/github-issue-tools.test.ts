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

/**
 * The order guard's tool: a slice written by the issue splitter says which slices it depends on, and the tool
 * reports the ones still open among its siblings under the parent. No dependencies means never blocked; when the
 * dependencies cannot be checked it answers blocked, so the guard fails closed.
 */
describe('github issue-blockers tool', () => {
  const body = (order: string, part = 'Part of #40') => `${part}\n\nWork.\n\n## Order\n${order}\n\nSuggested review path: lite.\n\n<!-- azhi-action:x -->`;
  const issue = (number: number, title: string, order: string, extra: Record<string, unknown> = {}) => ({ number, id: 5000 + number, repo: 'acme/shop', title, labels: [] as string[], body: body(order), ...extra });
  const seeded = () => [
    { number: 40, id: 5040, repo: 'acme/shop', title: 'Parent', labels: [], body: 'The big ticket' },
    issue(41, 'First', 'Slice 1 of 4. Independent: it can be built on its own.'),
    issue(42, 'Second', 'Slice 2 of 4. Depends on slice 1: First. Do not start it before those are merged.'),
    issue(43, 'Third', 'Slice 3 of 4. Depends on slice 1: First; slice 2: Second (left out of this plan). Do not start it before those are merged.'),
    issue(44, 'Fourth', 'Slice 4 of 4. Depends on slice 2: Second; slice 9: Ghost. Do not start it before those are merged.'),
    issue(45, 'Orphan', 'Slice 2 of 2. Depends on slice 1: First. Do not start it before those are merged.', { body: 'Slice 2 of 2. Depends on slice 1: First. Do not start it before those are merged.' }),
  ];
  const links = [41, 42, 43, 44].map((n) => ({ repo: 'acme/shop', parent: 40, child: 5000 + n }));
  let server: Awaited<ReturnType<typeof startFakeGithub>>;
  let blind: Awaited<ReturnType<typeof startFakeGithub>>;
  const check = (s: Awaited<ReturnType<typeof startFakeGithub>>, args: Record<string, unknown>) => {
    const sp = spec('github.issue-blockers', s.url, 'read');
    return executorFor(sp).call(sp, args, { credential: TOKEN, timeoutMs: 5000 }).then((r) => r.value as any);
  };

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    server = await startFakeGithub({ runs: [], issues: seeded() }, { token: TOKEN, links });
    blind = await startFakeGithub({ runs: [], issues: seeded() }, { token: TOKEN, links, noSubIssues: true });
  });
  afterAll(async () => {
    await server.stop();
    await blind.stop();
  });
  const setState = (number: number, state: 'open' | 'closed') => (server.issues.find((i) => i.number === number)!.state = state);

  it('never blocks a slice with nothing to wait for, or an ordinary issue', async () => {
    expect(await check(server, { issue: 'acme/shop#41' })).toMatchObject({ blocked: false, slice: 1, of: 4, parent: 40, depends: [], blockers: [] });
    expect(await check(server, { issue: 'acme/shop#40' })).toMatchObject({ blocked: false, slice: 0, depends: [] });
    expect(await check(server, { issue: '' })).toMatchObject({ blocked: false });
  });

  it('blocks a slice while the slice it depends on is open, and frees it once that is closed', async () => {
    const r = await check(server, { issue: 'acme/shop#42' });
    expect(r).toMatchObject({ blocked: true, slice: 2, depends: [1], reason: 'waiting for #41' });
    expect(r.blockers).toEqual([expect.objectContaining({ slice: 1, number: 41, title: 'First', state: 'open' })]);
    setState(41, 'closed');
    expect(await check(server, { issue: 'acme/shop#42' })).toMatchObject({ blocked: false, blockers: [] });
    setState(41, 'open');
  });

  it('ignores a dependency that was left out of the plan, and warns about one that cannot be found', async () => {
    const third = await check(server, { issue: 'acme/shop#43' });
    expect(third.depends).toEqual([1]);
    expect(third.blocked).toBe(true);
    setState(41, 'closed');
    expect(await check(server, { issue: 'acme/shop#43' })).toMatchObject({ blocked: false });
    // #44 waits for slice 2 (open, #42) and for a slice 9 that no sibling carries.
    const fourth = await check(server, { issue: 'acme/shop#44' });
    expect(fourth).toMatchObject({ blocked: true, depends: [2, 9] });
    expect(fourth.blockers.map((b: any) => b.number)).toEqual([42]);
    expect(fourth.warnings).toEqual([expect.stringContaining('slice 9 was not found')]);
    setState(41, 'open');
  });

  it('skips the check when a person says to, without reading anything', async () => {
    const before = server.requests.length;
    expect(await check(server, { issue: 'acme/shop#42', ignore: true })).toMatchObject({ blocked: false, ignored: true });
    expect(server.requests.length).toBe(before);
  });

  it('fails closed when the dependencies cannot be checked', async () => {
    const noSubIssues = await check(blind, { issue: 'acme/shop#42' });
    expect(noSubIssues).toMatchObject({ blocked: true });
    expect(noSubIssues.reason).toContain('could not be read');
    const orphan = await check(server, { issue: 'acme/shop#45' });
    expect(orphan).toMatchObject({ blocked: true });
    expect(orphan.reason).toContain('does not say which issue it is part of');
    // An issue with no dependencies still passes when sub-issues are unavailable.
    expect(await check(blind, { issue: 'acme/shop#41' })).toMatchObject({ blocked: false });
  });
});

/**
 * The factory's read tools: the queue of ready issues a lap picks from (blocked by open slices, already claimed or
 * already in a pull request), and the repository files the readiness scorecard looks for.
 */
describe('github factory tools', () => {
  const part = (order: string) => `Part of #40\n\nWork.\n\n## Order\n${order}\n\n<!-- azhi-action:x -->`;
  const ready = (number: number, order: string, extra: Record<string, unknown> = {}) => ({ number, id: 5000 + number, repo: 'acme/shop', title: `Slice ${number}`, labels: ['ready'], body: part(order), ...extra });
  const seeded = () => [
    { number: 40, id: 5040, repo: 'acme/shop', title: 'Parent', labels: [], body: 'The big ticket' },
    ready(41, 'Slice 1 of 3. Independent: it can be built on its own.'),
    ready(42, 'Slice 2 of 3. Depends on slice 1: First. Do not start it before those are merged.'),
    ready(43, 'Slice 3 of 3. Independent: it can be built on its own.', { labels: ['ready', 'factory-in-progress'] }),
    { number: 50, id: 5050, repo: 'acme/shop', title: 'Plain', labels: ['ready'], body: 'No order text', created_at: '2026-09-01T00:00:00Z' },
    { number: 51, id: 5051, repo: 'acme/shop', title: 'Done already', labels: ['ready'], body: 'x', state: 'closed' as const },
  ];
  const links = [41, 42, 43].map((n) => ({ repo: 'acme/shop', parent: 40, child: 5000 + n }));
  const files = { 'acme/shop': ['README.md', '.github/CODEOWNERS', '.github/workflows/ci.yml', '.github/workflows/release.yml'] };
  let server: Awaited<ReturnType<typeof startFakeGithub>>;
  let blind: Awaited<ReturnType<typeof startFakeGithub>>;
  const call = (name: string, s: Awaited<ReturnType<typeof startFakeGithub>>, args: Record<string, unknown>) => {
    const sp = spec(name, s.url, 'read');
    return executorFor(sp).call(sp, args, { credential: TOKEN, timeoutMs: 5000 }).then((r) => r.value as any);
  };
  const queue = (s: Awaited<ReturnType<typeof startFakeGithub>>, extra: Record<string, unknown> = {}) => call('github.factory-queue', s, { repo: 'acme/shop', label: 'ready', claim_label: 'factory-in-progress', ...extra });

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    server = await startFakeGithub({ runs: [], issues: seeded() }, { token: TOKEN, links, files, refs: { 'azhi/slice-50': { sha: 'a'.repeat(40), message: 'slice 50' } } });
    blind = await startFakeGithub({ runs: [], issues: seeded() }, { token: TOKEN, links, noSubIssues: true });
  });
  afterAll(async () => {
    await server.stop();
    await blind.stop();
  });

  it('lists the open ready issues with their order, blockers and claims', async () => {
    const r = await queue(server);
    expect(r.items.map((i: any) => i.number)).toEqual([41, 42, 43, 50]);
    const by = (n: number) => r.items.find((i: any) => i.number === n);
    expect(by(41)).toMatchObject({ slice: 1, of: 3, parent: 40, depends: [], blocked: false, in_flight: false });
    expect(by(42)).toMatchObject({ depends: [1], blocked: true, reason: 'waiting for #41' });
    expect(by(43)).toMatchObject({ blocked: false, in_flight: true });
    expect(by(50)).toMatchObject({ slice: 0, blocked: false, in_flight: false });
  });

  it('frees a slice when the one it depends on is closed, and sees a pull request as in flight', async () => {
    server.issues.find((i) => i.number === 41)!.state = 'closed';
    await fetch(`${server.url}/repos/acme/shop/pulls`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ head: 'azhi/slice-50', base: 'dev', title: 'Plain', body: 'Closes #50' }) });
    const r = await queue(server);
    expect(r.items.map((i: any) => i.number)).toEqual([42, 43, 50]);
    expect(r.items.find((i: any) => i.number === 42)).toMatchObject({ blocked: false });
    expect(r.items.find((i: any) => i.number === 50)).toMatchObject({ in_flight: true });
  });

  it('fails closed when the dependencies cannot be checked, and bounds the list', async () => {
    const r = await queue(blind);
    expect(r.items.find((i: any) => i.number === 42)).toMatchObject({ blocked: true });
    expect(r.items.find((i: any) => i.number === 42).reason).toContain('could not be read');
    expect(r.items.find((i: any) => i.number === 41)).toMatchObject({ blocked: false });
    expect(await queue(blind, { max_items: 2 })).toMatchObject({ truncated: true });
  });

  it('refuses a repository it was not registered for, a bad label and a bad size', async () => {
    await expect(call('github.factory-queue', server, { repo: 'evil/other', label: 'ready' })).rejects.toThrow(/not one of the repositories/);
    await expect(queue(server, { label: 'a,b' })).rejects.toThrow(/not a label name/);
    await expect(queue(server, { max_items: 0 })).rejects.toThrow(/max_items/);
  });

  it('says which of the named paths exist, for files and directories', async () => {
    const r = await call('github.repo-files', server, { repo: 'acme/shop', ref: 'dev', paths: ['README.md', '.github/CODEOWNERS', '.github/PULL_REQUEST_TEMPLATE.md', '.github/workflows'] });
    expect(r.files.map((f: any) => [f.path, f.exists, f.kind])).toEqual([
      ['README.md', true, 'file'],
      ['.github/CODEOWNERS', true, 'file'],
      ['.github/PULL_REQUEST_TEMPLATE.md', false, ''],
      ['.github/workflows', true, 'dir'],
    ]);
    expect(r.files[3].entries).toEqual(['ci.yml', 'release.yml']);
    expect(server.requests.some((q) => q.includes('/contents/README.md?ref=dev'))).toBe(true);
  });

  it('does not read a failure as a missing file, and refuses bad paths', async () => {
    const sp = spec('github.repo-files', server.url, 'read');
    await expect(executorFor(sp).call(sp, { repo: 'acme/shop', paths: ['README.md'] }, { credential: 'wrong', timeoutMs: 5000 })).rejects.toThrow(/401/);
    await expect(call('github.repo-files', server, { repo: 'acme/shop', paths: [] })).rejects.toThrow(/1 to 20/);
    await expect(call('github.repo-files', server, { repo: 'acme/shop', paths: ['../etc/passwd'] })).rejects.toThrow(/not a repository path/);
    await expect(call('github.repo-files', server, { repo: 'acme/shop', ref: 'a b', paths: ['x'] })).rejects.toThrow(/not a ref/);
  });
});
