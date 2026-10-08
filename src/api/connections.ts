import type { FastifyInstance } from 'fastify';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { loadCatalog } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';

/**
 * Where each tool, secret and dataset is used: for the Connections page, so a change to a token,
 * a repository list or a dataset can be judged by the steps it touches. Reads the newest version
 * of every workflow in the workspace (a draft counts), and the action ledger for recent writes.
 */
export interface Use { workflow: string; node: string; version: number; draft: boolean }
export interface ConnectionUsage {
  tools: Record<string, Use[]>;
  secrets: Record<string, Use[]>;
  datasets: Record<string, Use[]>;
  /** Writes recorded in the last 7 days, per tool, by outcome. */
  writes: Record<string, { confirmed: number; failed: number; unknown: number }>;
}

export async function connectionUsage(ctx: AppContext, workspaceId: string): Promise<ConnectionUsage> {
  const catalog = await loadCatalog(ctx, workspaceId);
  const versions = (
    await ctx.pool.query(
      `SELECT DISTINCT ON (w.slug) w.slug, v.version, v.draft, v.plan
       FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.workspace_id=$1 ORDER BY w.slug, v.version DESC`,
      [workspaceId],
    )
  ).rows as Array<{ slug: string; version: number; draft: boolean; plan: { nodes?: Array<{ id: string; type: string; def?: Record<string, any> }> } }>;
  const out: ConnectionUsage = { tools: {}, secrets: {}, datasets: {}, writes: {} };
  const add = (bucket: Record<string, Use[]>, key: unknown, use: Use) => {
    if (typeof key !== 'string' || !key) return;
    const list = (bucket[key] ??= []);
    if (!list.some((u) => u.workflow === use.workflow && u.node === use.node)) list.push(use);
  };
  for (const v of versions) {
    for (const n of v.plan?.nodes ?? []) {
      const def = n.def ?? {};
      const use: Use = { workflow: v.slug, node: n.id, version: v.version, draft: v.draft };
      let tools: unknown[] = [];
      if (n.type === 'tool') tools = [def.tool];
      else if (n.type === 'notify') tools = ['slack.post-message@1'];
      else if (n.type === 'agent' && Array.isArray(def.tools)) tools = def.tools.filter((t: unknown) => typeof t === 'string');
      for (const ref of tools) {
        add(out.tools, ref, use);
        if (typeof ref === 'string') add(out.secrets, catalog.get(ref)?.credential, use);
      }
      add(out.secrets, def.workspace?.credential, use);
      for (const d of Array.isArray(def.datasets) ? def.datasets : []) add(out.datasets, typeof d === 'string' ? d.split('@')[0] : undefined, use);
    }
  }
  const rows = (
    await ctx.pool.query(`SELECT tool, state, count(*)::int AS n FROM actions WHERE workspace_id=$1 AND created_at > now() - interval '7 days' GROUP BY tool, state`, [workspaceId])
  ).rows as Array<{ tool: string; state: string; n: number }>;
  for (const r of rows) {
    const w = (out.writes[r.tool] ??= { confirmed: 0, failed: 0, unknown: 0 });
    if (r.state === 'confirmed') w.confirmed += r.n;
    else if (r.state === 'failed') w.failed += r.n;
    else if (r.state === 'outcome_unknown') w.unknown += r.n;
  }
  return out;
}

export function registerConnectionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/connections/usage', async (req) => {
    if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
    return connectionUsage(ctx, req.principal.workspaceId);
  });
}
