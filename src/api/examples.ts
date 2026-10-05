import type { FastifyInstance, FastifyRequest } from 'fastify';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import type { AdminConfig } from '../config/admin.js';
import { packageFromDirectory } from '../definition/package.js';
import type { ToolSpec } from '../gateway/types.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit, loadToolRevision, registerTool, updateToolRepos } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { listSecrets } from '../server/secrets.js';
import { uploadPackage } from '../server/workflows.js';
import { requireRole } from './auth.js';

/**
 * The example workflows that ship with the server (`examples/`), set up in one step from mission
 * control or `azhi example install`: the example's tools are registered (with the repositories
 * the person names, for tools that read or write repositories), its package is saved as a draft
 * version, and the secrets it needs are listed with whether each is set. Nothing is edited by hand.
 */
const examplesDir = () => process.env.AZHI_EXAMPLES_DIR ?? fileURLToPath(new URL('../../examples', import.meta.url));
const ID = /^[a-z0-9][a-z0-9-]*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

interface Example {
  id: string;
  name: string;
  description: string;
  config: AdminConfig;
  /** The workflow's id and its `config:` block, where settings may also appear as `{{name}}`. */
  workflow: { id: string; config: Record<string, unknown> };
}

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

function loadExample(id: string): Example | undefined {
  if (!ID.test(id)) return undefined;
  const dir = join(examplesDir(), id);
  if (!existsSync(join(dir, 'workflow.yaml'))) return undefined;
  const wf = parse(readFileSync(join(dir, 'workflow.yaml'), 'utf8')) ?? {};
  const configPath = join(dir, 'azhi.config.yaml');
  const config: AdminConfig = existsSync(configPath) ? (parse(readFileSync(configPath, 'utf8')) ?? {}) : {};
  return { id, name: String(wf.name ?? id), description: String(wf.description ?? ''), config, workflow: { id: String(wf.id ?? id), config: wf.config ?? {} } };
}

/** A tool whose registration lists repositories; the person names theirs at install time. */
const needsRepos = (t: ToolSpec) => Array.isArray((t.transport as { config?: { repos?: unknown } }).config?.repos);

/** Secrets the example names: its config's list, the tools' credentials, and model keys in profiles. */
function secretsOf(e: Example): string[] {
  const names = new Set<string>(e.config.secrets ?? []);
  for (const t of e.config.tools ?? []) if (t.credential) names.add(t.credential);
  return [...names].sort();
}

/**
 * The git host that goes with a GitHub API address: https://ghe.example.com/api/v3 clones from
 * https://ghe.example.com, and https://api.acme.ghe.com from https://acme.ghe.com.
 */
export function gitHostFor(apiUrl: string): string {
  const u = new URL(apiUrl);
  if (u.hostname === 'api.github.com') return 'https://github.com';
  const host = u.hostname.startsWith('api.') ? u.host.slice(4) : u.host;
  return `${u.protocol}//${host}`;
}

/**
 * Points every checkout (`workspace:` block) in a workflow at `host`. An explicit host replaces one
 * the workflow names; a host derived from the API address only fills in where none is named.
 */
export function withGitHost(yaml: string, host: string, replace: boolean): string {
  const lines = yaml.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]!);
    const m = /^(\s*)workspace:(\s+&[\w-]+)?\s*$/.exec(lines[i]!);
    if (!m) continue;
    const indent = `${m[1]}  `;
    let j = i + 1;
    let named = false;
    for (; j < lines.length && (lines[j]!.startsWith(indent) || !lines[j]!.trim()); j++) {
      if (lines[j]!.startsWith(`${indent}host:`)) {
        named = true;
        if (replace) lines[j] = `${indent}host: ${host}`;
      }
    }
    if (!named) out.push(`${indent}host: ${host}`);
  }
  return out.join('\n');
}

