import type { FastifyInstance } from 'fastify';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { listDatasets } from '../knowledge/datasets.js';
import { listAssets, type AssetKind } from '../server/assets.js';
import { loadCatalog } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { listMcpConnections } from '../server/mcp.js';
import { listSecrets } from '../server/secrets.js';
import { connectionUsage, type Use } from './connections.js';

/**
 * The toolbox: everything an agent can be given, in one list. Gateway tools (grouped by system),
 * hosted gateway connections, library MCP servers, skills, agents and commands, and datasets,
 * each with a plain name, a status and how many workflows use it. The page and the step editor
 * read this instead of three separate pages. Nothing here is a secret: values are never read,
 * only whether a named secret exists (admins only; for anyone else the status is `unknown`).
 */
export type ToolboxGroup = 'apps' | 'skills' | 'roles' | 'knowledge';
/** `unknown` means this person cannot see whether the credential is set; it is never guessed. */
export type ToolboxStatus = 'ready' | 'needs_setup' | 'draft' | 'unknown';

export interface ToolboxItem {
  id: string;
  group: ToolboxGroup;
  kind: 'app' | 'connection' | AssetKind | 'dataset';
  name: string;
  summary: string;
  status: ToolboxStatus;
  status_note: string | null;
  /** True when any action of the item writes outside Azhi. Null for items where that is not known. */
  changes_things: boolean | null;
  runs_code: boolean;
  /** Names of the secrets or environment values the item needs before it works. */
  needs: string[];
  used_by: number;
  href: string;
  details: Record<string, unknown>;
}

const SYSTEM_NAMES: Record<string, string> = { github: 'GitHub', slack: 'Slack', jira: 'Jira', ci: 'CI', ticket: 'Tickets' };
const titleCase = (s: string) => SYSTEM_NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const workflowsOf = (uses: Use[][]) => new Set(uses.flat().map((u) => u.workflow)).size;
const groupOfAsset = (k: AssetKind): ToolboxGroup => (k === 'mcp' ? 'apps' : k === 'skill' ? 'skills' : 'roles');

