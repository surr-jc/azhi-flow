/**
 * Live marketplaces for portable assets (MCP servers, agents, skills, commands).
 *
 * Two kinds of source, both read-only and fetched by the server (the web app's CSP allows no third
 * parties, and a browser cannot reach every host):
 *   - the official MCP Registry (registry.modelcontextprotocol.io): MCP servers;
 *   - GitHub "plugin marketplaces": any repository with .claude-plugin/marketplace.json, the layout
 *     Claude Code plugins use and OpenCode reads too. A plugin's agents/*.md, commands/*.md and
 *     skills/<name>/SKILL.md become importable items.
 *
 * Nothing here executes imported content. An import creates a draft portable asset (with its source
 * and a content hash recorded), so an author reviews it and publishes it like any other asset.
 */
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { createAsset, type AssetKind, type PortableDefinition } from './assets.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';

export type MarketKind = AssetKind;
export const HARNESSES = ['opencode', 'claude-code'] as const;

export interface MarketNeed { name: string; secret: boolean; description?: string; required: boolean }
export interface MarketItem {
  id: string;
  source: string;
  source_name: string;
  kind: MarketKind;
  slug: string;
  name: string;
  description: string;
  version?: string;
  homepage?: string;
  author?: string;
  category?: string;
  /** Plugin or package this item ships in. */
  group?: string;
  /** A local MCP server is a program that runs on a worker. */
  runs_code?: boolean;
  /** Why the item cannot be imported, when it cannot. */
  unsupported?: string;
}
export interface MarketSource { id: string; name: string; description: string; type: 'mcp-registry' | 'github-marketplace'; repo?: string; ref?: string; kinds: MarketKind[]; builtin: boolean }
export interface Resolved { item: MarketItem; definition: PortableDefinition; needs: MarketNeed[]; warnings: string[]; provenance: { source: string; url: string; sha256: string; fetched_at: string } }

const REGISTRY = 'https://registry.modelcontextprotocol.io';
const ALLOWED_HOSTS = new Set(['registry.modelcontextprotocol.io', 'raw.githubusercontent.com', 'api.github.com']);
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,100}$/;
const TTL_MS = 10 * 60_000;
const MAX_BYTES = 2_000_000;

export const BUILTIN_SOURCES: MarketSource[] = [
  { id: 'mcp-registry', name: 'Official MCP Registry', description: 'MCP servers published by their authors.', type: 'mcp-registry', kinds: ['mcp'], builtin: true },
  { id: 'gh:anthropics/skills', name: 'Anthropic Agent Skills', description: 'Skills for documents, design, testing and building MCP servers.', type: 'github-marketplace', repo: 'anthropics/skills', ref: 'main', kinds: ['skill'], builtin: true },
  { id: 'gh:anthropics/claude-plugins-official', name: 'Official plugins', description: 'Agents, commands and skills from the Claude plugin directory.', type: 'github-marketplace', repo: 'anthropics/claude-plugins-official', ref: 'main', kinds: ['agent', 'command', 'skill'], builtin: true },
  { id: 'gh:wshobson/agents', name: 'Workflow agents and skills', description: 'A large community set of specialised agents, commands and skills.', type: 'github-marketplace', repo: 'wshobson/agents', ref: 'main', kinds: ['agent', 'command', 'skill'], builtin: true },
];

export interface MarketDeps { fetch: typeof fetch; githubToken?: string; now: () => number }
export function defaultDeps(): MarketDeps { return { fetch: (...a) => fetch(...a), githubToken: process.env.AZHI_GITHUB_TOKEN || undefined, now: () => Date.now() }; }

const cache = new Map<string, { at: number; value: unknown }>();
export function clearMarketplaceCache() { cache.clear(); }
async function cached<T>(deps: MarketDeps, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && deps.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: deps.now(), value });
  return value;
}

