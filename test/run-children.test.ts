import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createContext } from '../src/server/context.js';
import { getRunDetail } from '../src/server/runs.js';

/** A parent run's detail lists its subworkflow runs, found through the snapshot the run was created with. */
const WS = 'ws_kids';
describe('subworkflow runs on the parent run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-kids-'));
  const ctx = createContext({ databaseUrl: 'pglite://memory', dataDir: join(dir, 'data'), artifactDir: join(dir, 'artifacts') });
  const q = (sql: string, v: unknown[] = []) => ctx.pool.query(sql, v);
  const run = (id: string, trigger: string, snapshot: object) =>
    q(`INSERT INTO runs(id, workspace_id, workflow_version_id, state, snapshot, trigger) VALUES ($1,$2,'wfv_k1','succeeded',$3,$4)`, [id, WS, JSON.stringify(snapshot), trigger]);

  beforeAll(async () => {
    await migrate(ctx.pool);
    await q(`INSERT INTO workspaces(id, name) VALUES ($1,'test')`, [WS]);
    await q(`INSERT INTO workflows(id, workspace_id, slug) VALUES ('wf_k',$1,'kids')`, [WS]);
    await q(`INSERT INTO workflow_versions(id, workspace_id, workflow_id, version, package_hash, manifest, definition, plan) VALUES ('wfv_k1',$1,'wf_k',1,'sha256:k','{}','{}','{}')`, [WS]);
    await run('run_parent', 'manual', {});
    await run('run_child', 'subworkflow', { parent: { run_id: 'run_parent', node_id: 'split', chain: [] } });
    await run('run_other', 'manual', {});
  });

  it('returns the child with the step that started it', async () => {
    const d = await getRunDetail(ctx, WS, 'run_parent');
    expect(d?.children).toMatchObject([{ id: 'run_child', parent_node_id: 'split', workflow: 'kids', trigger: 'subworkflow' }]);
  });

  it('returns no children for a run that started none', async () => {
    expect((await getRunDetail(ctx, WS, 'run_other'))?.children).toEqual([]);
  });
});
