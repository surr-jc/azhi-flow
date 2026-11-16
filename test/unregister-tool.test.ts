import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadCatalog, loadToolRevision, registerTool, unregisterTool } from '../src/server/catalog.js';
import { createContext } from '../src/server/context.js';
import type { ToolSpec } from '../src/gateway/types.js';

/** Unregistering hides a tool from new workflows; a run that pinned a revision still resolves it. */
const WS = 'ws_unregister';
const spec: ToolSpec = { id: 'jira_search', version: 1, description: 'Search', input_schema: { type: 'object' }, output_schema: { type: 'object' }, effect: 'read', transport: { kind: 'mcp-streamable-http', connection: 'jira', tool: 'search' } as never };

describe('unregisterTool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-unregister-'));
  const ctx = createContext({ databaseUrl: 'pglite://memory', dataDir: join(dir, 'data'), artifactDir: join(dir, 'artifacts') });

  it('hides the tool from the catalog, keeps the pinned revision, and allows registering it again', async () => {
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,'test')`, [WS]).catch(() => undefined);
    const { revision } = await registerTool(ctx, WS, spec, 'usr_test');
    expect((await loadCatalog(ctx, WS)).get('jira_search@1')).toBeDefined();

    await unregisterTool(ctx, WS, 'jira_search@1', 'usr_test');
    expect((await loadCatalog(ctx, WS)).get('jira_search@1')).toBeUndefined();
    expect(await loadToolRevision(ctx, WS, 'jira_search@1', undefined)).toBeUndefined();
    expect(await loadToolRevision(ctx, WS, 'jira_search@1', revision)).toMatchObject({ id: 'jira_search', revision });

    await registerTool(ctx, WS, spec, 'usr_test');
    expect((await loadCatalog(ctx, WS)).get('jira_search@1')).toBeDefined();
  });

  it('refuses unknown and built-in tools', async () => {
    await expect(unregisterTool(ctx, WS, 'nope@1', 'usr_test')).rejects.toThrow('not a registered tool');
    const builtin = (await loadCatalog(ctx, WS)).list().find((t) => t.revision === undefined);
    if (builtin) await expect(unregisterTool(ctx, WS, `${builtin.id}@${builtin.version}`, 'usr_test')).rejects.toThrow('built in');
  });
});