async function get(deps: MarketDeps, url: string): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new AzhiError(ErrorClass.invalidInput, `marketplace requests may only go to ${[...ALLOWED_HOSTS].join(', ')}`);
  const headers: Record<string, string> = { 'user-agent': 'azhi-flow-marketplace', accept: 'application/json, text/plain, */*' };
  if (u.hostname === 'api.github.com' && deps.githubToken) headers.authorization = `Bearer ${deps.githubToken}`;
  let res: Response;
  try {
    res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new AzhiError(ErrorClass.transient, `could not reach ${u.hostname}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new AzhiError(res.status === 404 ? ErrorClass.invalidInput : ErrorClass.transient, `${u.hostname} answered ${res.status} for ${u.pathname}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new AzhiError(ErrorClass.invalidInput, `${u.pathname} is larger than ${MAX_BYTES / 1_000_000} MB`);
  return text;
}

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'item';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ---- workspace configuration: which extra sources, and whether the feature is on -----------------------------------
interface MarketConfig { enabled: boolean; sources: Array<{ repo: string; ref: string }> }
export async function marketConfig(ctx: AppContext, workspaceId: string): Promise<MarketConfig> {
  const row = (await ctx.pool.query(`SELECT settings->'marketplace' AS m FROM workspaces WHERE id=$1`, [workspaceId])).rows[0];
  const m = (row?.m ?? {}) as Partial<MarketConfig>;
  return { enabled: m.enabled !== false, sources: Array.isArray(m.sources) ? m.sources.filter((s) => REPO.test(s.repo) && REF.test(s.ref)) : [] };
}
export async function saveMarketConfig(ctx: AppContext, workspaceId: string, actor: string, input: MarketConfig): Promise<MarketConfig> {
  const seen = new Set<string>();
  for (const s of input.sources) {
    if (!REPO.test(s.repo)) throw new AzhiError(ErrorClass.invalidInput, `"${s.repo}" is not an owner/repo name`);
    if (!REF.test(s.ref)) throw new AzhiError(ErrorClass.invalidInput, `"${s.ref}" is not a branch or tag name`);
    if (seen.has(s.repo)) throw new AzhiError(ErrorClass.invalidInput, `${s.repo} is listed twice`);
    seen.add(s.repo);
  }
  const value = { enabled: input.enabled, sources: input.sources };
  await ctx.pool.query(`UPDATE workspaces SET settings = jsonb_set(settings, '{marketplace}', $2::jsonb) WHERE id=$1`, [workspaceId, JSON.stringify(value)]);
  await audit(ctx, workspaceId, actor, 'settings.marketplace_changed', value);
  return value;
}
export function sourcesFor(cfg: MarketConfig): MarketSource[] {
  const extra: MarketSource[] = cfg.sources.filter((s) => REPO.test(s.repo) && REF.test(s.ref) && !BUILTIN_SOURCES.some((b) => b.repo === s.repo)).map((s) => ({
    id: `gh:${s.repo}`, name: s.repo, description: 'Added by an admin. Any repository with .claude-plugin/marketplace.json.', type: 'github-marketplace', repo: s.repo, ref: s.ref, kinds: ['agent', 'command', 'skill'], builtin: false,
  }));
  return [...BUILTIN_SOURCES, ...extra];
}

// ---- Markdown with front matter: skills, agents, commands --------------------------------------------------------
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) return { data: {}, body: text.trim() };
  let data: unknown = {};
  try { data = parseYaml(m[1]!); } catch { data = {}; }
  return { data: data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}, body: m[2]!.trim() };
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function normaliseSkill(text: string, fallbackName: string): { name: string; slug: string; description: string; definition: PortableDefinition; warnings: string[] } {
  const { data, body } = splitFrontmatter(text);
  const name = str(data.name) ?? fallbackName;
  const warnings: string[] = [];
  if (!body) warnings.push('The skill has no instructions.');
  if (/\b(scripts|references|assets)\//.test(body)) warnings.push('The instructions mention bundled files (scripts, references or assets). Only the instructions are imported; add those files to the harness yourself if the skill needs them.');
  return { name, slug: kebab(name), description: str(data.description) ?? '', definition: { description: str(data.description) ?? name, instructions: body, ...(str(data.license) ? { license: str(data.license) } : {}) }, warnings };
}
export function normaliseAgent(text: string, fallbackName: string): { name: string; slug: string; description: string; definition: PortableDefinition; warnings: string[] } {
  const { data, body } = splitFrontmatter(text);
  const name = str(data.name) ?? fallbackName;
  const warnings: string[] = [];
  if (!body) warnings.push('The agent has no prompt.');
  if (data.tools) warnings.push('The source limits the agent to certain tools. That list is not carried over; set permissions in the harness.');
  if (str(data.model)) warnings.push(`The source asks for the model "${str(data.model)}". It is not carried over; the harness profile chooses the model.`);
  return { name, slug: kebab(name), description: str(data.description) ?? '', definition: { description: str(data.description) ?? name, mode: 'subagent', prompt: body }, warnings };
}
export function normaliseCommand(text: string, fallbackName: string): { name: string; slug: string; description: string; definition: PortableDefinition; warnings: string[] } {
  const { data, body } = splitFrontmatter(text);
  const warnings: string[] = [];
  if (!body) warnings.push('The command has no prompt.');
  if (data['allowed-tools']) warnings.push('The source limits the command to certain tools. That list is not carried over.');
  return { name: fallbackName, slug: kebab(fallbackName), description: str(data.description) ?? '', definition: { description: str(data.description) ?? fallbackName, template: body }, warnings };
}

// ---- official MCP Registry --------------------------------------------------------------------------------------
type Args = Array<Record<string, any>>;
const envName = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();

/** "Bearer {token}" becomes "Bearer {env:TOKEN}", and the variable is recorded as something to provide. */
function fill(value: string, vars: Record<string, any> | undefined, needs: Map<string, MarketNeed>, label?: string): string {
  return value.replace(/\{([A-Za-z0-9_.-]+)\}/g, (all, v: string) => {
    const spec = vars?.[v];
    if (spec?.default !== undefined && spec.isSecret !== true) return String(spec.default);
    const name = envName(v);
    needs.set(name, { name, secret: spec?.isSecret === true || /key|token|secret|password/i.test(v), description: spec?.description ?? label, required: spec?.isRequired !== false });
    return `{env:${name}}`;
  });
}
function renderArgs(args: Args | undefined, needs: Map<string, MarketNeed>): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    const value = typeof a.value === 'string' ? fill(a.value, a.variables, needs, a.description) : typeof a.default === 'string' ? a.default : undefined;
    if (a.type === 'named') { if (a.name) out.push(String(a.name)); if (value !== undefined) out.push(value); } else if (value !== undefined) out.push(value);
  }
  return out;
}

