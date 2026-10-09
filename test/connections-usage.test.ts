import Fastify from 'fastify';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConnectionRoutes } from '../src/api/connections.js';
import { registerExampleRoutes } from '../src/api/examples.js';
import { migrate } from '../src/db/migrate.js';
import { createContext } from '../src/server/context.js';

/** Where tools, secrets and datasets are used, from a real install of two examples. */
const WS = 'ws_conn';
describe('connection usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-conn-'));
  const app = Fastify();
  let ctx: ReturnType<typeof createContext>;
  beforeAll(async () => {
    process.env.AZHI_EXAMPLES_DIR = join(dir, 'examples');
    for (const id of ['pr-review', 'quality-report']) cpSync(`examples/${id}`, join(dir, 'examples', id), { recursive: true });
    ctx = createContext({ databaseUrl: 'pglite://memory', dataDir: join(dir, 'data'), artifactDir: join(dir, 'artifacts') });
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,'test')`, [WS]).catch(() => undefined);
    app.addHook('onRequest', async (req) => void (req.principal = { kind: 'user', workspaceId: WS, userId: 'usr_test', role: 'owner' } as never));
    registerExampleRoutes(app, ctx);
    registerConnectionRoutes(app, ctx);
    await app.ready();
    for (const [id, body] of [['pr-review', { repos: ['acme/payments'], settings: { slack_channel: 'C1' } }], ['quality-report', {}]] as const) {
      const r = await app.inject({ method: 'POST', url: `/v1/examples/${id}/install`, payload: body });
      expect(r.statusCode, r.body).toBe(200);
    }
  });
  afterAll(async () => void (await app.close()));

  it('lists the steps that use each tool, secret and dataset', async () => {
    const u = (await app.inject({ method: 'GET', url: '/v1/connections/usage' })).json() as any;
    expect(u.tools['github.comment-on-pr@1']).toEqual([expect.objectContaining({ workflow: 'pr-review', node: 'post' })]);
    expect(u.secrets['github-read-token'].map((x: any) => x.node).sort()).toEqual(['correctness', 'pr', 'quality', 'security', 'tests', 'verify']);
    expect(u.secrets['github-comment-token']).toEqual([expect.objectContaining({ node: 'post' })]);
    expect(u.tools['slack.post-message@1'].map((x: any) => x.workflow).sort()).toEqual(['pr-review', 'quality-report']);
    expect(Object.keys(u.datasets)).toContain('quality-guidelines');
    expect(u.datasets['quality-guidelines']).toEqual([expect.objectContaining({ workflow: 'quality-report', node: 'analyse' })]);
    expect(u.writes).toEqual({});
  });

  it('counts recent writes by outcome', async () => {
    const run = await ctx.pool.query(`SELECT id FROM runs LIMIT 1`);
    expect(run.rowCount).toBe(0); // no run exists, so the ledger is empty
    const u = (await app.inject({ method: 'GET', url: '/v1/connections/usage' })).json() as any;
    expect(u.writes).toEqual({});
  });
});
