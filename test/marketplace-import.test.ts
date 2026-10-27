import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext, type AppContext } from '../src/server/context.js';
import { migrate } from '../src/db/migrate.js';
import { getAsset, publishAsset } from '../src/server/assets.js';
import { clearMarketplaceCache, importItem, marketConfig, saveMarketConfig, type MarketDeps } from '../src/server/marketplace.js';
import { freshDatabase } from './helpers/harness.js';

const WS = 'ws_market';
const body = JSON.stringify({ server: { name: 'io.example/docs', description: 'Docs search', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://docs.example/mcp', headers: [{ name: 'Authorization', isSecret: true }] }] }, _meta: {} });
const skill = '---\nname: release-notes\ndescription: Write release notes\n---\nList merged pull requests.';
const deps: MarketDeps = {
  now: () => 1_700_000_000_000,
  fetch: (async (url: string) => {
    if (url.startsWith('https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fdocs/versions/latest')) return new Response(body);
    if (url.endsWith('/skills/release-notes/SKILL.md')) return new Response(skill);
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch,
};

describe('importing from a marketplace', () => {
  let ctx: AppContext;
  beforeAll(async () => {
    ctx = createContext({ databaseUrl: await freshDatabase() });
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,$1)`, [WS]);
    clearMarketplaceCache();
  });
  afterAll(async () => { await ctx?.pool.end(); });

  it('creates a draft asset with its source, hash and needs, and numbers a repeated import', async () => {
    const first = await importItem(ctx, deps, WS, 'tester', 'mcp-registry::io.example/docs');
    expect(first.asset).toMatchObject({ kind: 'mcp', slug: 'docs', status: 'draft' });
    const stored = await getAsset(ctx, WS, first.asset.id);
    const def = stored.versions[0].definition;
    expect(def).toMatchObject({ transport: 'remote', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer {env:DOCS_TOKEN}' }, needs: [{ name: 'DOCS_TOKEN', secret: true }] });
    expect(def.provenance).toMatchObject({ source: 'mcp-registry::io.example/docs' });
    expect(def.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    const again = await importItem(ctx, deps, WS, 'tester', 'mcp-registry::io.example/docs');
    expect(again.asset.slug).toBe('docs-2');
    const audits = (await ctx.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE workspace_id=$1 AND kind='portable_asset.imported'`, [WS])).rows[0].n;
    expect(audits).toBe(2);
  });

  it('imports a skill, and an imported draft still has to be published before it can be attached', async () => {
    const r = await importItem(ctx, deps, WS, 'tester', 'gh:anthropics/skills::skill::skills/release-notes/SKILL.md');
    expect(r.asset).toMatchObject({ kind: 'skill', slug: 'release-notes', status: 'draft' });
    const pub = await publishAsset(ctx, WS, r.asset.id, 'tester');
    expect(pub.status).toBe('published');
  });

  it('refuses everything when an admin turns the marketplace off, and validates added repositories', async () => {
    await saveMarketConfig(ctx, WS, 'admin', { enabled: false, sources: [{ repo: 'acme/agents', ref: 'main' }] });
    expect(await marketConfig(ctx, WS)).toEqual({ enabled: false, sources: [{ repo: 'acme/agents', ref: 'main' }] });
    await expect(importItem(ctx, deps, WS, 'tester', 'mcp-registry::io.example/docs')).rejects.toThrow(/turned off/);
    await expect(saveMarketConfig(ctx, WS, 'admin', { enabled: true, sources: [{ repo: 'not a repo', ref: 'main' }] })).rejects.toThrow(/owner\/repo/);
    await expect(saveMarketConfig(ctx, WS, 'admin', { enabled: true, sources: [{ repo: 'a/b', ref: 'main' }, { repo: 'a/b', ref: 'dev' }] })).rejects.toThrow(/twice/);
  });
});
