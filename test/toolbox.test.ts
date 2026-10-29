import Fastify from 'fastify';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAssetRoutes } from '../src/api/assets.js';
import { registerExampleRoutes } from '../src/api/examples.js';
import { registerToolboxRoutes } from '../src/api/toolbox.js';
import { migrate } from '../src/db/migrate.js';
import { createDataset } from '../src/knowledge/datasets.js';
import { createContext } from '../src/server/context.js';
import { setSecret } from '../src/server/secrets.js';

/** The toolbox merges gateway tools, library assets and datasets into one list with a status each. */
const WS = 'ws_toolbox';
describe('toolbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-toolbox-'));
  const app = Fastify();
  let ctx: ReturnType<typeof createContext>;
  let role = 'owner';
  const get = async () => (await app.inject({ method: 'GET', url: '/v1/toolbox' })).json() as any[];
  beforeAll(async () => {
    process.env.AZHI_EXAMPLES_DIR = join(dir, 'examples');
    for (const id of ['pr-review', 'quality-report']) cpSync(`examples/${id}`, join(dir, 'examples', id), { recursive: true });
    ctx = createContext({ databaseUrl: 'pglite://memory', dataDir: join(dir, 'data'), artifactDir: join(dir, 'artifacts') });
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,'test')`, [WS]).catch(() => undefined);
    app.addHook('onRequest', async (req) => void (req.principal = { kind: 'user', workspaceId: WS, userId: 'usr_test', role } as never));
    registerExampleRoutes(app, ctx);
    registerAssetRoutes(app, ctx);
    registerToolboxRoutes(app, ctx);
    await createDataset(ctx, WS, { name: 'quality-guidelines' });
    await app.ready();
    for (const [id, body] of [['pr-review', { repos: ['acme/payments'], settings: { slack_channel: 'C1' } }], ['quality-report', {}]] as const) {
      expect((await app.inject({ method: 'POST', url: `/v1/examples/${id}/install`, payload: body })).statusCode).toBe(200);
    }
    await app.inject({ method: 'POST', url: '/v1/assets', payload: { kind: 'skill', slug: 'release-notes', name: 'Release notes', description: 'Write release notes', definition: { description: 'Write release notes', instructions: 'List merged PRs.' } } });
    await app.inject({ method: 'POST', url: '/v1/assets', payload: { kind: 'mcp', slug: 'repo-facts', name: 'Repo facts', definition: { transport: 'local', command: ['node', 'x.mjs'], needs: [{ name: 'REPO_KEY', secret: true }] } } });
  });
  afterAll(async () => void (await app.close()));

  it('puts apps, skills and knowledge in one list with plain statuses', async () => {
    const items = await get();
    const github = items.find((i) => i.id === 'app:github');
    expect(github).toMatchObject({ group: 'apps', name: 'GitHub', changes_things: true, status: 'needs_setup' });
    expect(github.status_note).toContain('github-read-token');
    expect(github.used_by).toBe(1);
    expect(github.details.tools[0]).toHaveProperty('ref');
    expect(items.find((i) => i.name === 'Release notes')).toMatchObject({ group: 'skills', status: 'draft', used_by: 0 });
    expect(items.find((i) => i.name === 'Repo facts')).toMatchObject({ group: 'apps', kind: 'mcp', runs_code: true, needs: ['REPO_KEY'] });
    expect(items.find((i) => i.id === 'dataset:quality-guidelines')).toMatchObject({ group: 'knowledge', status: 'draft', used_by: 1 });
  });

  it('turns ready once the secret exists, and says unknown to people who cannot see secrets', async () => {
    await setSecret(ctx, WS, 'github-read-token', 'x', 'usr_test');
    await setSecret(ctx, WS, 'github-comment-token', 'x', 'usr_test');
    await setSecret(ctx, WS, 'github-merge-token', 'x', 'usr_test');
    expect((await get()).find((i) => i.id === 'app:github').status).toBe('ready');
    role = 'author';
    expect((await get()).find((i) => i.id === 'app:github').status).toBe('unknown');
    role = 'owner';
  });
});
