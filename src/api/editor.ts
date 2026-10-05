import type { FastifyInstance, FastifyRequest } from 'fastify';
import { stringify } from 'yaml';
import { z } from 'zod';
import type { Diagnostic } from '../definition/load.js';
import { parseProfile } from '../agents/profile.js';
import { EXECUTORS } from '../executors/capabilities.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { buildRunPlan } from '../plan/run-plan.js';
import type { AppContext } from '../server/context.js';
import { packageFile } from '../server/packages.js';
import { checkPackage, resolveVersion, uploadPackage, type VersionRow } from '../server/workflows.js';
import { requireRole } from './auth.js';

/**
 * The workflow editor in mission control (docs/mission-control-plan.md, increment 5). The browser
 * edits a version's definition; the server writes it back as the package's workflow file next to
 * the version's other files (profiles, schemas, templates, scripts), checks it with the same
 * compiler and run plan as `azhi publish`, and saves it through the normal package upload as a
 * new unsigned draft. Publishing still needs a publisher signature.
 */
function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

const TEXT = /\.(ya?ml|json|md|txt|py|ts|js|mjs|toml|lock|csv|html)$/i;

async function version(ctx: AppContext, workspaceId: string, ref: string): Promise<VersionRow> {
  const v = await resolveVersion(ctx, workspaceId, ref);
  if (!v) throw new AzhiError(ErrorClass.invalidInput, 'workflow version not found');
  return v;
}

