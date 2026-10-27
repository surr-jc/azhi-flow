import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRepos } from '../src/server/repo-slots.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * Parallel runs and the per-repository limit (src/server/repo-slots.ts): runs of the same workflow go
 * side by side, at most `max_runs_per_repo` of them per repository; the rest stay queued and start in
 * order when a slot frees. Each run is held open at an approval so it keeps its slot.
 */
const up = await temporalAvailable();

describe('runRepos', () => {
  const plan = (repo: unknown, host?: string) => ({ config: { repo: 'acme/conf' }, nodes: [{ type: 'agent', def: { workspace: { repo, ref: 'HEAD', ...(host ? { host } : {}) } } }] }) as any;
  it('names the repositories a run checks out, from its inputs only', () => {
    expect(runRepos(plan({ ref: 'inputs.repo' }), { repo: 'Acme/Shop' })).toEqual(['github.com/acme/shop']);
    expect(runRepos(plan({ ref: 'config.repo' }, 'https://ghe.example.com/'), {})).toEqual(['ghe.example.com/acme/conf']);
    expect(runRepos(plan({ cel: "'acme/' + inputs.name" }), { name: 'x' })).toEqual(['github.com/acme/x']);
    // Known only mid-run, or not a repository: not counted.
    expect(runRepos(plan({ ref: 'nodes.intake.output.repo' }), {})).toEqual([]);
    expect(runRepos(plan({ cel: 'nodes.intake.output.repo' }), {})).toEqual([]);
    expect(runRepos(plan({ ref: 'inputs.repo' }), { repo: 'not a repo' })).toEqual([]);
  });
});

describe.skipIf(!up)('per-repository run limit', () => {
  let h: Harness;
  let version: string;
  const state = async (id: string) => (await h.api.get<any>(`/v1/runs/${id}`)).run.state as string;
  const until = async (what: () => Promise<boolean>, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!(await what())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const start = async (repo: string) => (await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { repo }, test: true })).run_id;

  beforeAll(async () => {
    h = await startHarness({ worker: false });
    version = (await uploadDir(h.api, 'test/fixtures/repo-limit')).version.id;
  });
  afterAll(async () => h?.stop());

  it('runs two at once per repository, holds the next in order, and starts it when a slot frees', async () => {
    expect(await h.api.get<any>('/v1/settings/concurrency')).toMatchObject({ max_runs_per_repo: 2, source: 'server', repos: [] });
    const [a, b] = [await start('acme/shop'), await start('acme/shop')];
    await until(async () => (await state(a)) === 'waiting' && (await state(b)) === 'waiting');
    const c = await start('acme/shop');
    const d = await start('acme/shop');
    const other = await start('acme/other');
    await until(async () => (await state(other)) === 'waiting');
    expect(await state(c)).toBe('queued');
    expect(await state(d)).toBe('queued');
    const events = await h.api.get<any[]>(`/v1/runs/${c}/events`);
    expect(events.find((e) => e.kind === 'run.held')?.data).toMatchObject({ reason: 'repo_limit', repo: 'github.com/acme/shop', limit: 2, running: [a, b] });
    const s = await h.api.get<any>('/v1/settings/concurrency');
    expect(s.repos).toEqual([
      { repo: 'github.com/acme/other', running: [other], held: [] },
      { repo: 'github.com/acme/shop', running: [a, b], held: [c, d] },
    ]);

    // A held run cancelled while it waits never starts.
    await h.api.post(`/v1/runs/${d}/cancel`);
    await until(async () => (await state(d)) === 'cancelled');

    // Ending a run frees its slot for the oldest held run.
    await h.api.post(`/v1/runs/${a}/cancel`);
    await waitForRun(h.api, a);
    await until(async () => (await state(c)) === 'waiting');
    expect(await state(d)).toBe('cancelled');
    for (const id of [b, c, other]) await h.api.post(`/v1/runs/${id}/cancel`);
  });

  it('is a workspace setting an admin can raise, switch off, or hand back to the server default', async () => {
    const u = await h.api.post<{ token: string }>('/v1/users', { display_name: 'op', role: 'operator' });
    const { ApiClient } = await import('../src/worker/api-client.js');
    await expect(new ApiClient(h.server.url, u.token).put('/v1/settings/concurrency', { max_runs_per_repo: 5 })).rejects.toThrow(/admin/);
    await expect(h.api.put('/v1/settings/concurrency', { max_runs_per_repo: -1 })).rejects.toThrow();

    expect(await h.api.put<any>('/v1/settings/concurrency', { max_runs_per_repo: 1 })).toMatchObject({ max_runs_per_repo: 1, source: 'workspace' });
    const a = await start('acme/limit');
    await until(async () => (await state(a)) === 'waiting');
    const b = await start('acme/limit');
    await until(async () => (await h.api.get<any[]>(`/v1/runs/${b}/events`)).some((e) => e.kind === 'run.held'));
    expect(await state(b)).toBe('queued');

    // Switching the limit off lets the held run start without waiting for a slot.
    expect(await h.api.put<any>('/v1/settings/concurrency', { max_runs_per_repo: 0 })).toMatchObject({ max_runs_per_repo: 0 });
    await until(async () => (await state(b)) === 'waiting');

    expect(await h.api.put<any>('/v1/settings/concurrency', { max_runs_per_repo: null })).toMatchObject({ max_runs_per_repo: 2, source: 'server' });
    expect((await h.api.get<any[]>('/v1/audit')).filter((e) => e.kind === 'settings.concurrency_changed')).toHaveLength(3);
    for (const id of [a, b]) await h.api.post(`/v1/runs/${id}/cancel`);
  });
});
