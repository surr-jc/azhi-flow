import { BUILTIN_TOOLS } from '../gateway/executors.js';
import { toolRef, type ToolCatalog, type ToolSpec } from '../gateway/types.js';
import { contentHash } from '../lib/hash.js';
import type { AppContext } from './context.js';

/** The workspace tool catalog: the latest revision of each registered tool@version plus built-ins. */
export async function loadCatalog(ctx: AppContext, workspaceId: string): Promise<ToolCatalog & { revisions: Map<string, number> }> {
  const rows = (
    await ctx.pool.query(
      `SELECT DISTINCT ON (tool_id, version) tool_id, version, revision, spec FROM tools
       WHERE workspace_id=$1 ORDER BY tool_id, version, revision DESC`,
      [workspaceId],
    )
  ).rows as Array<{ revision: number; spec: ToolSpec }>;
  const specs = new Map<string, ToolSpec>(BUILTIN_TOOLS.map((t) => [toolRef(t), t]));
  for (const r of rows) specs.set(toolRef(r.spec), { ...r.spec, revision: r.revision });
  return {
    get: (ref) => specs.get(ref),
    list: () => [...specs.values()],
    revisions: new Map([...specs].map(([k, v]) => [k, v.revision ?? 0])),
  };
}

/** Loads a pinned revision, as recorded in a run's snapshot. */
export async function loadToolRevision(ctx: AppContext, workspaceId: string, ref: string, revision: number | undefined): Promise<ToolSpec | undefined> {
  const builtin = BUILTIN_TOOLS.find((t) => toolRef(t) === ref);
  if (builtin) return builtin;
  const [id, version] = [ref.slice(0, ref.lastIndexOf('@')), Number(ref.slice(ref.lastIndexOf('@') + 1))];
  const r = await ctx.pool.query(
    revision === undefined
      ? `SELECT spec, revision FROM tools WHERE workspace_id=$1 AND tool_id=$2 AND version=$3 ORDER BY revision DESC LIMIT 1`
      : `SELECT spec, revision FROM tools WHERE workspace_id=$1 AND tool_id=$2 AND version=$3 AND revision=$4`,
    revision === undefined ? [workspaceId, id, version] : [workspaceId, id, version, revision],
  );
  const row = r.rows[0];
  return row ? { ...(row.spec as ToolSpec), revision: row.revision } : undefined;
}

/** Registers a tool. A changed spec creates a new revision; an identical one is a no-op. */
export async function registerTool(ctx: AppContext, workspaceId: string, spec: ToolSpec, actor: string): Promise<{ revision: number; changed: boolean }> {
  const { revision: _ignored, ...clean } = spec;
  const hash = contentHash(clean);
  const latest = (
    await ctx.pool.query(`SELECT revision, spec_hash FROM tools WHERE workspace_id=$1 AND tool_id=$2 AND version=$3 ORDER BY revision DESC LIMIT 1`, [
      workspaceId,
      spec.id,
      spec.version,
    ])
  ).rows[0] as { revision: number; spec_hash: string } | undefined;
  if (latest?.spec_hash === hash) return { revision: latest.revision, changed: false };
  const revision = (latest?.revision ?? 0) + 1;
  await ctx.pool.query(`INSERT INTO tools(workspace_id, tool_id, version, revision, spec, spec_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    workspaceId,
    spec.id,
    spec.version,
    revision,
    JSON.stringify(clean),
    hash,
    actor,
  ]);
  await audit(ctx, workspaceId, actor, 'tool.registered', { tool: toolRef(spec), revision });
  return { revision, changed: true };
}

export async function audit(ctx: AppContext, workspaceId: string, actor: string | null, kind: string, data: Record<string, unknown>) {
  await ctx.pool.query(`INSERT INTO audit_events(workspace_id, actor, kind, data) VALUES ($1,$2,$3,$4)`, [workspaceId, actor, kind, JSON.stringify(data)]);
}
