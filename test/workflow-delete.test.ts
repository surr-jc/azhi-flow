import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createContext } from '../src/server/context.js';
import { deleteVersion, deleteWorkflow } from '../src/server/workflows.js';

/** Deleting a workflow revision, or a whole workflow, and what happens to the runs on it. */
const WS = 'ws_del';
describe('deleting workflows and revisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-del-'));
  const ctx = createContext({ databaseUrl: 'pglite://memory', dataDir: join(dir, 'data'), artifactDir: join(dir, 'artifacts') });
  const q = (sql: string, v: unknown[] = []) => ctx.pool.query(sql, v);
  const count = async (table: string) => (await q(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

  async function seed(slug: string, versions: number) {
    await q(`INSERT INTO workflows(id, workspace_id, slug) VALUES ($1,$2,$3)`, [`wf_${slug}`, WS, slug]);
    for (let i = 1; i <= versions; i++) {
      await q(`INSERT INTO workflow_versions(id, workspace_id, workflow_id, version, package_hash, manifest, definition, plan) VALUES ($1,$2,$3,$4,$5,'{}','{}','{}')`, [`wfv_${slug}${i}`, WS, `wf_${slug}`, i, `sha256:${slug}${i}`]);
    }
  }
  const run = (id: string, version: string, parent?: string) =>
    q(`INSERT INTO runs(id, workspace_id, workflow_version_id, state, snapshot, trigger, parent_run_id) VALUES ($1,$2,$3,'succeeded','{}','manual',$4)`, [id, WS, version, parent ?? null]);

  beforeAll(async () => {
    await migrate(ctx.pool);
    await q(`INSERT INTO workspaces(id, name) VALUES ($1,'test')`, [WS]);
  });

  it('deletes a revision with no runs and keeps the workflow', async () => {
    await seed('a', 2);
    const r = await deleteVersion(ctx, WS, 'wfv_a1', 'usr');
    expect(r).toMatchObject({ version: 1, runs_deleted: 0, workflow_deleted: false });
    expect((await q(`SELECT id FROM workflow_versions WHERE workflow_id='wf_a'`)).rows).toEqual([{ id: 'wfv_a2' }]);
  });

  it('removes the workflow with its last revision, along with its schedule', async () => {
    await q(`INSERT INTO schedules(id, workspace_id, workflow_id, cron, timezone) VALUES ('sch_a',$1,'wf_a','0 * * * *','UTC')`, [WS]);
    const r = await deleteVersion(ctx, WS, 'wfv_a2', 'usr');
    expect(r.workflow_deleted).toBe(true);
    expect((await q(`SELECT 1 FROM workflows WHERE id='wf_a'`)).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM schedules WHERE id='sch_a'`)).rowCount).toBe(0);
  });

  it('refuses while runs exist, then purges runs and their history with purge_runs', async () => {
    await seed('b', 2);
    await run('run_1', 'wfv_b1');
    await run('run_2', 'wfv_b1', 'run_1');
    await q(`INSERT INTO run_events(workspace_id, run_id, kind) VALUES ($1,'run_1','run.started')`, [WS]);
    await expect(deleteVersion(ctx, WS, 'wfv_b1', 'usr')).rejects.toThrow(/2 run\(s\)/);
    expect(await count('runs')).toBe(2);
    const r = await deleteVersion(ctx, WS, 'wfv_b1', 'usr', true);
    expect(r).toMatchObject({ runs_deleted: 2, workflow_deleted: false });
    expect(await count('runs')).toBe(0);
    expect(await count('run_events')).toBe(0);
    expect((await q(`SELECT id FROM workflow_versions WHERE workflow_id='wf_b'`)).rows).toEqual([{ id: 'wfv_b2' }]);
  });

  it('deletes a whole workflow, and refuses an unknown one', async () => {
    await run('run_3', 'wfv_b2');
    await expect(deleteWorkflow(ctx, WS, 'b', 'usr')).rejects.toThrow(/run\(s\)/);
    const r = await deleteWorkflow(ctx, WS, 'b', 'usr', true);
    expect(r).toMatchObject({ versions_deleted: 1, runs_deleted: 1, workflow_deleted: true });
    await expect(deleteWorkflow(ctx, WS, 'b', 'usr')).rejects.toThrow(/not found/);
    expect((await q(`SELECT 1 FROM audit_events WHERE kind='workflow.deleted'`)).rowCount).toBe(1);
  });
});
