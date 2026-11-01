import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { gatewayActivities } from '../src/runtime/gateway-activities.js';
import { createContext, type AppContext } from '../src/server/context.js';
import { WORKER_FEATURES } from '../src/worker/capabilities.js';

// Trust is not what is tested here: every online worker trusts the package.
vi.mock('../src/server/trust.js', async (orig) => {
  const real = await orig<typeof import('../src/server/trust.js')>();
  return {
    ...real,
    evaluateWorkerTrust: async (ctx: AppContext, ws: string) => ({
      workers: (await ctx.pool.query(`SELECT id, name, trust_policy FROM workers WHERE workspace_id=$1`, [ws])).rows.map((w: any) => ({ worker: w.id, name: w.name, policy: w.trust_policy, accepted: true })),
    }),
  };
});

const WS = 'ws-features';

describe('worker feature gating', () => {
  let ctx: AppContext;
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'azhi-features-'));
    ctx = createContext({ databaseUrl: 'pglite://memory', dataDir });
    await migrate(ctx.pool);
    await ctx.pool.query(`SET session_replication_role = replica`); // test setup: no workspace row needed
    const add = (id: string, caps: Record<string, unknown>) =>
      ctx.pool.query(`INSERT INTO workers(id, workspace_id, name, task_queue, capabilities) VALUES ($1,$2,$1,$3,$4)`, [id, WS, `azhi-exec-${id}`, JSON.stringify({ runtimes: { opencode: { version: '1.0.0', path: 'oc' } }, ...caps })]);
    await add('new', { features: ['workspace_continuation'] });
    await add('old', {}); // a build from before the field existed
    await add('empty', { features: [] });
    await add('two', { features: ['opencode_2'] });
  });

  it('every worker build advertises workspace continuation', () => {
    expect(WORKER_FEATURES).toContain('workspace_continuation');
  });

  it('without a requirement, any worker with the runtime is accepted (nothing changes for existing steps)', async () => {
    const sel = await gatewayActivities(ctx).checkWorkers(WS, 'sha256:x', 'opencode');
    expect(sel.accepted.map((w) => w.id).sort()).toEqual(['empty', 'new', 'old', 'two']);
    expect(sel.refused).toEqual([]);
  });

  it('a step that continues from a change is only given workers that support it, and the others say why', async () => {
    const sel = await gatewayActivities(ctx).checkWorkers(WS, 'sha256:x', 'opencode', ['workspace_continuation']);
    expect(sel.accepted.map((w) => w.id)).toEqual(['new']);
    expect(sel.refused.map((r) => r.id).sort()).toEqual(['empty', 'old', 'two']);
    for (const r of sel.refused) expect(r.reason).toBe('worker build does not support workspace continuation; upgrade it');
    expect(sel.online).toBe(4);
  });

  it('a workspace that chose OpenCode 2 is only given workers that have it, and the others say how to get it', async () => {
    const sel = await gatewayActivities(ctx).checkWorkers(WS, 'sha256:x', 'opencode', ['opencode_2']);
    expect(sel.accepted.map((w) => w.id)).toEqual(['two']);
    expect(sel.refused.map((r) => r.reason)).toEqual(Array(3).fill('no OpenCode 2.x on this worker; run azhi setup --opencode2'));
  });

  it('still refuses a worker without the runtime first', async () => {
    const sel = await gatewayActivities(ctx).checkWorkers(WS, 'sha256:x', 'codex', ['workspace_continuation']);
    expect(sel.accepted).toEqual([]);
    expect(sel.refused.every((r) => r.reason === 'no codex runtime')).toBe(true);
  });
});