export async function toolbox(ctx: AppContext, workspaceId: string, canSeeSecrets: boolean): Promise<ToolboxItem[]> {
  const [catalog, usage, assets, datasets, connections, secrets, attached] = await Promise.all([
    loadCatalog(ctx, workspaceId),
    connectionUsage(ctx, workspaceId),
    listAssets(ctx, workspaceId),
    listDatasets(ctx, workspaceId),
    listMcpConnections(ctx, workspaceId),
    canSeeSecrets ? listSecrets(ctx, workspaceId) : Promise.resolve(undefined),
    ctx.pool.query(`SELECT asset_id, count(DISTINCT workflow_id)::int AS n FROM workflow_portable_assets WHERE workspace_id=$1 GROUP BY asset_id`, [workspaceId]),
  ]);
  const secretNames = secrets ? new Set(secrets.map((s) => s.name)) : undefined;
  const attachedCount = new Map<string, number>((attached.rows as Array<{ asset_id: string; n: number }>).map((r) => [r.asset_id, r.n]));
  const items: ToolboxItem[] = [];

  // Gateway tools, one card per system. Tools of a hosted connection belong to that connection's card.
  const bySystem = new Map<string, ReturnType<typeof catalog.list>>();
  const byConnection = new Map<string, ReturnType<typeof catalog.list>>();
  for (const t of catalog.list()) {
    const conn = t.transport.kind === 'mcp-streamable-http' ? t.transport.connection : undefined;
    const bucket = conn ? byConnection : bySystem;
    const key = conn ?? t.id.split('.')[0]!;
    bucket.set(key, [...(bucket.get(key) ?? []), t]);
  }
  const toolRows = (list: ReturnType<typeof catalog.list>) => list.map((t) => ({ ref: `${t.id}@${t.version}`, description: t.description, effect: t.effect, credential: t.credential ?? null }));
  const usedBy = (list: ReturnType<typeof catalog.list>) => workflowsOf(list.map((t) => usage.tools[`${t.id}@${t.version}`] ?? []));
  for (const [system, list] of bySystem) {
    const credentials = [...new Set(list.map((t) => t.credential).filter((c): c is string => Boolean(c)))];
    const missing = secretNames ? credentials.filter((c) => !secretNames.has(c)) : [];
    const writes = list.filter((t) => t.effect !== 'read').length;
    items.push({
      id: `app:${system}`, group: 'apps', kind: 'app', name: titleCase(system),
      summary: `${plural(list.length, 'action')}${writes ? `, ${writes} can change things` : ', all read-only'}`,
      status: missing.length ? 'needs_setup' : credentials.length && !secretNames ? 'unknown' : 'ready',
      status_note: missing.length ? (missing.length === 1 ? `Add the ${missing[0]} secret` : `Add these secrets: ${missing.join(', ')}`) : null,
      changes_things: writes > 0, runs_code: false, needs: credentials, used_by: usedBy(list),
      href: `/ui/connections/${encodeURIComponent(system)}`, details: { tools: toolRows(list) },
    });
  }
  // Hosted gateway connections: shown even before any of their tools are registered.
  for (const c of connections) {
    const list = byConnection.get(c.name) ?? [];
    const ready = c.status === 'ready';
    const writes = list.filter((t) => t.effect !== 'read').length;
    let host = c.url;
    try { host = new URL(c.url).host; } catch { /* keep the stored text */ }
    items.push({
      id: `connection:${c.name}`, group: 'apps', kind: 'connection', name: c.name,
      summary: list.length ? `Hosted at ${host}, ${plural(list.length, 'action')} added` : `Hosted at ${host}, no actions added yet`,
      status: ready ? 'ready' : 'needs_setup',
      status_note: ready ? null : c.last_error ?? (c.auth_kind === 'oauth' ? 'Sign in to finish connecting' : `Status: ${c.status}`),
      changes_things: list.length ? writes > 0 : null, runs_code: false, needs: [], used_by: usedBy(list),
      href: '/ui/connections', details: { url: c.url, auth: c.auth_kind, connection_status: c.status, tools: toolRows(list) },
    });
  }

  for (const a of assets as Array<Record<string, any>>) {
    if (a.status === 'archived') continue;
    const def = (a.definition ?? {}) as Record<string, any>;
    const needs = Array.isArray(def.needs) ? def.needs.map((n: any) => String(n?.name ?? '')).filter(Boolean) : [];
    const published = a.status === 'published';
    items.push({
      id: `asset:${a.id}`, group: groupOfAsset(a.kind), kind: a.kind, name: a.name,
      summary: a.description || def.description || '',
      status: published ? 'ready' : 'draft',
      status_note: published ? null : 'Review and publish it before a workflow can use it',
      changes_things: null, runs_code: a.kind === 'mcp' && def.transport === 'local', needs,
      used_by: attachedCount.get(a.id) ?? 0, href: '/ui/assets',
      details: { slug: a.slug, version: a.current_version, scope: a.scope ?? 'global', workflow: a.project_workflow ?? null, source: def.provenance?.url ?? null },
    });
  }

  for (const d of datasets as Array<Record<string, any>>) {
    items.push({
      id: `dataset:${d.name}`, group: 'knowledge', kind: 'dataset', name: d.name,
      summary: `${plural(d.documents ?? 0, 'document')}${d.trusted ? '' : ', untrusted'}`,
      status: d.latest_revision ? 'ready' : 'draft',
      status_note: d.latest_revision ? null : 'Publish a revision so agents can search it',
      changes_things: false, runs_code: false, needs: [], used_by: workflowsOf([usage.datasets[d.name] ?? []]),
      href: `/ui/datasets/${encodeURIComponent(d.name)}`, details: { trusted: Boolean(d.trusted), revision: d.latest_revision ?? null },
    });
  }
  return items.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

export function registerToolboxRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/toolbox', async (req) => {
    const p = req.principal;
    if (p.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
    return toolbox(ctx, p.workspaceId, p.role === 'admin' || p.role === 'owner');
  });
}
