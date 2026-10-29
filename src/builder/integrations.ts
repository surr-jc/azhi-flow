import { OPENCODE_READ_TOOLS } from '../agents/profile.js';
import { checkEgress } from '../gateway/egress.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { addMcpServer, listAssets, validateAsset, type AssetKind, type AssetScope, type PortableDefinition } from '../server/assets.js';
import type { AppContext } from '../server/context.js';
import { defaultDeps, marketConfig, resolve, search, sourcesFor, type MarketDeps, type MarketKind } from '../server/marketplace.js';

/**
 * What the builder can offer besides registered tools: the library's MCP servers, skills, agents and
 * commands, the gateway's MCP connections, the harness's built-in tools, and live marketplaces. It also
 * checks and stores the MCP server a person confirms in chat.
 */

/** A hosted MCP server the builder proposes to connect to the gateway. An admin's click creates it and starts sign-in; nothing is stored before. */
export interface BuilderMcpConnectionProposal { tool_use_id: string; summary: string; name: string; url: string; auth_kind: 'none' | 'oauth' }

/** Checks a proposed gateway connection the way creating it will, so the person is only offered one that can work. Throws a repairable message. */
export async function checkMcpConnectionProposal(ctx: AppContext, workspaceId: string, raw: unknown): Promise<Omit<BuilderMcpConnectionProposal, 'tool_use_id' | 'summary'>> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const errors: string[] = [];
  const name = typeof o.name === 'string' ? o.name : '';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) errors.push('name must use lower-case letters, digits, dots, dashes or underscores');
  const auth_kind = o.auth_kind === 'none' ? 'none' : 'oauth';
  let url = '';
  try {
    const u = new URL(String(o.url));
    if (u.protocol !== 'https:') errors.push('url must be an https URL');
    else { await checkEgress(u.toString()); url = u.toString(); }
  } catch (e) { errors.push(e instanceof AzhiError ? e.message : 'url must be an https URL'); }
  if (!errors.length && (await ctx.pool.query(`SELECT 1 FROM mcp_connections WHERE workspace_id=$1 AND name=$2`, [workspaceId, name])).rows.length) errors.push(`a gateway connection named '${name}' already exists; pick another name or use the existing one`);
  if (errors.length) throw new AzhiError(ErrorClass.invalidInput, `The MCP connection is not valid yet. Fix these and propose it again: ${errors.join('; ')}`);
  return { name, url, auth_kind };
}

/** An MCP server the builder proposes to add to the library; nothing is stored until a person confirms. */
export interface BuilderMcpProposal {
  tool_use_id: string;
  slug: string;
  name: string;
  description: string;
  summary: string;
  scope: AssetScope;
  workflow?: string;
  definition: PortableDefinition;
  /** Environment variables the person must set where the harness runs; values are never asked for in chat. */
  needs: Array<{ name: string; secret: boolean; required?: boolean }>;
  /** Where the definition came from, when the server fetched it from a marketplace. */
  source?: string;
  /** Set when the server fetched the definition from a marketplace; confirming fetches it again rather than trusting the browser. */
  marketplace_id?: string;
  /** A local server is a program started on a worker. */
  runs_code: boolean;
}

/** One line per library asset, never the full definition: a secret-free summary of how it runs. */
function how(kind: AssetKind, d: Record<string, any>): string | undefined {
  if (kind !== 'mcp') return undefined;
  if (d.transport === 'remote') {
    try { return `hosted at ${new URL(String(d.url)).host}`; } catch { return 'hosted'; }
  }
  return `runs on a worker: ${Array.isArray(d.command) ? String(d.command[0]) : '?'}`;
}

/** The library, the gateway connections and the harness, for `workspace_overview`. */
export async function integrationsOverview(ctx: AppContext, workspaceId: string) {
  const assets = (await listAssets(ctx, workspaceId)).filter((a: any) => a.status !== 'archived');
  const of = (kind: AssetKind) => assets.filter((a: any) => a.kind === kind).map((a: any) => ({
    slug: a.slug,
    description: a.description || a.definition?.description || '',
    status: a.status,
    scope: a.scope,
    ...(a.project_workflow ? { workflow: a.project_workflow } : {}),
    ...(how(kind, a.definition ?? {}) ? { runs: how(kind, a.definition ?? {}) } : {}),
    ...(kind === 'mcp' && Array.isArray(a.definition?.needs) && a.definition.needs.length ? { needs: a.definition.needs.map((n: any) => n.name) } : {}),
  }));
  const connections = (await ctx.pool.query(`SELECT name, auth_kind, status FROM mcp_connections WHERE workspace_id=$1 ORDER BY name`, [workspaceId])).rows;
  const cfg = await marketConfig(ctx, workspaceId);
  return {
    library_mcp_servers: of('mcp'),
    library_skills: of('skill'),
    library_agents: of('agent'),
    library_commands: of('command'),
    gateway_mcp_connections: connections,
    harness_tools: {
      opencode: OPENCODE_READ_TOOLS,
      note: 'Built-in OpenCode tools a profile may allow under harness.opencode.tools (read-only). Skills load with the skill tool; MCP servers run on the worker as harness.opencode.mcp.',
    },
    marketplace: { enabled: cfg.enabled, how_to_search: 'call find_integrations with the requirement as the query' },
    library_note: 'Library MCP servers with status published can be used in a workflow. Draft ones must be published first. Gateway connections are used through registered tools (propose_tool).',
  };
}

const KINDS: MarketKind[] = ['mcp', 'skill', 'agent', 'command'];

