import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addProposedMcp, checkMcpProposal, findIntegrations, integrationsOverview } from '../src/builder/integrations.js';
import { migrate } from '../src/db/migrate.js';
import { addMcpServer, effectiveMcpServers, workflowAssets } from '../src/server/assets.js';
import { createContext, type AppContext } from '../src/server/context.js';
import { clearMarketplaceCache, saveMarketConfig, type MarketDeps } from '../src/server/marketplace.js';
import { freshDatabase } from './helpers/harness.js';

/**
 * MCP servers in the library, OpenCode style: global (every workflow) or project (one workflow), usable
 * as soon as they are added, and offered by the builder chat from the library and the marketplaces.
 */
const WS = 'ws_mcp';
const remote = { transport: 'remote', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer {env:DOCS_TOKEN}' }, needs: [{ name: 'DOCS_TOKEN', secret: true, required: true }] };
const local = { transport: 'local', command: ['npx', '-y', '@acme/mcp'] };
const registryServer = { server: { name: 'io.example/jira', description: 'Jira issues', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://jira.example/mcp', headers: [{ name: 'Authorization', isSecret: true }] }] }, _meta: {} };
const deps: MarketDeps = {
  now: () => 1_700_000_000_000,
  fetch: (async (url: string) => {
    if (url.includes('/v0.1/servers?')) return new Response(JSON.stringify({ servers: [registryServer] }));
    if (url.includes('/v0.1/servers/io.example%2Fjira/versions/latest')) return new Response(JSON.stringify(registryServer));
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch,
};

describe('MCP servers: global and project scope', () => {
  let ctx: AppContext;
  beforeAll(async () => {
    ctx = createContext({ databaseUrl: await freshDatabase() });
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,$1)`, [WS]);
    for (const slug of ['alpha', 'beta']) await ctx.pool.query(`INSERT INTO workflows(id, workspace_id, slug) VALUES ($1,$2,$3)`, [`wf_${slug}`, WS, slug]);
    clearMarketplaceCache();
  });
  afterAll(async () => { await ctx?.pool.end(); });

  it('publishes a global server at once and offers it to every workflow', async () => {
    const a = await addMcpServer(ctx, WS, { slug: 'docs', name: 'Docs', definition: remote }, 'tester');
    expect(a).toMatchObject({ slug: 'docs', scope: 'global', status: 'published' });
    for (const wf of ['alpha', 'beta']) expect((await effectiveMcpServers(ctx, WS, wf)).map((x: any) => x.slug)).toContain('docs');
    expect((await workflowAssets(ctx, WS, 'alpha')).length).toBe(0);
  });

  it('ties a project server to its workflow and attaches it on publish', async () => {
    await addMcpServer(ctx, WS, { slug: 'files', name: 'Files', definition: local, scope: 'project', workflow: 'alpha' }, 'tester');
    expect((await effectiveMcpServers(ctx, WS, 'alpha')).find((x: any) => x.slug === 'files')).toMatchObject({ scope: 'project', project_workflow: 'alpha', attached: true });
    expect((await effectiveMcpServers(ctx, WS, 'beta')).map((x: any) => x.slug)).not.toContain('files');
    expect((await workflowAssets(ctx, WS, 'alpha')).map((x: any) => x.slug)).toEqual(['files']);
  });

  it('leaves a draft unpublished and unattached', async () => {
    const a = await addMcpServer(ctx, WS, { slug: 'later', name: 'Later', definition: local, scope: 'project', workflow: 'beta', draft: true }, 'tester');
    expect(a).toMatchObject({ status: 'draft' });
    expect((await workflowAssets(ctx, WS, 'beta')).length).toBe(0);
  });

  it('refuses a missing workflow, a scope mix-up, a duplicate name and a literal secret', async () => {
    await expect(addMcpServer(ctx, WS, { slug: 'x1', name: 'x', definition: local, scope: 'project' }, 't')).rejects.toThrow(/needs the workflow/);
    await expect(addMcpServer(ctx, WS, { slug: 'x2', name: 'x', definition: local, scope: 'project', workflow: 'nope' }, 't')).rejects.toThrow(/not found/);
    await expect(addMcpServer(ctx, WS, { slug: 'x3', name: 'x', definition: local, workflow: 'alpha' }, 't')).rejects.toThrow(/not tied to a workflow/);
    await expect(addMcpServer(ctx, WS, { slug: 'docs', name: 'again', definition: remote }, 't')).rejects.toThrow(/already exists/);
    await expect(addMcpServer(ctx, WS, { slug: 'leak', name: 'x', definition: { transport: 'remote', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123' } } }, 't')).rejects.toThrow(/looks like a secret/);
  });
});

describe('builder: what is available, and adding an MCP server', () => {
  let ctx: AppContext;
  beforeAll(async () => {
    ctx = createContext({ databaseUrl: await freshDatabase() });
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,$1)`, [WS]);
    await ctx.pool.query(`INSERT INTO workflows(id, workspace_id, slug) VALUES ('wf_a',$1,'alpha')`, [WS]);
    await addMcpServer(ctx, WS, { slug: 'docs', name: 'Docs', description: 'Search our docs', definition: remote }, 'tester');
    await ctx.pool.query(`INSERT INTO mcp_connections(id, workspace_id, name, url, auth_kind, status) VALUES ('mcp_1',$1,'jira','https://jira.example/mcp','none','ready')`, [WS]);
    clearMarketplaceCache();
  });
  afterAll(async () => { await ctx?.pool.end(); });

  it('lists library servers, gateway connections and harness tools without exposing definitions', async () => {
    const o = await integrationsOverview(ctx, WS);
    expect(o.library_mcp_servers).toEqual([{ slug: 'docs', description: 'Search our docs', status: 'published', scope: 'global', runs: 'hosted at mcp.example.com', needs: ['DOCS_TOKEN'] }]);
    expect(o.gateway_mcp_connections).toEqual([{ name: 'jira', auth_kind: 'none', status: 'ready' }]);
    expect(o.harness_tools.opencode).toEqual(['read', 'grep', 'glob', 'skill']);
    expect(JSON.stringify(o)).not.toContain('Bearer');
  });

  it('searches the marketplace, and reports a turned-off marketplace instead of failing', async () => {
    const r = await findIntegrations(ctx, WS, { query: 'jira', kinds: ['mcp'] }, deps);
    expect(r.items).toMatchObject([{ id: 'mcp-registry::io.example/jira', kind: 'mcp' }]);
    await expect(findIntegrations(ctx, WS, { query: ' ' }, deps)).rejects.toThrow(/search query/);
    await saveMarketConfig(ctx, WS, 'tester', { enabled: false, sources: [] });
    expect((await findIntegrations(ctx, WS, { query: 'jira' }, deps)).notes[0]).toMatch(/turned off/);
    await saveMarketConfig(ctx, WS, 'tester', { enabled: true, sources: [] });
  });

  it('checks a proposal and gives repairable errors', async () => {
    await expect(checkMcpProposal(ctx, WS, { slug: 'docs', scope: 'global', definition: remote }, deps)).rejects.toThrow(/already in the library/);
    await expect(checkMcpProposal(ctx, WS, { slug: 'x', scope: 'project', definition: local }, deps)).rejects.toThrow(/needs `workflow`/);
    await expect(checkMcpProposal(ctx, WS, { slug: 'x', scope: 'project', workflow: 'ghost', definition: local }, deps)).rejects.toThrow(/does not exist yet/);
    await expect(checkMcpProposal(ctx, WS, { slug: 'x', scope: 'global' }, deps)).rejects.toThrow(/marketplace_id/);
    await expect(checkMcpProposal(ctx, WS, { slug: 'x', scope: 'global', definition: { transport: 'remote', url: 'http://plain.example' } }, deps)).rejects.toThrow(/https/);
    const ok = await checkMcpProposal(ctx, WS, { slug: 'files', scope: 'global', definition: local }, deps);
    expect(ok).toMatchObject({ slug: 'files', scope: 'global', runs_code: true });
  });

  it('fetches a marketplace definition itself and ignores one the caller supplies', async () => {
    const c = await checkMcpProposal(ctx, WS, { slug: 'jira-mcp', scope: 'global', marketplace_id: 'mcp-registry::io.example/jira', definition: { transport: 'remote', url: 'https://evil.example/mcp' } }, deps);
    expect(c.definition).toMatchObject({ transport: 'remote', url: 'https://jira.example/mcp' });
    expect(c.definition.provenance).toMatchObject({ source: 'mcp-registry::io.example/jira' });
    expect(c).toMatchObject({ marketplace_id: 'mcp-registry::io.example/jira', runs_code: false });
  });

  it('adds a confirmed proposal as a published project server on an existing workflow', async () => {
    const r = await addProposedMcp(ctx, WS, { slug: 'files', scope: 'project', workflow: 'alpha', definition: local }, 'tester', deps);
    expect(r).toMatchObject({ slug: 'files', scope: 'project', workflow: 'alpha', status: 'published' });
    expect((await workflowAssets(ctx, WS, 'alpha')).map((x: any) => x.slug)).toEqual(['files']);
    await expect(addProposedMcp(ctx, WS, { slug: 'files', scope: 'global', definition: local }, 'tester', deps)).rejects.toThrow(/already in the library/);
  });
});