/** The repositories the example's installed repository tools allow (all of them, in order). */
async function installedRepos(ctx: AppContext, workspaceId: string, e: Example): Promise<string[]> {
  const all: string[] = [];
  for (const t of (e.config.tools ?? []).filter(needsRepos)) {
    const spec = await loadToolRevision(ctx, workspaceId, `${t.id}@${t.version}`, undefined);
    const repos = (spec?.transport as { config?: { repos?: unknown } } | undefined)?.config?.repos;
    if (Array.isArray(repos)) for (const r of repos) if (typeof r === 'string' && !all.includes(r)) all.push(r);
  }
  return all;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const SETTING_NAME = /^[a-z][a-z0-9_]*$/;

/** Settings the example asks for: those it describes plus every `{{name}}` in its tools. */
function settingsOf(e: Example) {
  const out = new Map((e.config.settings ?? []).map((s) => [s.name, s]));
  for (const t of [...(e.config.tools ?? []), e.workflow.config]) for (const m of JSON.stringify(t).matchAll(PLACEHOLDER)) if (!out.has(m[1]!)) out.set(m[1]!, { name: m[1]! });
  return [...out.values()];
}

/** Replaces `{{name}}` in every string of a tool registration; unknown names are left in place. */
function fill<T>(v: T, values: Record<string, string>): T {
  if (typeof v === 'string') return v.replace(PLACEHOLDER, (all, name: string) => values[name] ?? all) as T;
  if (Array.isArray(v)) return v.map((x) => fill(x, values)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, values)])) as T;
  return v;
}

/** Values an earlier install filled in: where the template is exactly `{{name}}`, the registered value. */
function recover(template: unknown, registered: unknown, out: Record<string, string>) {
  if (typeof template === 'string') {
    const m = template.match(/^\{\{(\w+)\}\}$/);
    if (m && typeof registered === 'string' && !registered.includes('{{')) out[m[1]!] ??= registered;
  } else if (Array.isArray(template)) {
    if (Array.isArray(registered)) template.forEach((x, i) => recover(x, registered[i], out));
  } else if (template && typeof template === 'object' && registered && typeof registered === 'object') {
    for (const [k, x] of Object.entries(template)) recover(x, (registered as Record<string, unknown>)[k], out);
  }
}

async function registeredSettings(ctx: AppContext, workspaceId: string, e: Example): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of e.config.tools ?? []) {
    if (!JSON.stringify(t).includes('{{')) continue;
    const prev = await loadToolRevision(ctx, workspaceId, `${t.id}@${t.version}`, undefined);
    if (prev) recover(t.transport, prev.transport, out);
  }
  if (JSON.stringify(e.workflow.config).includes('{{')) {
    // The newest versions first; uploads made outside the install may have left a value unfilled.
    const prev = (
      await ctx.pool.query(
        `SELECT v.definition FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.workspace_id=$1 AND w.slug=$2 ORDER BY v.version DESC LIMIT 20`,
        [workspaceId, e.workflow.id],
      )
    ).rows as Array<{ definition: { config?: unknown } }>;
    for (const v of prev) recover(e.workflow.config, v.definition.config, out);
  }
  return out;
}

/** workflow.yaml with the settings filled in; values go inside the template's double quotes. */
function fillWorkflowText(text: string, e: Example, values: Record<string, string>): string {
  const names = new Set([...JSON.stringify(e.workflow.config).matchAll(PLACEHOLDER)].map((m) => m[1]!));
  return text.replace(PLACEHOLDER, (all, name: string) => (names.has(name) && values[name] !== undefined ? JSON.stringify(values[name]).slice(1, -1) : all));
}