/** Searches the live marketplaces (MCP Registry, plugin marketplaces) for what a requirement needs. Failures come back as notes, never as errors. */
export async function findIntegrations(ctx: AppContext, workspaceId: string, input: { query?: unknown; kinds?: unknown }, deps: MarketDeps = defaultDeps()) {
  const query = String(input.query ?? '').trim().slice(0, 120);
  if (!query) throw new Error('give a short search query, for example "jira" or "postgres"');
  const wanted = (Array.isArray(input.kinds) ? input.kinds : ['mcp', 'skill']).filter((k): k is MarketKind => KINDS.includes(k as MarketKind));
  const cfg = await marketConfig(ctx, workspaceId);
  if (!cfg.enabled) return { items: [], notes: ['The marketplace is turned off for this workspace; suggest only what workspace_overview lists, or propose a server the person describes.'] };
  const sources = sourcesFor(cfg);
  const notes: string[] = [];
  const items: Array<Record<string, unknown>> = [];
  for (const kind of wanted.length ? wanted : (['mcp'] as MarketKind[])) {
    try {
      const r = await search(deps, sources, { kind, q: query, limit: 6 });
      for (const i of r.items.slice(0, 6)) items.push({ id: i.id, kind: i.kind, name: i.name, description: i.description.slice(0, 200), source: i.source_name, ...(i.runs_code ? { runs_code: true } : {}), ...(i.unsupported ? { unsupported: i.unsupported } : {}) });
      for (const w of r.warnings) notes.push(`${w.source}: ${w.message}`);
    } catch (e) {
      notes.push(`${kind} search failed: ${(e as Error).message}`);
    }
  }
  return { items, notes };
}

/** Checks a proposed MCP server the way adding it will. Throws a message the model can repair from. */
export async function checkMcpProposal(ctx: AppContext, workspaceId: string, raw: unknown, deps: MarketDeps = defaultDeps()): Promise<Omit<BuilderMcpProposal, 'tool_use_id' | 'summary'>> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const errors: string[] = [];
  const slug = typeof o.slug === 'string' ? o.slug : '';
  let definition: PortableDefinition | undefined = o.definition && typeof o.definition === 'object' && !Array.isArray(o.definition) ? o.definition : undefined;
  let name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : slug;
  let description = typeof o.description === 'string' ? o.description : '';
  let source: string | undefined;
  if (typeof o.marketplace_id === 'string' && o.marketplace_id) {
    // The server fetches the definition itself so its source and hash are recorded; the model never supplies it.
    const cfg = await marketConfig(ctx, workspaceId);
    if (!cfg.enabled) errors.push('the marketplace is turned off for this workspace; give the definition instead');
    else {
      try {
        const r = await resolve(deps, sourcesFor(cfg), o.marketplace_id);
        if (r.item.kind !== 'mcp') errors.push(`${o.marketplace_id} is a ${r.item.kind}, not an MCP server`);
        definition = { ...r.definition, provenance: r.provenance, ...(r.needs.length ? { needs: r.needs } : {}) };
        name = o.name ? name : r.item.name;
        description = description || r.item.description;
        source = r.provenance.source;
      } catch (e) {
        errors.push(`marketplace item ${o.marketplace_id}: ${(e as Error).message}`);
      }
    }
  }
  if (!definition && !errors.length) errors.push('give a definition ({transport: "remote", url} or {transport: "local", command: [...]}) or a marketplace_id from find_integrations');
  const scope: AssetScope = o.scope === 'project' ? 'project' : 'global';
  const workflow = typeof o.workflow === 'string' && o.workflow ? o.workflow : undefined;
  if (definition) errors.push(...validateAsset('mcp', slug, definition));
  if (scope === 'project') {
    if (!workflow) errors.push('scope project needs `workflow`, the slug of an existing workflow; use scope global for a workflow that is not saved yet');
    else if (!(await ctx.pool.query(`SELECT 1 FROM workflows WHERE workspace_id=$1 AND slug=$2`, [workspaceId, workflow])).rows[0]) errors.push(`workflow '${workflow}' does not exist yet; use scope global, or add it to the workflow after the draft is saved`);
  } else if (workflow) errors.push('a global server is not tied to a workflow; leave `workflow` out, or use scope project');
  if (slug && (await ctx.pool.query(`SELECT 1 FROM portable_assets WHERE workspace_id=$1 AND kind='mcp' AND slug=$2`, [workspaceId, slug])).rows[0]) errors.push(`an MCP server named '${slug}' is already in the library; use it instead of adding another (see library_mcp_servers)`);
  if (errors.length) throw new Error(`The MCP server is not valid yet. Fix these and propose it again:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  const d = definition!;
  const needs = (Array.isArray(d.needs) ? d.needs : []) as BuilderMcpProposal['needs'];
  return { slug, name, description, scope, ...(scope === 'project' ? { workflow } : {}), definition: d, needs, ...(source ? { source, marketplace_id: String(o.marketplace_id) } : {}), runs_code: d.transport === 'local' };
}

/** Adds a confirmed proposal: checked again, then published (and attached for a project server). */
export async function addProposedMcp(ctx: AppContext, workspaceId: string, raw: unknown, actor: string, deps: MarketDeps = defaultDeps()) {
  let c;
  try {
    c = await checkMcpProposal(ctx, workspaceId, raw, deps);
  } catch (e) {
    throw new AzhiError(ErrorClass.invalidInput, (e as Error).message);
  }
  const asset = await addMcpServer(ctx, workspaceId, { slug: c.slug, name: c.name, description: c.description, definition: c.definition, scope: c.scope, ...(c.workflow ? { workflow: c.workflow } : {}) }, actor);
  return { slug: c.slug, scope: c.scope, ...(c.workflow ? { workflow: c.workflow } : {}), status: asset?.status as string, needs: c.needs };
}
