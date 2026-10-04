import { CronExpressionParser } from 'cron-parser';
import { compile } from '../compiler/compile.js';
import type { ExecutionPlan } from '../compiler/plan.js';
import { loadDefinitionText, type Diagnostic } from '../definition/load.js';
import { packageFromFiles, type PackageManifest } from '../definition/package.js';
import type { WorkflowDefinition } from '../definition/types.js';
import { newId } from '../lib/ids.js';
import { audit, loadCatalog } from './catalog.js';
import type { AppContext } from './context.js';

export interface VersionRow {
  id: string;
  workflow_id: string;
  slug: string;
  version: number;
  package_hash: string;
  manifest: PackageManifest;
  definition: WorkflowDefinition;
  plan: ExecutionPlan;
  draft: boolean;
  signature: unknown;
}

/**
 * Stores an uploaded package: every file goes to the artifact store by content hash, the
 * definition is compiled against the workspace catalog, and a workflow version is created
 * (or reused when the same package was uploaded before).
 */
export async function uploadPackage(
  ctx: AppContext,
  workspaceId: string,
  upload: { workflow: string; files: Record<string, string> },
  actor: string,
): Promise<{ ok: true; version: VersionRow; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] }> {
  const files = new Map(Object.entries(upload.files).map(([p, b64]) => [p, Buffer.from(b64, 'base64')]));
  const pkg = packageFromFiles(upload.workflow, files);
  const loaded = loadDefinitionText(pkg.readText(upload.workflow) ?? '');
  if (!loaded.definition) return { ok: false, diagnostics: loaded.diagnostics };
  const catalog = await loadCatalog(ctx, workspaceId);
  // Dataset trust feeds taint analysis; unknown datasets are treated as trusted until they exist.
  const trust = new Map((await ctx.pool.query(`SELECT name, trusted FROM datasets WHERE workspace_id=$1`, [workspaceId])).rows.map((r) => [r.name as string, r.trusted as boolean]));
  const compiled = compile(loaded.definition, { pkg, catalog, datasets: (ref) => (trust.has(ref.split('@')[0]!) ? { trusted: trust.get(ref.split('@')[0]!)! } : undefined) });
  if (!compiled.ok) return { ok: false, diagnostics: compiled.diagnostics };

  for (const data of files.values()) {
    const a = ctx.artifacts.put(data);
    await ctx.pool.query(`INSERT INTO artifacts(workspace_id, hash, size, media_type) VALUES ($1,$2,$3,'application/octet-stream') ON CONFLICT DO NOTHING`, [
      workspaceId,
      a.hash,
      a.size,
    ]);
  }

  const slug = loaded.definition.id;
  await ctx.pool.query(`INSERT INTO workflows(id, workspace_id, slug) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, slug) DO NOTHING`, [newId('wf'), workspaceId, slug]);
  const workflowId = (await ctx.pool.query(`SELECT id FROM workflows WHERE workspace_id=$1 AND slug=$2`, [workspaceId, slug])).rows[0].id as string;
  const existing = await getVersionBy(ctx, workspaceId, `v.workflow_id=$2 AND v.package_hash=$3`, [workflowId, pkg.hash]);
  if (existing) return { ok: true, version: existing, diagnostics: compiled.diagnostics };

  const id = newId('wfv');
  await ctx.pool.query(
    `INSERT INTO workflow_versions(id, workspace_id, workflow_id, version, package_hash, manifest, definition, plan, published_by)
     SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, $4, $5, $6, $7, $8 FROM workflow_versions WHERE workflow_id=$3`,
    [id, workspaceId, workflowId, pkg.hash, JSON.stringify(pkg.manifest), JSON.stringify(loaded.definition), JSON.stringify(compiled.plan), actor],
  );
  await audit(ctx, workspaceId, actor, 'workflow.version_created', { workflow: slug, version_id: id, package_hash: pkg.hash });
  return { ok: true, version: (await getVersion(ctx, workspaceId, id))!, diagnostics: compiled.diagnostics };
}

const VERSION_SELECT = `SELECT v.id, v.workflow_id, w.slug, v.version, v.package_hash, v.manifest, v.definition, v.plan, v.draft, v.signature
  FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.workspace_id=$1 AND `;

async function getVersionBy(ctx: AppContext, workspaceId: string, where: string, params: unknown[]): Promise<VersionRow | undefined> {
  return (await ctx.pool.query(`${VERSION_SELECT} ${where} ORDER BY v.version DESC LIMIT 1`, [workspaceId, ...params])).rows[0];
}

export function getVersion(ctx: AppContext, workspaceId: string, id: string) {
  return getVersionBy(ctx, workspaceId, `v.id=$2`, [id]);
}

/** `slug`, `slug@3`, or `slug@latest` (latest published). */
export async function resolveVersion(ctx: AppContext, workspaceId: string, ref: string): Promise<VersionRow | undefined> {
  if (ref.startsWith('wfv_')) return getVersion(ctx, workspaceId, ref);
  const [slug, v] = ref.split('@');
  if (v && v !== 'latest') return getVersionBy(ctx, workspaceId, `w.slug=$2 AND v.version=$3`, [slug, Number(v)]);
  return getVersionBy(ctx, workspaceId, `w.slug=$2 AND v.draft=false`, [slug]);
}

/** Marks a version published and syncs its schedule from the definition's trigger. */
export async function publishVersion(ctx: AppContext, workspaceId: string, versionId: string, actor: string, signature?: unknown): Promise<VersionRow> {
  await ctx.pool.query(`UPDATE workflow_versions SET draft=false, signature=COALESCE($3, signature), published_by=$4 WHERE id=$1 AND workspace_id=$2`, [
    versionId,
    workspaceId,
    signature === undefined ? null : JSON.stringify(signature),
    actor,
  ]);
  const version = (await getVersion(ctx, workspaceId, versionId))!;
  const schedule = version.definition.trigger?.schedule;
  if (schedule) await upsertSchedule(ctx, workspaceId, version.workflow_id, schedule.cron, schedule.timezone, {});
  await audit(ctx, workspaceId, actor, 'workflow.published', { workflow: version.slug, version: version.version, package_hash: version.package_hash });
  return version;
}

export async function upsertSchedule(ctx: AppContext, workspaceId: string, workflowId: string, cron: string, timezone: string, inputs: Record<string, unknown>, enabled = true) {
  const next = CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date() }).next().toDate();
  const id = `sch_${workflowId.slice(3)}`;
  await ctx.pool.query(
    `INSERT INTO schedules(id, workspace_id, workflow_id, cron, timezone, inputs, enabled, next_occurrence_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET cron=$4, timezone=$5, inputs=CASE WHEN $6::jsonb = '{}'::jsonb THEN schedules.inputs ELSE $6::jsonb END, enabled=$7,
       next_occurrence_at=CASE WHEN schedules.cron=$4 AND schedules.timezone=$5 THEN schedules.next_occurrence_at ELSE $8 END`,
    [id, workspaceId, workflowId, cron, timezone, JSON.stringify(inputs), enabled, next],
  );
  return id;
}
