import Fastify from 'fastify';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerBundleRoutes } from '../src/api/bundle.js';
import { registerExampleRoutes } from '../src/api/examples.js';
import { migrate } from '../src/db/migrate.js';
import { AzhiError, ErrorClass } from '../src/lib/errors.js';
import { sha256 } from '../src/lib/hash.js';
import { readZip, writeZip } from '../src/lib/zip.js';
import { addDocuments, createDataset, publishRevision, resolveDatasetRef } from '../src/knowledge/datasets.js';
import { attachAsset, createAsset, publishAsset } from '../src/server/assets.js';
import { loadToolRevision } from '../src/server/catalog.js';
import { createContext } from '../src/server/context.js';
import { getVersion } from '../src/server/workflows.js';

/**
 * Exporting a workflow with everything it uses and importing it into another workspace, in add and
 * override modes. Runs on the embedded database with the real quality-report example (it has tools
 * and a knowledge dataset); no Temporal or worker is needed.
 */
const A = 'ws_a';
const B = 'ws_b';
describe('workflow bundles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-bundle-'));
  const ctx = createContext({ databaseUrl: 'pglite://memory', dataDir: join(dir, 'data'), artifactDir: join(dir, 'artifacts') });
  // The request's workspace: the hook below reads it, so a test picks A or B before calling.
  let ws = A;
  const app = Fastify();
  const post = async (url: string, body: unknown = {}) => {
    const r = await app.inject({ method: 'POST', url, payload: body as object });
    if (r.statusCode >= 400) throw new Error(`${url}: ${r.statusCode} ${r.body}`);
    return r.json() as any;
  };
  const exportFrom = async (workspace: string) => {
    ws = workspace;
    const r = await app.inject({ method: 'GET', url: '/v1/workflows/quality-report/export' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    return r.rawPayload;
  };
  const importInto = async (workspace: string, zip: Buffer, mode: string, dry = false, role = 'owner') => {
    ws = workspace;
    const r = await app.inject({ method: 'POST', url: `/v1/workflows/import?mode=${mode}&dry_run=${dry}`, headers: { 'content-type': 'application/zip', 'x-test-role': role }, payload: zip });
    return { status: r.statusCode, body: r.json() as any };
  };
  const action = (report: any, kind: string, name: string) => report.items.find((i: any) => i.kind === kind && i.name === name)?.action;

  beforeAll(async () => {
    app.setErrorHandler((err, _req, reply) => {
      const status = err instanceof AzhiError ? (err.errorClass === ErrorClass.authorization ? 403 : err.errorClass === ErrorClass.invalidInput ? 400 : 500) : 500;
      return reply.status(status).send({ message: (err as Error).message });
    });
    await migrate(ctx.pool);
    for (const id of [A, B]) await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,$1)`, [id]);
    app.addHook('onRequest', async (req) => void (req.principal = { kind: 'user', workspaceId: ws, userId: 'usr_test', role: (req.headers['x-test-role'] as string) ?? 'owner' } as never));
    registerExampleRoutes(app, ctx);
    registerBundleRoutes(app, ctx);
    await app.ready();

    // Workspace A: the example's tools and workflow, its dataset, and a library skill attached to it.
    await createDataset(ctx, A, { name: 'quality-guidelines', trusted: true });
    const kb = 'examples/quality-report/knowledge';
    await addDocuments(ctx, A, 'quality-guidelines', readdirSync(kb).map((f) => ({ path: f, content: readFileSync(join(kb, f), 'utf8') })));
    await publishRevision(ctx, A, 'quality-guidelines', 'approved');
    ws = A;
    await post('/v1/examples/quality-report/install');
    const skill = await createAsset(ctx, A, { kind: 'skill', slug: 'triage', name: 'Triage', definition: { description: 'Triage failures', instructions: 'Group by cause.' } }, 'usr_test');
    await publishAsset(ctx, A, skill!.id, 'usr_test');
    await attachAsset(ctx, A, 'quality-report', skill!.id, undefined, 'usr_test');
  });
  afterAll(async () => void (await app.close()));

  it('packs the package, tools, datasets, assets and harness files', async () => {
    const files = readZip(await exportFrom(A));
    const names = [...files.keys()];
    expect(names).toContain('bundle.json');
    expect(names).toContain('package/workflow.yaml');
    expect(names.some((n) => n.startsWith('tools/'))).toBe(true);
    expect(names).toContain('assets/skill/triage.json');
    expect(names).toContain('datasets/quality-guidelines/dataset.json');
    expect(names.some((n) => n.startsWith('datasets/quality-guidelines/docs/'))).toBe(true);
    expect(names).toContain('harness/opencode/.opencode/skills/triage/SKILL.md');
    expect(names).toContain('harness/claude-code/.claude/skills/triage/SKILL.md');
    expect(JSON.parse(files.get('bundle.json')!.toString()).format).toBe('azhi-workflow-bundle/1');
  });

  it('reports a dry run without writing anything', async () => {
    const r = await importInto(B, await exportFrom(A), 'add', true);
    expect(r.body.dry_run).toBe(true);
    expect(action(r.body, 'workflow', 'quality-report')).toBe('create');
    expect(action(r.body, 'dataset', 'quality-guidelines')).toBe('create');
    expect(action(r.body, 'asset', 'skill: triage')).toBe('create');
    expect((await ctx.pool.query(`SELECT 1 FROM workflows WHERE workspace_id=$1`, [B])).rowCount).toBe(0);
  });

  it('adds everything to a new workspace, then in add mode leaves it all alone', async () => {
    const zip = await exportFrom(A);
    const first = await importInto(B, zip, 'add');
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.version.draft).toBe(true);
    expect((await getVersion(ctx, B, first.body.version.id))!.manifest.files.length).toBeGreaterThan(3);
    expect(await resolveDatasetRef(ctx, B, 'quality-guidelines@approved')).toBeTruthy();
    expect(await loadToolRevision(ctx, B, first.body.items.find((i: any) => i.kind === 'tool').name, undefined)).toBeTruthy();
    expect((await ctx.pool.query(`SELECT 1 FROM workflow_portable_assets WHERE workspace_id=$1`, [B])).rowCount).toBe(1);

    const again = await importInto(B, zip, 'add');
    expect(again.body.items.every((i: any) => i.action === 'unchanged')).toBe(true);
    expect(again.body.version.version).toBe(first.body.version.version);
  });

  it('keeps existing items in add mode and replaces them in override mode', async () => {
    const skillId = (await ctx.pool.query(`SELECT id FROM portable_assets WHERE workspace_id=$1 AND slug='triage'`, [B])).rows[0].id as string;
    const bundle = readZip(await exportFrom(A));
    const path = 'assets/skill/triage.json';
    bundle.set(path, Buffer.from(JSON.stringify({ kind: 'skill', slug: 'triage', name: 'Triage', description: '', scope: 'global', version: 1, definition: { description: 'Triage failures', instructions: 'Group by owner.' } })));
    const index = JSON.parse(bundle.get('bundle.json')!.toString());
    index.files[path] = sha256(bundle.get(path)!);
    bundle.set('bundle.json', Buffer.from(JSON.stringify(index)));
    const zip = writeZip(bundle);

    expect(action((await importInto(B, zip, 'add')).body, 'asset', 'skill: triage')).toBe('skip');
    expect(action((await importInto(B, zip, 'override')).body, 'asset', 'skill: triage')).toBe('replace');
    const row = (await ctx.pool.query(`SELECT a.current_version, v.definition FROM portable_assets a JOIN portable_asset_versions v ON v.asset_id=a.id AND v.version=a.current_version WHERE a.id=$1`, [skillId])).rows[0];
    expect(row.current_version).toBe(2);
    expect(row.definition.instructions).toBe('Group by owner.');
  });

  it('refuses tampered or unsafe bundles and non-admins', async () => {
    const files = readZip(await exportFrom(A));
    files.set('package/workflow.yaml', Buffer.from('id: evil\n'));
    const tampered = await importInto(B, writeZip(files), 'add');
    expect(tampered.status).toBe(400);
    expect(tampered.body.message).toMatch(/does not match the bundle index/);

    expect((await importInto(B, writeZip(new Map([['../escape.txt', Buffer.from('x')]])), 'add')).status).toBe(400);
    expect((await importInto(B, Buffer.from('not a zip'), 'add')).status).toBe(400);
    expect((await importInto(B, await exportFrom(A), 'add', true, 'author')).status).toBe(403);
  });
});