export function registryServerToItem(server: any, meta?: any): { item: MarketItem; definition?: PortableDefinition; needs: MarketNeed[]; warnings: string[] } {
  const needs = new Map<string, MarketNeed>();
  const warnings: string[] = [];
  const name: string = server.name;
  const last = name.split('/').pop() ?? name;
  const base: MarketItem = {
    id: `mcp-registry::${name}`, source: 'mcp-registry', source_name: 'Official MCP Registry', kind: 'mcp', slug: kebab(last), name: server.title ?? last,
    description: server.description ?? '', version: server.version, homepage: server.repository?.url ?? server.websiteUrl, group: name,
    ...(meta?.['io.modelcontextprotocol.registry/official']?.status && meta['io.modelcontextprotocol.registry/official'].status !== 'active' ? { unsupported: `Marked ${meta['io.modelcontextprotocol.registry/official'].status} in the registry.` } : {}),
  };
  const remote = (server.remotes ?? []).find((r: any) => r.type === 'streamable-http') ?? (server.remotes ?? []).find((r: any) => r.type === 'sse');
  if (remote && /^https:\/\//.test(remote.url)) {
    const headers: Record<string, string> = {};
    for (const h of remote.headers ?? []) {
      if (h.value) headers[h.name] = fill(h.value, h.variables, needs, h.description);
      else {
        const bearer = h.name.toLowerCase() === 'authorization';
        const n = bearer ? `${envName(last)}_TOKEN` : envName(h.name);
        needs.set(n, { name: n, secret: h.isSecret === true || bearer, description: h.description, required: h.isRequired === true });
        headers[h.name] = bearer ? `Bearer {env:${n}}` : `{env:${n}}`;
      }
    }
    if (remote.type === 'sse') warnings.push('This server uses the older SSE transport. Some harnesses only support streamable HTTP.');
    return { item: base, definition: { transport: 'remote', url: fill(remote.url, remote.variables, needs), ...(Object.keys(headers).length ? { headers } : {}), enabled: true }, needs: [...needs.values()], warnings };
  }
  const pkg = (server.packages ?? []).find((p: any) => ['npm', 'pypi', 'oci'].includes(p.registryType) && (p.transport?.type ?? 'stdio') === 'stdio');
  if (!pkg) return { item: { ...base, unsupported: base.unsupported ?? 'No hosted URL and no npm, PyPI or Docker package that runs over stdio.' }, needs: [], warnings };
  const runtimeArgs = renderArgs(pkg.runtimeArguments, needs);
  const packageArgs = renderArgs(pkg.packageArguments, needs);
  let command: string[];
  if (pkg.registryType === 'npm') command = ['npx', ...(runtimeArgs.length ? runtimeArgs : ['-y']), `${pkg.identifier}@${pkg.version}`, ...packageArgs];
  else if (pkg.registryType === 'pypi') command = ['uvx', ...runtimeArgs, `${pkg.identifier}@${pkg.version}`, ...packageArgs];
  else command = ['docker', 'run', '-i', '--rm', ...runtimeArgs, pkg.identifier, ...packageArgs];
  const environment: Record<string, string> = {};
  for (const e of pkg.environmentVariables ?? []) {
    environment[e.name] = typeof e.value === 'string' ? fill(e.value, e.variables, needs, e.description) : `{env:${e.name}}`;
    if (typeof e.value !== 'string') needs.set(e.name, { name: e.name, secret: e.isSecret === true, description: e.description, required: e.isRequired === true });
  }
  // A container only sees the variables it is told about.
  if (pkg.registryType === 'oci') for (const n of Object.keys(environment)) command.splice(command.indexOf(pkg.identifier), 0, '-e', n);
  warnings.push(`Runs a program on a worker: ${command.slice(0, 3).join(' ')}… Review the package before publishing.`);
  return { item: { ...base, runs_code: true }, definition: { transport: 'local', command, ...(Object.keys(environment).length ? { environment } : {}), enabled: true }, needs: [...needs.values()], warnings };
}

