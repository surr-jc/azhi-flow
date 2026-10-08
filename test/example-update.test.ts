import Fastify from 'fastify';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { registerExampleRoutes } from '../src/api/examples.js';
import { migrate } from '../src/db/migrate.js';
import { createContext } from '../src/server/context.js';
import { loadToolRevision } from '../src/server/catalog.js';
import { getVersion } from '../src/server/workflows.js';
import { packageFile } from '../src/server/packages.js';

/**
 * Updating an installed marketplace workflow: the marketplace's changes come in, local edits stay.
 * Runs against the embedded database and the real pr-review example, copied so the test can
 * change the "marketplace" copy. No Temporal or worker is needed.
 */
const WS = 'ws_test';
describe('updating an installed marketplace workflow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-mkt-'));
  const examples = join(dir, 'examples');
  const ctx = createContext({ databaseUrl: 'pglite://memory', dataDir: join(dir, 'data'), artifactDir: join(dir, 'artifacts') });
  const app = Fastify();
  const post = async (url: string, body: unknown = {}) => {
    const r = await app.inject({ method: 'POST', url, payload: body as object });
    if (r.statusCode >= 400) throw new Error(`${url}: ${r.statusCode} ${r.body}`);
    return r.json() as any;
  };
  const get = async (url: string) => (await app.inject({ method: 'GET', url })).json() as any;
  const wfFile = () => join(examples, 'pr-review', 'workflow.yaml');
  const files = async (versionId: string) => {
    const v = (await getVersion(ctx, WS, versionId))!;
    return { v, text: async (p: string) => (await packageFile(ctx, WS, v.package_hash, p)).toString('utf8') };
  };

  beforeAll(async () => {
    process.env.AZHI_EXAMPLES_DIR = examples;
    cpSync('examples/pr-review', join(examples, 'pr-review'), { recursive: true });
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,'test')`, [WS]).catch(() => undefined);
    app.addHook('onRequest', async (req) => void (req.principal = { kind: 'user', workspaceId: WS, userId: 'usr_test', role: 'owner' } as never));
    registerExampleRoutes(app, ctx);
    await app.ready();
  });
  afterAll(async () => void (await app.close()));

  it('lists no update before install, installs, then lists none', async () => {
    expect((await get('/v1/examples')).find((e: any) => e.id === 'pr-review').update).toBeNull();
    const r = await post('/v1/examples/pr-review/install', { repos: ['acme/payments'], settings: { slack_channel: 'C0123ABCD' } });
    expect(r.ok).toBe(true);
    expect((await get('/v1/examples')).find((e: any) => e.id === 'pr-review').update).toMatchObject({ available: false, tracked: true, version: 1 });
  });

  it('keeps a local edit and a local repository, and loads what the marketplace added', async () => {
    // Local edit: a longer timeout on the security reviewer, saved as a new version of the workflow.
    const first = (await get('/v1/examples')).find((e: any) => e.id === 'pr-review');
    expect(first.update.version).toBe(1);
    const cur = (await ctx.pool.query(`SELECT v.id FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id WHERE w.slug='pr-review' ORDER BY v.version DESC LIMIT 1`)).rows[0].id;
    const { v, text } = await files(cur);
    const edited = new Map<string, string>();
    for (const f of v.manifest.files) edited.set(f.path, f.path === 'workflow.yaml' ? (await text(f.path)).replace(/(id: security[\s\S]*?timeout: )15m/, '$130m') : (await text(f.path)));
    const { uploadPackage } = await import('../src/server/workflows.js');
    const up = await uploadPackage(ctx, WS, { workflow: 'workflow.yaml', files: Object.fromEntries([...edited].map(([k, t]) => [k, Buffer.from(t).toString('base64')])) }, 'usr_test');
    expect(up.ok).toBe(true);
    // A repository added to the tools here (what the Connections popup does).
    const spec = (await loadToolRevision(ctx, WS, 'github.get-pull-request@1', undefined))!;
    const { registerTool } = await import('../src/server/catalog.js');
    const cfg = (spec.transport as any).config;
    await registerTool(ctx, WS, { ...spec, transport: { ...spec.transport, config: { ...cfg, repos: [...cfg.repos, 'acme/ledger'] } } } as never, 'usr_test');

    // The marketplace changes: the correctness reviewer gets more tool calls and a description, plus a new setting on the pr step.
    const text2 = readFileSync(wfFile(), 'utf8')
      .replace(/(id: correctness[\s\S]*?budget: \{max_tool_calls: )10/, '$120')
      .replace('description: Read the pull request and its changed files from GitHub.', 'description: Read the pull request, its changed files and checks from GitHub.');
    writeFileSync(wfFile(), text2);

    expect((await get('/v1/examples')).find((e: any) => e.id === 'pr-review').update).toMatchObject({ available: true });
    const dry = await post('/v1/examples/pr-review/update', { dry_run: true });
    expect(dry).toMatchObject({ ok: true, dry_run: true });
    expect(dry.report.changes).toContainEqual(expect.objectContaining({ scope: 'step', target: 'correctness', field: 'budget', kind: 'updated' }));
    expect(dry.report.summary.conflicts).toBe(0);
    expect(dry.report.kept).toBeGreaterThan(0);
    // A dry run changes nothing.
    expect((await get('/v1/examples')).find((e: any) => e.id === 'pr-review').update.version).toBe(2);

    const done = await post('/v1/examples/pr-review/update', {});
    expect(done).toMatchObject({ ok: true, updated: true, version: { version: 3, draft: true } });
    const merged = parse((await (await files(done.version.id)).text('workflow.yaml'))) as { nodes: Array<Record<string, any>> };
    const node = (id: string) => merged.nodes.find((n) => n.id === id)!;
    expect(node('security').timeout).toBe('30m'); // local edit kept
    expect(node('correctness').budget.max_tool_calls).toBe(20); // marketplace change applied
    expect(node('pr').description).toContain('and checks'); // new text loaded
    expect(node('summarize')).toBeTruthy();
    // The local repository list survives the tool update.
    expect(((await loadToolRevision(ctx, WS, 'github.get-pull-request@1', undefined))!.transport as any).config.repos).toEqual(['acme/payments', 'acme/ledger']);

    // Nothing more to update afterwards, and a second run reports nothing.
    expect((await get('/v1/examples')).find((e: any) => e.id === 'pr-review').update.available).toBe(false);
    const again = await post('/v1/examples/pr-review/update', {});
    expect(again.report, JSON.stringify(again.report)).toMatchObject({ nothing_to_update: true });
    expect(again).toMatchObject({ ok: true, updated: false });
  });

  it('adds a step the marketplace gained and reports a setting both sides changed', async () => {
    const latest = (await ctx.pool.query(`SELECT v.id FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id WHERE w.slug='pr-review' ORDER BY v.version DESC LIMIT 1`)).rows[0].id;
    const { v, text } = await files(latest);
    const { uploadPackage } = await import('../src/server/workflows.js');
    const local = new Map<string, string>();
    for (const f of v.manifest.files) local.set(f.path, f.path === 'workflow.yaml' ? (await text(f.path)).replace(/(id: tests[\s\S]*?timeout: )15m/, '$145m') : await text(f.path));
    await uploadPackage(ctx, WS, { workflow: 'workflow.yaml', files: Object.fromEntries([...local].map(([k, t]) => [k, Buffer.from(t).toString('base64')])) }, 'usr_test');
    const upstream = readFileSync(wfFile(), 'utf8')
      .replace(/(id: tests[\s\S]*?timeout: )15m/, '$110m')
      .replace('  - id: notify\n', '  - id: audit_note\n    type: report\n    description: A note kept for the audit trail.\n    template: templates/slack.md\n    input: {map: "{\'pr\': nodes.pr.output, \'review\': nodes.summarize.output, \'merge\': {\'conflicts\': false}}"}\n\n  - id: notify\n');
    writeFileSync(wfFile(), upstream);
    const r = await post('/v1/examples/pr-review/update', {});
    expect(r.report.changes).toContainEqual(expect.objectContaining({ target: 'audit_note', kind: 'added' }));
    expect(r.report.changes).toContainEqual(expect.objectContaining({ target: 'tests', field: 'timeout', kind: 'conflict' }));
    const merged = parse(await (await files(r.version.id)).text('workflow.yaml')) as { nodes: Array<Record<string, any>> };
    expect(merged.nodes.find((n) => n.id === 'tests')!.timeout).toBe('45m');
    expect(merged.nodes.some((n) => n.id === 'audit_note')).toBe(true);
  });

  it('only admins may update', async () => {
    const other = Fastify();
    other.addHook('onRequest', async (req) => void (req.principal = { kind: 'user', workspaceId: WS, userId: 'usr_x', role: 'author' } as never));
    registerExampleRoutes(other, ctx);
    expect((await other.inject({ method: 'POST', url: '/v1/examples/pr-review/update', payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
    await other.close();
  });
});
