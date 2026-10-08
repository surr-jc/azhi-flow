import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
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
import { packageFile } from '../server/packages.js';
import { checkPackage, getVersion, uploadPackage } from '../server/workflows.js';
import { mergePackages, summarise } from './example-merge.js';
import { requireRole } from './auth.js';

/**
 * The example workflows that ship with the server (`examples/`), set up in one step from mission
 * control or `azhi example install`: the example's tools are registered (with the repositories
 * the person names, for tools that read or write repositories), its package is saved as a draft
 * version, and the secrets it needs are listed with whether each is set. Nothing is edited by hand.
 */
export const examplesDir = () => process.env.AZHI_EXAMPLES_DIR ?? fileURLToPath(new URL('../../examples', import.meta.url));
const ID = /^[a-z0-9][a-z0-9-]*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

interface Example {
  id: string;
  name: string;
  description: string;
  config: AdminConfig;
  /** The workflow's id and its `config:` block, where settings may also appear as `{{name}}`. */
  workflow: { id: string; config: Record<string, unknown> };
  /** The workflow's steps as written, so the marketplace can show them before an install. */
  nodes: Array<Record<string, unknown> & { id: string; type: string }>;
  inputs?: Record<string, unknown>;
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
  return { id, name: String(wf.name ?? id), description: String(wf.description ?? ''), config, workflow: { id: String(wf.id ?? id), config: wf.config ?? {} }, nodes: Array.isArray(wf.nodes) ? wf.nodes.filter((n: unknown) => n && typeof (n as { id?: unknown }).id === 'string' && typeof (n as { type?: unknown }).type === 'string') : [], inputs: wf.inputs };
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

/** JSON with sorted keys, so two registrations compare equal whatever order the database returned. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Identifies the template as the marketplace has it now: its package and its tool registrations. */
function templateHash(e: Example): string {
  const pkg = packageFromDirectory(join(examplesDir(), e.id));
  return createHash('sha256').update(pkg.hash).update(JSON.stringify(e.config.tools ?? [])).digest('hex');
}

interface InstallRecord { template_hash: string; base_files: Record<string, string>; options: { api_url?: string; git_url?: string; settings?: Record<string, string> }; updated_at: string }

async function installRecord(ctx: AppContext, workspaceId: string, id: string): Promise<InstallRecord | undefined> {
  return (await ctx.pool.query(`SELECT template_hash, base_files, options, updated_at FROM example_installs WHERE workspace_id=$1 AND example_id=$2`, [workspaceId, id])).rows[0];
}

async function saveInstallRecord(ctx: AppContext, workspaceId: string, e: Example, files: Record<string, string>, options: InstallRecord['options'], actor: string) {
  await ctx.pool.query(
    `INSERT INTO example_installs(workspace_id, example_id, workflow_slug, template_hash, base_files, options, installed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (workspace_id, example_id) DO UPDATE SET workflow_slug=$3, template_hash=$4, base_files=$5, options=$6, updated_at=now()`,
    [workspaceId, e.id, e.workflow.id, templateHash(e), JSON.stringify(files), JSON.stringify(options), actor],
  );
}

/** The newest version of the workflow this example installs, draft or published. */
async function latestLocal(ctx: AppContext, workspaceId: string, slug: string) {
  const row = (await ctx.pool.query(`SELECT v.id FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.workspace_id=$1 AND w.slug=$2 ORDER BY v.version DESC LIMIT 1`, [workspaceId, slug])).rows[0] as { id: string } | undefined;
  return row ? getVersion(ctx, workspaceId, row.id) : undefined;
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
      const local = await latestLocal(ctx, p.workspaceId, e.workflow.id);
      const rec = local ? await installRecord(ctx, p.workspaceId, e.id) : undefined;
      out.push({
        /** Set once the workflow is in this workspace: whether the marketplace has changed since it was installed or last updated. */
        update: local ? { available: !rec || rec.template_hash !== templateHash(e), tracked: Boolean(rec), version: local.version, draft: local.draft, updated_at: rec?.updated_at ?? null } : null,
        id: e.id,
        name: e.name,
        description: e.description,
        /** The workflow this example installs, to tell which workflow page it belongs to. */
        workflow: e.workflow.id,
        nodes: e.nodes,
        inputs: e.inputs ?? null,
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
    const defaults = Object.fromEntries(settingsOf(e).flatMap((s) => ('default' in s && typeof s.default === 'string' && s.default ? [[s.name, s.default]] : [])));
    const values = { ...defaults, ...(await registeredSettings(ctx, p.workspaceId, e)), ...given };
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
    await saveInstallRecord(ctx, p.workspaceId, e, files, { ...(b.api_url ? { api_url: b.api_url } : {}), ...(gitHost && b.git_url ? { git_url: b.git_url } : {}), settings: values }, p.userId);
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

  // Brings the marketplace's changes into the installed workflow without undoing local edits:
  // a three-way merge against the package as it was installed. `dry_run` only reports.
  app.post('/v1/examples/:id/update', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const id = (req.params as { id: string }).id;
    const e = loadExample(id);
    if (!e) throw new AzhiError(ErrorClass.invalidInput, `no example named '${id}'`);
    const b = z
      .object({
        dry_run: z.boolean().optional(),
        /** Values for settings the template has gained since the install. */
        settings: z.record(z.string().regex(SETTING_NAME), z.string().max(500).regex(/^[^\u0000-\u001f\u007f{}]*$/)).optional(),
      })
      .parse(req.body ?? {});
    const local = await latestLocal(ctx, p.workspaceId, e.workflow.id);
    if (!local) throw new AzhiError(ErrorClass.invalidInput, `'${id}' is not installed yet; install it first`);
    const rec = await installRecord(ctx, p.workspaceId, id);
    const opts = rec?.options ?? {};
    const given = Object.fromEntries(Object.entries(b.settings ?? {}).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const defaults = Object.fromEntries(settingsOf(e).flatMap((s) => ('default' in s && typeof s.default === 'string' && s.default ? [[s.name, s.default]] : [])));
    const values = { ...defaults, ...(await registeredSettings(ctx, p.workspaceId, e)), ...(opts.settings ?? {}), ...given };

    // The marketplace's package, filled in the way the install filled it.
    const pkg = packageFromDirectory(join(examplesDir(), id));
    const wfPath = pkg.manifest.workflow;
    const gitHost = opts.git_url ?? (opts.api_url ? gitHostFor(opts.api_url) : undefined);
    const upFiles = new Map<string, Buffer>();
    for (const f of pkg.manifest.files) {
      let data = pkg.read(f.path)!;
      if (f.path === wfPath) {
        let text = fillWorkflowText(data.toString('utf8'), e, values);
        if (gitHost) text = withGitHost(text, gitHost.replace(/\/+$/, ''), Boolean(opts.git_url));
        data = Buffer.from(text);
      }
      upFiles.set(f.path, data);
    }
    const baseFiles = rec ? new Map(Object.entries(rec.base_files).map(([path, b64]) => [path, Buffer.from(b64, 'base64')])) : undefined;
    const localFiles = new Map<string, Buffer>();
    for (const f of local.manifest.files) localFiles.set(f.path, await packageFile(ctx, p.workspaceId, local.package_hash, f.path));
    const merged = mergePackages(baseFiles, localFiles, upFiles, wfPath);

    // Tools: the marketplace's description and schemas, with the repositories and API address kept as they are here.
    const toolPlan: Array<{ ref: string; kind: 'added' | 'updated' | 'unchanged'; spec: ToolSpec }> = [];
    for (const t of e.config.tools ?? []) {
      const spec = fill(structuredClone(t), values);
      const ref = `${spec.id}@${spec.version}`;
      const installed = await loadToolRevision(ctx, p.workspaceId, ref, undefined);
      if (installed) {
        const mine = (installed.transport as { config?: Record<string, unknown> }).config ?? {};
        const keep = Object.fromEntries(['repos', 'api_url'].filter((k) => k in mine).map((k) => [k, mine[k]]));
        (spec.transport as { config?: Record<string, unknown> }).config = { ...((spec.transport as { config?: Record<string, unknown> }).config ?? {}), ...keep };
        if (installed.credential) spec.credential = installed.credential;
      }
      const { revision: _r, ...cur } = installed ?? ({} as ToolSpec);
      toolPlan.push({ ref, kind: !installed ? 'added' : canon(cur) === canon(spec) ? 'unchanged' : 'updated', spec });
    }
    const toolsChanged = toolPlan.filter((t) => t.kind !== 'unchanged');
    const wanted = settingsOf(e).map((s) => ({ ...s, value: values[s.name] ?? null }));
    const missingSettings = wanted.filter((s) => s.value === null);
    const summary = summarise(merged.report);
    const nothing = merged.report.changes.length === 0 && toolsChanged.length === 0;
    const report = { ...merged.report, summary, tools: toolsChanged.map((t) => ({ ref: t.ref, kind: t.kind })), tracked: Boolean(rec), nothing_to_update: nothing };

    // A dry run cannot compile against tools it has not registered yet.
    const checked = b.dry_run && toolPlan.some((t) => t.kind === 'added') ? undefined : await checkPackage(ctx, p.workspaceId, wfPath, merged.files);
    if (b.dry_run) return { ok: !checked || checked.ok, dry_run: true, report, diagnostics: checked && !checked.ok ? checked.diagnostics : [], settings: wanted };
    if (nothing) {
      if (rec) await saveInstallRecord(ctx, p.workspaceId, e, Object.fromEntries([...upFiles].map(([k, v]) => [k, v.toString('base64')])), opts, p.userId);
      return { ok: true, updated: false, report, version: { id: local.id, workflow: local.slug, version: local.version, draft: local.draft }, settings: wanted };
    }

    for (const t of toolsChanged) await registerTool(ctx, p.workspaceId, t.spec, p.userId);
    const up = await uploadPackage(ctx, p.workspaceId, { workflow: wfPath, files: Object.fromEntries([...merged.files].map(([k, v]) => [k, v.toString('base64')])) }, p.userId);
    if (!up.ok) return { ok: false, diagnostics: up.diagnostics, report };
    await saveInstallRecord(ctx, p.workspaceId, e, Object.fromEntries([...upFiles].map(([k, v]) => [k, v.toString('base64')])), opts, p.userId);
    await audit(ctx, p.workspaceId, p.userId, 'example.updated', { example: id, version: up.version.id, from: local.id, ...summary, tools: toolsChanged.map((t) => t.ref) });
    const set = new Set((await listSecrets(ctx, p.workspaceId)).map((s) => s.name));
    return {
      ok: true,
      updated: true,
      report,
      diagnostics: up.diagnostics,
      version: { id: up.version.id, workflow: up.version.slug, version: up.version.version, draft: up.version.draft },
      secrets: secretsOf(e).map((name) => ({ name, set: set.has(name) })),
      settings: wanted,
      settings_missing: missingSettings.map((s) => s.name),
    };
  });
}
