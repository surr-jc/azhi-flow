import Fastify from 'fastify';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerExampleRoutes } from '../src/api/examples.js';
import { migrate } from '../src/db/migrate.js';
import { createContext } from '../src/server/context.js';
import { workflowSummaries } from '../src/server/overview.js';
import { categoryOf, tagsOf, WORKFLOW_CATEGORIES } from '../src/definition/category.js';
import { loadDefinitionText } from '../src/definition/load.js';

const doc = (tags: string) => `schema_version: "2.0"\nid: tagged\n${tags}nodes:\n  - id: a\n    type: script\n    runtime: python\n    entrypoint: scripts/a.py\n`;

describe('workflow tags and categories', () => {
  it('picks the category of the first tag a category knows', () => {
    expect(categoryOf(['github', 'code-review', 'report'])).toBe('Code review');
    expect(categoryOf(['report', 'code-review'])).toBe('Reports');
    expect(categoryOf(['Digest'])).toBe('Reports');
  });

  it('says null, not a guess, when no tag names a category', () => {
    expect(categoryOf([])).toBeNull();
    expect(categoryOf(['github', 'slack'])).toBeNull();
    expect(tagsOf(null)).toEqual([]);
    expect(tagsOf(['a', 1, 'b'])).toEqual(['a', 'b']);
  });

  it('gives every tag to one category only', () => {
    const all = WORKFLOW_CATEGORIES.flatMap((c) => c.tags);
    expect(new Set(all).size).toBe(all.length);
  });

  it('accepts tags in a workflow and refuses malformed ones', () => {
    expect(loadDefinitionText(doc('tags: [code-review, github]\n')).definition?.tags).toEqual(['code-review', 'github']);
    expect(loadDefinitionText(doc('tags: [Code Review]\n')).definition).toBeUndefined();
    expect(loadDefinitionText(doc('tags: [a, a]\n')).definition).toBeUndefined();
  });

  it('files every bundled example under a category', () => {
    for (const id of readdirSync('examples')) {
      const file = join('examples', id, 'workflow.yaml');
      if (!existsSync(file)) continue;
      const def = loadDefinitionText(readFileSync(file, 'utf8')).definition;
      expect(categoryOf(tagsOf(def?.tags)), id).not.toBeNull();
    }
  });

  it('tells the builder every tag that picks a category', () => {
    const skill = readFileSync('src/builder/skill.md', 'utf8');
    for (const c of WORKFLOW_CATEGORIES) for (const t of c.tags) expect(skill, `${c.name}: ${t}`).toContain(`\`${t}\``);
  });

  it('lists an installed workflow and its marketplace entry with their tags and category', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-cat-'));
    const ctx = createContext({ databaseUrl: 'pglite://memory', dataDir: join(dir, 'data'), artifactDir: join(dir, 'artifacts') });
    const app = Fastify();
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ('ws_test','test')`);
    app.addHook('onRequest', async (req) => void (req.principal = { kind: 'user', workspaceId: 'ws_test', userId: 'usr_test', role: 'owner' } as never));
    registerExampleRoutes(app, ctx);
    await app.ready();
    const listed = ((await app.inject({ method: 'GET', url: '/v1/examples' })).json() as any[]).find((e) => e.id === 'pr-review');
    expect(listed).toMatchObject({ tags: ['code-review', 'pull-request', 'github'], category: 'Code review' });
    const r = await app.inject({ method: 'POST', url: '/v1/examples/pr-review/install', payload: { repos: ['acme/payments'], settings: { slack_channel: 'C0123ABCD' } } });
    expect(r.statusCode, r.body).toBe(200);
    const [w] = await workflowSummaries(ctx, 'ws_test');
    expect(w).toMatchObject({ slug: 'pr-review', category: 'Code review', latest: { tags: ['code-review', 'pull-request', 'github'] } });
    await app.close();
  });
});