export function registerExampleRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/examples', async (req) => {
    const p = user(req);
    const set = new Set((await listSecrets(ctx, p.workspaceId)).map((s) => s.name));
    const ids = existsSync(examplesDir()) ? readdirSync(examplesDir()).filter((d) => ID.test(d)).sort() : [];
    const out = [];
    for (const id of ids) {
      const e = loadExample(id);
      if (!e) continue;
      const known = await registeredSettings(ctx, p.workspaceId, e);
      out.push({
        id: e.id,
        name: e.name,
        description: e.description,
        tools: (e.config.tools ?? []).map((t) => ({ ref: `${t.id}@${t.version}`, effect: t.effect, description: t.description, needs_repos: needsRepos(t) })),
        needs_repos: (e.config.tools ?? []).some(needsRepos),
        secrets: secretsOf(e).map((name) => ({ name, set: set.has(name) })),
        /** Repositories its installed tools may use now (empty before install). */
        repos: await installedRepos(ctx, p.workspaceId, e),
        // Which settings an earlier install filled in (the values are configuration, not secrets).
        settings: settingsOf(e).map((s) => ({ ...s, value: known[s.name] ?? null })),
      });
    }
    return out;
  });

  // Adds or removes repositories on the example's installed GitHub tools, without reinstalling.
  app.post('/v1/examples/:id/repos', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const id = (req.params as { id: string }).id;
    const e = loadExample(id);
    if (!e) throw new AzhiError(ErrorClass.invalidInput, `no example named '${id}'`);
    const b = z.object({ add: z.array(z.string().regex(REPO, 'repositories are owner/name')).max(50).optional(), remove: z.array(z.string()).max(50).optional() }).parse(req.body ?? {});
    const tools = [];
    for (const t of (e.config.tools ?? []).filter(needsRepos)) {
      const ref = `${t.id}@${t.version}`;
      if (!(await loadToolRevision(ctx, p.workspaceId, ref, undefined))) throw new AzhiError(ErrorClass.invalidInput, `example '${id}' is not installed yet (no ${ref}); install it first`);
      tools.push(await updateToolRepos(ctx, p.workspaceId, ref, b, p.userId));
    }
    return { tools, repos: await installedRepos(ctx, p.workspaceId, e) };
  });

  app.post('/v1/examples/:id/install', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const id = (req.params as { id: string }).id;
    const e = loadExample(id);
    if (!e) throw new AzhiError(ErrorClass.invalidInput, `no example named '${id}'`);
    const b = z
      .object({
        repos: z.array(z.string().regex(REPO, 'repositories are owner/name')).max(50).optional(),
        /** GitHub Enterprise Server API, for example https://ghe.example.com/api/v3. */
        api_url: z.string().url().optional(),
        /** Git host the checkouts clone from; defaults to the one that goes with api_url, else github.com. */
        git_url: z.string().regex(/^https?:\/\/[^/\s]+\/?$/, 'git_url is a host address such as https://ghe.example.com').optional(),
        /** Values for the example's settings (`{{name}}` in its tools); one line each. */
        settings: z
          .record(z.string().regex(SETTING_NAME, 'setting names are lower_case'), z.string().max(500).regex(/^[^\u0000-\u001f\u007f{}]*$/, 'setting values are one line without braces'))
          .optional(),
      })
      .parse(req.body ?? {});
    const wanted = settingsOf(e).map((s) => s.name);
    for (const name of Object.keys(b.settings ?? {})) if (!wanted.includes(name)) throw new AzhiError(ErrorClass.invalidInput, `example '${id}' has no setting '${name}'${wanted.length ? ` (it has: ${wanted.join(', ')})` : ''}`);
    // Settings left out keep what an earlier install filled in; blank values are left out.
    const given = Object.fromEntries(Object.entries(b.settings ?? {}).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const values = { ...(await registeredSettings(ctx, p.workspaceId, e)), ...given };
    const tools = e.config.tools ?? [];
    if (tools.some(needsRepos) && !b.repos?.length) throw new AzhiError(ErrorClass.invalidInput, `example '${id}' needs the repositories its GitHub tools may use (owner/name)`);

    const registered = [];
    for (const t of tools) {
      const spec = fill(structuredClone(t), values);
      if (needsRepos(spec)) {
        const transport = spec.transport as { config: Record<string, unknown> };
        transport.config = { ...transport.config, repos: b.repos, ...(b.api_url ? { api_url: b.api_url } : {}) };
      }
      const r = await registerTool(ctx, p.workspaceId, spec, p.userId);
      registered.push({ ref: `${spec.id}@${spec.version}`, ...r });
    }

    const pkg = packageFromDirectory(join(examplesDir(), id));
    const files = Object.fromEntries(
      pkg.manifest.files.map((f) => [f.path, (f.path === pkg.manifest.workflow ? Buffer.from(fillWorkflowText(pkg.readText(f.path)!, e, values)) : pkg.read(f.path)!).toString('base64')]),
    );
    const gitHost = b.git_url ?? (b.api_url ? gitHostFor(b.api_url) : undefined);
    const wfPath = pkg.manifest.workflow;
    if (gitHost && files[wfPath]) files[wfPath] = Buffer.from(withGitHost(Buffer.from(files[wfPath], 'base64').toString('utf8'), gitHost.replace(/\/+$/, ''), Boolean(b.git_url))).toString('base64');
    const up = await uploadPackage(ctx, p.workspaceId, { workflow: pkg.manifest.workflow, files }, p.userId);
    if (!up.ok) return { ok: false, diagnostics: up.diagnostics, tools: registered };
    await audit(ctx, p.workspaceId, p.userId, 'example.installed', { example: id, version: up.version.id, tools: registered.map((t) => t.ref), repos: b.repos ?? [], settings: Object.keys(given) });
    const set = new Set((await listSecrets(ctx, p.workspaceId)).map((s) => s.name));
    return {
      ok: true,
      diagnostics: up.diagnostics,
      version: { id: up.version.id, workflow: up.version.slug, version: up.version.version, draft: up.version.draft },
      tools: registered,
      secrets: secretsOf(e).map((name) => ({ name, set: set.has(name) })),
      settings: settingsOf(e).map((s) => ({ ...s, value: values[s.name] ?? null })),
    };
  });
}
