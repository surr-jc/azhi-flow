import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signRunToken } from '../src/security/tokens.js';
import { folderPathProblem, pathWithin } from '../src/server/local-folders.js';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, type Harness } from './helpers/harness.js';

/**
 * Local folders on the server (src/server/local-folders.ts): the registry a workflow's `workspace.local`
 * names, what the run plan says about it, and the worktree a worker reports for a run. No worker runs
 * here: the worker side is test/workspace-local.test.ts.
 */
const up = await temporalAvailable();

describe('local folder paths', () => {
  it('must be absolute, on Windows or POSIX, with no way up', () => {
    expect(folderPathProblem('C:\\code\\shop')).toBeUndefined();
    expect(folderPathProblem('/home/me/shop')).toBeUndefined();
    expect(folderPathProblem('code/shop')).toMatch(/absolute/);
    expect(folderPathProblem('/home/me/../root')).toMatch(/\.\./);
    expect(folderPathProblem('')).toBeDefined();
  });
  it('knows a folder from what is inside it', () => {
    expect(pathWithin('C:\\code\\shop', 'c:/code/shop/wt')).toBe(true);
    expect(pathWithin('/home/me/shop', '/home/me/shop')).toBe(true);
    expect(pathWithin('/home/me/shop', '/home/me/shop-2')).toBe(false);
    expect(pathWithin('/home/me/shop', '/home/me/.azhi/worker/worktrees/run_1-shop')).toBe(false);
  });
});

describe.skipIf(!up)('local folders', () => {
  let h: Harness;
  let version: string;
  const SHA = 'a'.repeat(40);
  const heartbeat = (id: string, features: string[]) =>
    h.api.post('/v1/workers/heartbeat', { id, name: id, task_queue: `azhi-exec-${id}`, capabilities: { runtimes: { opencode: { version: '1.0.0', path: 'opencode' }, git: { version: '2.45.0' } }, features }, trust_policy: { kind: 'workspace-publishers' } });
  const planOf = async () => (await h.api.get<any>(`/v1/versions/${version}/plan`)).nodes.find((n: any) => n.id === 'build');
  const req = (np: any, name: string) => np.requirements.find((r: any) => r.name === name);

  beforeAll(async () => {
    h = await startHarness({ worker: false });
    version = (await uploadDir(h.api, 'test/fixtures/local-folder')).version.id;
  });
  afterAll(async () => h?.stop());

  it('keeps a registry of named folders, with absolute paths only', async () => {
    expect(await h.api.get<any>('/v1/local-folders')).toEqual({ folders: [], workers: [] });
    await expect(h.api.put('/v1/local-folders/shop', { path: 'code/shop' })).rejects.toThrow(/absolute/);
    await expect(h.api.put('/v1/local-folders/Shop', { path: '/code/shop' })).rejects.toThrow(/lower-case/);
    await h.api.put('/v1/local-folders/other', { path: '/code/other' });
    expect((await h.api.get<any>('/v1/local-folders')).folders.map((f: any) => [f.name, f.path])).toEqual([['other', '/code/other']]);
  });

  it('blocks the run until the folder is registered and a worker allows local folders', async () => {
    let np = await planOf();
    expect(req(np, 'local folder shop')).toMatchObject({ mark: 'unsupported' });
    expect(req(np, 'worker allows local folders')).toMatchObject({ mark: 'unverified' });
    expect(np.coverage.find((c: any) => c.action === 'works in a local folder')).toMatchObject({ enforcement: 'unobservable' });
    expect(np.coverage.some((c: any) => c.action === 'workspace clone')).toBe(false);

    await h.api.put('/v1/local-folders/shop', { path: '/code/shop' });
    await heartbeat('plain', ['workspace_continuation']);
    np = await planOf();
    expect(req(np, 'local folder shop')).toMatchObject({ mark: 'native' });
    expect(req(np, 'worker allows local folders')).toMatchObject({ mark: 'unsupported' });
    expect((await h.api.get<any>('/v1/local-folders')).workers).toEqual([]);

    await heartbeat('local', ['workspace_local']);
    expect(req(await planOf(), 'worker allows local folders')).toMatchObject({ mark: 'native', detail: 'local' });
    expect((await h.api.get<any>('/v1/local-folders')).workers).toEqual(['local']);
  });

  it('records the worktree a worker reports with its run token, once, and shows it on the run', async () => {
    const run = (await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: {}, test: true })).run_id;
    const ctx = h.server.ctx;
    const ws = (await h.api.get<any>('/v1/me')).workspaceId as string;
    const token = (r: string) => new ApiClient(h.server.url, signRunToken(ctx.secretKey, { ws, run: r, node: 'build', tools: [], exp: Math.floor(Date.now() / 1000) + 600 }));
    const wt = { folder: 'shop', path: '/home/me/.azhi/worker/worktrees/x-shop', branch: `azhi/${run}`, base_sha: SHA, worker_id: 'local' };

    // A user token is not a run token; an unregistered folder and a path inside the folder are refused.
    await expect(h.api.post('/v1/gateway/worktree', wt)).rejects.toThrow(/run-scoped/);
    await expect(token(run).post('/v1/gateway/worktree', { ...wt, folder: 'nope' })).rejects.toThrow(/not registered/);
    await expect(token(run).post('/v1/gateway/worktree', { ...wt, path: '/code/shop/inside' })).rejects.toThrow(/inside it/);
    await expect(token(run).post('/v1/gateway/worktree', { ...wt, path: 'relative' })).rejects.toThrow(/absolute/);

    expect(await token(run).post('/v1/gateway/worktree', wt)).toEqual({ created: true });
    expect(await token(run).post('/v1/gateway/worktree', wt)).toEqual({ created: false });
    const d = await h.api.get<any>(`/v1/runs/${run}`);
    expect(d.worktrees).toHaveLength(1);
    expect(d.worktrees[0]).toMatchObject({ folder: 'shop', path: wt.path, branch: wt.branch, base_sha: SHA, worker_id: 'local', removed_at: null });
    const events = (await h.api.get<any[]>(`/v1/runs/${run}/events`)).filter((e) => e.kind === 'run.worktree');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ node_id: 'build', data: { folder: 'shop', path: wt.path } });

    // `azhi worktree remove` tells the server; the run then shows it as removed.
    expect(await h.api.post(`/v1/runs/${run}/worktrees/shop/removed`)).toEqual({ removed: true });
    expect(await h.api.post(`/v1/runs/${run}/worktrees/shop/removed`)).toEqual({ removed: false });
    expect((await h.api.get<any>(`/v1/runs/${run}`)).worktrees[0].removed_at).not.toBeNull();
    await h.api.post(`/v1/runs/${run}/cancel`);
  });

  it('removes a folder from the registry', async () => {
    expect(await h.api.del('/v1/local-folders/other')).toEqual({ removed: true });
    expect((await h.api.get<any>('/v1/local-folders')).folders.map((f: any) => f.name)).toEqual(['shop']);
  });
});