async function searchRegistry(deps: MarketDeps, q: string, cursor: string | undefined, limit: number) {
  const url = `${REGISTRY}/v0.1/servers?limit=${limit}&version=latest${q ? `&search=${encodeURIComponent(q)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const body = JSON.parse(await get(deps, url));
  const items: MarketItem[] = (body.servers ?? []).map((s: any) => registryServerToItem(s.server, s._meta).item);
  return { items, next: (body.metadata?.nextCursor as string | undefined) ?? undefined };
}

// ---- GitHub plugin marketplaces ---------------------------------------------------------------------------------
interface Plugin { name: string; description?: string; source?: unknown; category?: string; version?: string; author?: { name?: string }; homepage?: string; skills?: string[]; agents?: string[]; commands?: string[] }
const rawUrl = (repo: string, ref: string, path: string) => `https://raw.githubusercontent.com/${repo}/${ref}/${path.replace(/^\.?\//, '')}`;
const blobUrl = (repo: string, ref: string, path: string) => `https://github.com/${repo}/blob/${ref}/${path.replace(/^\.?\//, '')}`;
const clean = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');

async function loadMarketplace(deps: MarketDeps, repo: string, ref: string): Promise<Plugin[]> {
  return cached(deps, `mk:${repo}@${ref}`, async () => {
    const body = JSON.parse(await get(deps, rawUrl(repo, ref, '.claude-plugin/marketplace.json')));
    return Array.isArray(body.plugins) ? (body.plugins as Plugin[]) : [];
  });
}
/** Every file path in the repository, or undefined when GitHub's API will not list it (rate limit, no access). */
async function loadTree(deps: MarketDeps, repo: string, ref: string): Promise<string[] | undefined> {
  return cached(deps, `tree:${repo}@${ref}`, async () => {
    try {
      const body = JSON.parse(await get(deps, `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`));
      return (body.tree ?? []).filter((t: any) => t.type === 'blob').map((t: any) => t.path as string);
    } catch {
      return undefined;
    }
  });
}

export interface Located { kind: MarketKind; path: string; plugin: Plugin; /** Set when the plugin lives in another GitHub repository than the marketplace. */ repo?: string; ref?: string }
/** A plugin whose source is another GitHub repository: { source: 'github' | 'url' | 'git-subdir', repo | url, path?, ref?, sha? }. */
export function externalSource(source: unknown): { repo: string; ref: string; base: string } | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const s = source as Record<string, any>;
  let repo: string | undefined = typeof s.repo === 'string' ? s.repo : undefined;
  if (!repo && typeof s.url === 'string') repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(s.url)?.[1];
  const ref = String(s.sha ?? s.ref ?? 'main');
  if (!repo || !REPO.test(repo) || !REF.test(ref)) return undefined;
  return { repo, ref, base: typeof s.path === 'string' ? clean(s.path) : '' };
}
const join = (base: string, p: string) => (base ? `${base}/${clean(p)}` : clean(p));
/** The agents, commands and skills of each plugin: listed in the plugin entry, or found under its folder. */
export function locate(plugins: Plugin[], tree: string[] | undefined): { found: Located[]; unlisted: string[] } {
  const found: Located[] = [];
  const unlisted: string[] = [];
  for (const plugin of plugins) {
    const explicit = plugin.skills || plugin.agents || plugin.commands;
    const ext = externalSource(plugin.source);
    if (explicit) {
      // Listed paths are relative to the plugin's own folder, here or in the repository it points at.
      const base = ext ? ext.base : typeof plugin.source === 'string' ? clean(plugin.source) : '';
      if (!ext && typeof plugin.source !== 'string' && plugin.source) continue; // some other kind of source
      const where = ext ? { repo: ext.repo, ref: ext.ref } : {};
      const md = (p: string) => (clean(p).endsWith('.md') ? join(base, p) : `${join(base, p)}.md`);
      for (const p of plugin.skills ?? []) found.push({ kind: 'skill', path: `${join(base, p)}/SKILL.md`, plugin, ...where });
      for (const p of plugin.agents ?? []) found.push({ kind: 'agent', path: md(p), plugin, ...where });
      for (const p of plugin.commands ?? []) found.push({ kind: 'command', path: md(p), plugin, ...where });
      continue;
    }
    if (typeof plugin.source !== 'string') continue; // lives in another repository, with nothing listed
    if (!tree) { unlisted.push(plugin.name); continue; }
    const base = clean(plugin.source);
    const at = (rest: string) => (base ? `${base}/${rest}` : rest);
    for (const f of tree) {
      if (f.startsWith(at('agents/')) && f.endsWith('.md')) found.push({ kind: 'agent', path: f, plugin });
      else if (f.startsWith(at('commands/')) && f.endsWith('.md')) found.push({ kind: 'command', path: f, plugin });
      else if (f.startsWith(at('skills/')) && f.endsWith('/SKILL.md') && f.split('/').length === at('skills/x/SKILL.md').split('/').length) found.push({ kind: 'skill', path: f, plugin });
    }
  }
  return { found, unlisted };
}

