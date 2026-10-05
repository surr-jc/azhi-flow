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
  return { id, name: String(wf.name ?? id), description: String(wf.description ?? ''), config };
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

export function registerExampleRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/examples', async (req) => {
    const p = user(req);
    const set = new Set((await listSecrets(ctx, p.workspaceId)).map((s) => s.name));
    const ids = existsSync(examplesDir()) ? readdirSync(examplesDir()).filter((d) => ID.test(d)).sort() : [];
    const out = [];
    for (const id of ids) {
      const e = loadExample(id);
      if (!e) continue;
      out.push({
        id: e.id,
        name: e.name,
        description: e.description,
        tools: (e.config.tools ?? []).map((t) => ({ ref: `${t.id}@${t.version}`, effect: t.effect, description: t.description, needs_repos: needsRepos(t) })),
        needs_repos: (e.config.tools ?? []).some(needsRepos),
        secrets: secretsOf(e).map((name) => ({ name, set: set.has(name) })),
        /** Repositories its installed tools may use now (empty before install). */
        repos: await installedRepos(ctx, p.workspaceId, e),
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
      })
      .parse(req.body ?? {});
    const tools = e.config.tools ?? [];
    if (tools.some(needsRepos) && !b.repos?.length) throw new AzhiError(ErrorClass.invalidInput, `example '${id}' needs the repositories its GitHub tools may use (owner/name)`);

    const registered = [];
    for (const t of tools) {
      const spec = structuredClone(t);
      if (needsRepos(spec)) {
        const transport = spec.transport as { config: Record<string, unknown> };
        transport.config = { ...transport.config, repos: b.repos, ...(b.api_url ? { api_url: b.api_url } : {}) };
      }
      const r = await registerTool(ctx, p.workspaceId, spec, p.userId);
      registered.push({ ref: `${spec.id}@${spec.version}`, ...r });
    }

    const pkg = packageFromDirectory(join(examplesDir(), id));
    const files = Object.fromEntries(pkg.manifest.files.map((f) => [f.path, pkg.read(f.path)!.toString('base64')]));
    const gitHost = b.git_url ?? (b.api_url ? gitHostFor(b.api_url) : undefined);
    const wfPath = pkg.manifest.workflow;
    if (gitHost && files[wfPath]) files[wfPath] = Buffer.from(withGitHost(Buffer.from(files[wfPath], 'base64').toString('utf8'), gitHost.replace(/\/+$/, ''), Boolean(b.git_url))).toString('base64');
    const up = await uploadPackage(ctx, p.workspaceId, { workflow: pkg.manifest.workflow, files }, p.userId);
    if (!up.ok) return { ok: false, diagnostics: up.diagnostics, tools: registered };
    await audit(ctx, p.workspaceId, p.userId, 'example.installed', { example: id, version: up.version.id, tools: registered.map((t) => t.ref), repos: b.repos ?? [] });
    const set = new Set((await listSecrets(ctx, p.workspaceId)).map((s) => s.name));
    return {
      ok: true,
      diagnostics: up.diagnostics,
      version: { id: up.version.id, workflow: up.version.slug, version: up.version.version, draft: up.version.draft },
      tools: registered,
      secrets: secretsOf(e).map((name) => ({ name, set: set.has(name) })),
    };
  });
}