/** The version's files with its workflow file replaced by the edited definition. */
async function edited(ctx: AppContext, workspaceId: string, base: VersionRow, definition: unknown, profiles: Record<string, string> = {}, extra: Record<string, string | null> = {}) {
  const original = (await packageFile(ctx, workspaceId, base.package_hash, base.manifest.workflow)).toString('utf8');
  // Keep the file's opening comment; the rest is written from the definition.
  const header = original.match(/^(?:#[^\n]*\n)+/)?.[0] ?? '';
  const text = header + stringify(definition, { lineWidth: 0 });
  const files = new Map<string, Buffer>();
  for (const f of base.manifest.files) files.set(f.path, f.path === base.manifest.workflow ? Buffer.from(text) : await packageFile(ctx, workspaceId, base.package_hash, f.path));
  // Profiles written by the harness builder replace or join the version's own.
  for (const [path, body] of Object.entries(profiles)) files.set(path, Buffer.from(body));
  // Harness files (OpenCode agents, commands, skills, MCP servers) written in the editor; null removes one.
  for (const [path, body] of Object.entries(extra)) {
    if (body === null) files.delete(path);
    else files.set(path, Buffer.from(body));
  }
  return { text, files };
}

const PROFILE_PATH = /^profiles\/[a-z0-9][a-z0-9._-]*@\d+\.yaml$/;
/** Editable harness files: under harness/, plain names, no hidden or parent segments. */
const HARNESS_PATH = /^harness\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(md|mjs|js|json|ya?ml|txt)$/;
const body = z.object({
  definition: z.record(z.string(), z.unknown()),
  /** Agent profiles written by the harness builder, by package path (`profiles/<name>@<n>.yaml`). */
  profiles: z.record(z.string(), z.string().max(64 * 1024)).optional(),
  /** Harness files written in the editor, by package path (`harness/...`); null removes the file. */
  files: z
    .record(z.string(), z.string().max(64 * 1024).nullable())
    .superRefine((f, c) => {
      for (const path of Object.keys(f)) if (!HARNESS_PATH.test(path)) c.addIssue({ code: 'custom', message: `${path}: editable files live under harness/ (agents, commands, skills, mcp)` });
    })
    .refine((f) => Object.keys(f).length <= 100, 'at most 100 harness files per edit')
    .optional(),
});

/** Profiles the browser sends are checked like the compiler will: a bad one is reported, not stored. */
function profileDiagnostics(profiles: Record<string, string> = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [path, text] of Object.entries(profiles)) {
    if (!PROFILE_PATH.test(path)) {
      out.push({ severity: 'error', code: 'profile_path', message: `${path}: profiles live at profiles/<name>@<version>.yaml`, path });
      continue;
    }
    try {
      parseProfile(text, path);
    } catch (e) {
      out.push({ severity: 'error', code: 'profile_invalid', message: (e as Error).message, path });
    }
  }
  return out;
}

export function registerEditorRoutes(app: FastifyInstance, ctx: AppContext) {
  // What each executor declares it can do (spec section 9), for the harness builder.
  app.get('/v1/executors', async (req) => {
    user(req);
    return {
      executors: Object.values(EXECUTORS).map((e) => ({ id: e.id, version: e.version, capabilities: e.capabilities, notes: e.notes, providers: e.providers })),
      providers: ['anthropic', 'openai'],
    };
  });

  // The package's files as stored: the workflow file and other text files in full, the rest by size.
  app.get('/v1/versions/:ref/source', async (req) => {
    const p = user(req);
    const v = await version(ctx, p.workspaceId, (req.params as { ref: string }).ref);
    const files = [];
    for (const f of v.manifest.files) {
      const text = TEXT.test(f.path) && f.size <= 256 * 1024 ? (await packageFile(ctx, p.workspaceId, v.package_hash, f.path)).toString('utf8') : undefined;
      files.push({ path: f.path, size: f.size, text });
    }
    return { workflow: v.manifest.workflow, package_hash: v.package_hash, files };
  });

  // Checks an edited definition without saving it: compiler diagnostics and, when it compiles,
  // the run plan it would have (unsigned, as a draft would be).
  app.post('/v1/versions/:ref/check', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const base = await version(ctx, p.workspaceId, (req.params as { ref: string }).ref);
    const { definition, profiles, files: extra } = body.parse(req.body);
    const { text, files } = await edited(ctx, p.workspaceId, base, definition, profiles, extra);
    const pinned = pinId(base, definition);
    if (pinned) return { ok: false, diagnostics: [pinned], yaml: text };
    const bad = profileDiagnostics(profiles);
    if (bad.length) return { ok: false, diagnostics: bad, yaml: text };
    const r = await checkPackage(ctx, p.workspaceId, base.manifest.workflow, files);
    if (!r.ok) return { ok: false, diagnostics: r.diagnostics, yaml: text };
    const draft: VersionRow = { ...base, definition: r.definition, plan: r.compiled.plan, draft: true, signature: null };
    const plan = await buildRunPlan(ctx, p.workspaceId, draft, { userId: p.userId, role: p.role });
    return { ok: true, diagnostics: r.compiled.diagnostics, yaml: text, plan };
  });

  // Saves the edited definition as a new draft version through the normal package upload.
  app.post('/v1/versions/:ref/drafts', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const base = await version(ctx, p.workspaceId, (req.params as { ref: string }).ref);
    const { definition, profiles, files: extra } = body.parse(req.body);
    const { files } = await edited(ctx, p.workspaceId, base, definition, profiles, extra);
    const pinned = pinId(base, definition);
    if (pinned) return { ok: false, diagnostics: [pinned] };
    const bad = profileDiagnostics(profiles);
    if (bad.length) return { ok: false, diagnostics: bad };
    const upload = { workflow: base.manifest.workflow, files: Object.fromEntries([...files].map(([k, b]) => [k, b.toString('base64')])) };
    const r = await uploadPackage(ctx, p.workspaceId, upload, p.userId);
    if (!r.ok) return { ok: false, diagnostics: r.diagnostics };
    const v = r.version;
    return { ok: true, diagnostics: r.diagnostics, version: { id: v.id, workflow: v.slug, version: v.version, package_hash: v.package_hash, draft: v.draft, signed: Boolean(v.signature) } };
  });
}

/** An edit stays a version of the same workflow; a new id would quietly start another one. */
function pinId(base: VersionRow, definition: Record<string, unknown>): Diagnostic | undefined {
  if (definition.id === base.slug) return undefined;
  return { severity: 'error', code: 'workflow_id_changed', message: `the workflow id must stay '${base.slug}'`, path: '/id' };
}