function nameFromPath(kind: MarketKind, path: string): string {
  const parts = path.split('/');
  if (kind === 'skill') return parts[parts.length - 2] ?? 'skill';
  const i = parts.lastIndexOf(kind === 'agent' ? 'agents' : 'commands');
  return (i >= 0 ? parts.slice(i + 1) : parts.slice(-1)).join('-').replace(/\.md$/, '');
}
const locator = (l: Located) => (l.repo ? `ext:${l.repo}@${l.ref}:${l.path}` : l.path);
function githubItem(src: MarketSource, l: Located): MarketItem {
  const name = nameFromPath(l.kind, l.path);
  return {
    id: `${src.id}::${l.kind}::${locator(l)}`, source: src.id, source_name: src.name, kind: l.kind, slug: kebab(name), name, description: l.plugin.description ?? '',
    ...(l.plugin.version ? { version: l.plugin.version } : {}), homepage: blobUrl(l.repo ?? src.repo!, l.ref ?? src.ref!, l.path), ...(l.plugin.author?.name ? { author: l.plugin.author.name } : {}),
    ...(l.plugin.category ? { category: l.plugin.category } : {}), group: l.plugin.name,
  };
}

// ---- search, preview, import --------------------------------------------------------------------------------------------
export interface SearchInput { kind: MarketKind; q: string; source?: string; cursor?: string; limit?: number }
export interface SearchResult { items: MarketItem[]; next_cursor?: string; warnings: Array<{ source: string; message: string }>; sources: Array<{ id: string; name: string }> }

export async function search(deps: MarketDeps, sources: MarketSource[], input: SearchInput): Promise<SearchResult> {
  const limit = Math.min(Math.max(input.limit ?? 24, 1), 60);
  const q = input.q.trim().toLowerCase();
  const usable = sources.filter((s) => s.kinds.includes(input.kind) && (!input.source || s.id === input.source));
  const warnings: SearchResult['warnings'] = [];
  const items: MarketItem[] = [];
  let next: string | undefined;
  // GitHub marketplaces are searched in memory; the registry is paged by its own cursor.
  const offset = input.cursor?.startsWith('o:') ? Number(input.cursor.slice(2)) || 0 : 0;
  const registry = usable.find((s) => s.type === 'mcp-registry');
  if (registry && (!input.cursor || !input.cursor.startsWith('o:'))) {
    try { const r = await searchRegistry(deps, q, input.cursor, limit); items.push(...r.items); next = r.next; } catch (e) { warnings.push({ source: registry.id, message: (e as Error).message }); }
  }
  const matches: MarketItem[] = [];
  await Promise.all(usable.filter((s) => s.type === 'github-marketplace').map(async (s) => {
    try {
      const plugins = await loadMarketplace(deps, s.repo!, s.ref!);
      const needsTree = plugins.some((p) => !(p.skills || p.agents || p.commands) && typeof p.source === 'string');
      const tree = needsTree ? await loadTree(deps, s.repo!, s.ref!) : undefined;
      const { found, unlisted } = locate(plugins, tree);
      if (unlisted.length) warnings.push({ source: s.id, message: `GitHub's API did not list the contents of ${unlisted.length} plugin${unlisted.length === 1 ? '' : 's'}, so their agents, commands and skills are missing (rate limit or no access; set AZHI_GITHUB_TOKEN on the server).` });
      for (const l of found) if (l.kind === input.kind) matches.push(githubItem(s, l));
    } catch (e) { warnings.push({ source: s.id, message: (e as Error).message }); }
  }));
  const hit = (i: MarketItem) => !q || `${i.name} ${i.description} ${i.group ?? ''} ${i.category ?? ''}`.toLowerCase().includes(q);
  const filtered = matches.filter(hit).sort((a, b) => a.name.localeCompare(b.name));
  const page = filtered.slice(offset, offset + limit);
  items.push(...page);
  if (offset + limit < filtered.length) next = `o:${offset + limit}`;
  return { items, ...(next ? { next_cursor: next } : {}), warnings, sources: usable.map((s) => ({ id: s.id, name: s.name })) };
}

/** Fetches one item and turns it into a portable definition. This is what a preview shows and what an import stores. */
export async function resolve(deps: MarketDeps, sources: MarketSource[], id: string): Promise<Resolved> {
  const [sourceId, ...rest] = id.split('::');
  const src = sources.find((s) => s.id === sourceId);
  if (!src) throw new AzhiError(ErrorClass.invalidInput, 'that marketplace is not enabled');
  const fetchedAt = new Date(deps.now()).toISOString();
  if (src.type === 'mcp-registry') {
    const name = rest.join('::');
    const url = `${REGISTRY}/v0.1/servers/${encodeURIComponent(name)}/versions/latest`;
    const text = await get(deps, url);
    const body = JSON.parse(text);
    const r = registryServerToItem(body.server, body._meta);
    if (!r.definition) throw new AzhiError(ErrorClass.invalidInput, r.item.unsupported ?? 'this server cannot be imported');
    return { item: r.item, definition: r.definition, needs: r.needs, warnings: r.warnings, provenance: { source: id, url: `${REGISTRY}/v0.1/servers/${encodeURIComponent(name)}`, sha256: sha(text), fetched_at: fetchedAt } };
  }
  const [kind, located] = rest as [MarketKind, string];
  if (!['agent', 'command', 'skill'].includes(kind) || !located || located.includes('..')) throw new AzhiError(ErrorClass.invalidInput, 'unknown marketplace item');
  const ext = /^ext:([^@]+)@([^:]+):(.+)$/.exec(located);
  const repo = ext ? ext[1]! : src.repo!;
  const ref = ext ? ext[2]! : src.ref!;
  const path = ext ? ext[3]! : located;
  if (!REPO.test(repo) || !REF.test(ref)) throw new AzhiError(ErrorClass.invalidInput, 'unknown marketplace item');
  const text = await get(deps, rawUrl(repo, ref, path));
  const fallback = nameFromPath(kind, path);
  const n = kind === 'skill' ? normaliseSkill(text, fallback) : kind === 'agent' ? normaliseAgent(text, fallback) : normaliseCommand(text, fallback);
  const item: MarketItem = { id, source: src.id, source_name: src.name, kind, slug: n.slug, name: n.name, description: n.description, homepage: blobUrl(repo, ref, path) };
  return { item, definition: n.definition, needs: [], warnings: n.warnings, provenance: { source: id, url: blobUrl(repo, ref, path), sha256: sha(text), fetched_at: fetchedAt } };
}

export async function importItem(ctx: AppContext, deps: MarketDeps, workspaceId: string, actor: string, id: string, override?: { slug?: string; name?: string }) {
  const cfg = await marketConfig(ctx, workspaceId);
  if (!cfg.enabled) throw new AzhiError(ErrorClass.invalidInput, 'the marketplace is turned off for this workspace');
  const r = await resolve(deps, sourcesFor(cfg), id);
  let slug = override?.slug ?? r.item.slug;
  const taken = new Set((await ctx.pool.query(`SELECT slug FROM portable_assets WHERE workspace_id=$1 AND kind=$2`, [workspaceId, r.item.kind])).rows.map((x) => x.slug as string));
  if (!override?.slug) for (let i = 2; taken.has(slug); i++) slug = `${r.item.slug.slice(0, 58)}-${i}`;
  const asset = await createAsset(ctx, workspaceId, { kind: r.item.kind, slug, name: override?.name ?? r.item.name, description: r.item.description, definition: { ...r.definition, provenance: r.provenance, ...(r.needs.length ? { needs: r.needs } : {}) } }, actor);
  await audit(ctx, workspaceId, actor, 'portable_asset.imported', { asset: asset.id, source: r.provenance.source, sha256: r.provenance.sha256 });
  return { asset, warnings: r.warnings, needs: r.needs };
}
