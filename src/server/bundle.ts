import { z } from 'zod';
import { BUILTIN_TOOLS } from '../gateway/executors.js';
import { toolRef, type ToolSpec } from '../gateway/types.js';
import { normalise } from '../knowledge/chunk.js';
import { addDocuments, createDataset, getDataset, publishRevision, tagRevision } from '../knowledge/datasets.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { contentHash, sha256 } from '../lib/hash.js';
import { readZip, writeZip } from '../lib/zip.js';
import { datasetAllows } from '../plan/run-plan.js';
import { AssetKind, ASSET_KINDS, attachAsset, createAsset, getAsset, publishAsset, renderClaudeCode, renderOpenCode, updateAsset, validateAsset } from './assets.js';
import { audit, loadToolRevision, registerTool } from './catalog.js';
import type { AppContext } from './context.js';
import { packageFile } from './packages.js';
import { listSecrets } from './secrets.js';
import { getVersion, uploadPackage, type VersionRow } from './workflows.js';

/**
 * Workflow bundles: one zip holding a workflow and everything it needs to run elsewhere: the package
 * files, the gateway tools its steps call, the library assets (MCP servers, agents, skills, commands)
 * attached to it, the knowledge datasets it reads, and the harness files for OpenCode and Claude Code.
 * Secret values never enter a bundle, only the names a tool or step expects.
 *
 *   bundle.json                        index, secret names, and a SHA-256 of every other file
 *   package/<path>                     the workflow package as uploaded
 *   tools/<id>@<version>.json          tool registrations
 *   assets/<kind>/<slug>.json          attached library assets
 *   datasets/<name>/dataset.json       trust, ACL and tags
 *   datasets/<name>/docs/<path>        the dataset's documents
 *   harness/opencode, harness/claude-code   derived files, not read back on import
 */
export const BUNDLE_FORMAT = 'azhi-workflow-bundle/1';

export type ImportMode = 'add' | 'override';
export type ItemAction = 'create' | 'replace' | 'unchanged' | 'skip';
export interface ReportItem { kind: 'workflow' | 'tool' | 'asset' | 'dataset'; name: string; action: ItemAction; detail?: string }

const Index = z.object({
  format: z.literal(BUNDLE_FORMAT),
  workflow: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  exported_at: z.string(),
  source: z.object({ version: z.number(), package_hash: z.string() }),
  secrets: z.array(z.string()),
  omitted: z.array(z.object({ kind: z.string(), name: z.string(), reason: z.string() })).default([]),
  files: z.record(z.string(), z.string()),
});
type BundleIndex = z.infer<typeof Index>;

const AssetFile = z.object({ kind: z.enum(ASSET_KINDS), slug: z.string(), name: z.string().min(1).max(120), description: z.string().max(2000).default(''), scope: z.enum(['global', 'project']).default('global'), version: z.number().optional(), definition: z.record(z.string(), z.unknown()) });
const DatasetFile = z.object({ name: z.string(), trusted: z.boolean(), acl: z.object({ roles: z.array(z.string()).optional(), users: z.array(z.string()).optional() }), tags: z.array(z.string()) });
const ToolFile = z.object({ id: z.string().min(1), version: z.number().int().positive(), description: z.string(), input_schema: z.record(z.string(), z.unknown()), output_schema: z.record(z.string(), z.unknown()), effect: z.string(), transport: z.object({ kind: z.enum(['builtin', 'http', 'mcp-stdio', 'mcp-streamable-http']) }).passthrough() }).passthrough();

const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
const toolFileName = (ref: string) => `tools/${ref}.json`;

/** Names of the datasets a package's steps read (`name` or `name@tag`). */
function datasetsOf(v: VersionRow): string[] {
  const out = new Set<string>();
  for (const n of v.plan.nodes) for (const d of (n.def as { datasets?: unknown }).datasets as unknown[] ?? []) if (typeof d === 'string') out.add(d.split('@')[0]!);
  return [...out].sort();
}

async function latestVersion(ctx: AppContext, workspaceId: string, slug: string): Promise<VersionRow | undefined> {
  const row = (await ctx.pool.query(`SELECT v.id FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.workspace_id=$1 AND w.slug=$2 ORDER BY v.version DESC LIMIT 1`, [workspaceId, slug])).rows[0] as { id: string } | undefined;
  return row ? getVersion(ctx, workspaceId, row.id) : undefined;
}

export async function exportBundle(ctx: AppContext, workspaceId: string, slug: string, who: { userId: string; role: string }): Promise<{ zip: Buffer; version: number }> {
  const v = await latestVersion(ctx, workspaceId, slug);
  if (!v) throw new AzhiError(ErrorClass.invalidInput, `workflow ${slug} not found`);
  const files = new Map<string, Buffer>();
  const omitted: BundleIndex['omitted'] = [];
  for (const f of v.manifest.files) files.set(`package/${f.path}`, await packageFile(ctx, workspaceId, v.package_hash, f.path));

  const secrets = new Set<string>();
  const refs = new Set<string>();
  for (const n of v.plan.nodes) {
    if (n.tool) refs.add(n.tool.ref);
    for (const t of n.agentTools ?? []) refs.add(t.ref);
  }
  for (const ref of [...refs].sort()) {
    if (BUILTIN_TOOLS.some((t) => toolRef(t) === ref)) continue;
    const spec = await loadToolRevision(ctx, workspaceId, ref, undefined);
    if (!spec) { omitted.push({ kind: 'tool', name: ref, reason: 'not registered in this workspace' }); continue; }
    const { revision: _r, retired: _x, ...clean } = spec;
    if (clean.credential) secrets.add(clean.credential);
    files.set(toolFileName(ref), json(clean));
  }

  const assets = (await ctx.pool.query(
    `SELECT a.kind, a.slug, a.name, a.description, a.scope, v.version, v.definition
     FROM workflow_portable_assets wpa JOIN workflows w ON w.id=wpa.workflow_id JOIN portable_assets a ON a.id=wpa.asset_id JOIN portable_asset_versions v ON v.id=wpa.asset_version_id
     WHERE w.workspace_id=$1 AND w.slug=$2 ORDER BY a.kind, a.slug`, [workspaceId, slug])).rows as Array<{ kind: AssetKind; slug: string; name: string; description: string; scope: string; version: number; definition: Record<string, unknown> }>;
  for (const a of assets) files.set(`assets/${a.kind}/${a.slug}.json`, json(a));
  for (const [dir, render] of [['opencode', renderOpenCode], ['claude-code', renderClaudeCode]] as const) {
    for (const [path, text] of Object.entries(render(assets))) files.set(`harness/${dir}/${path}`, Buffer.from(text as string));
  }

  for (const name of datasetsOf(v)) {
    const d = await getDataset(ctx, workspaceId, name);
    if (!d) { omitted.push({ kind: 'dataset', name, reason: 'does not exist in this workspace' }); continue; }
    if (!datasetAllows(d.acl, who)) { omitted.push({ kind: 'dataset', name, reason: 'you are not allowed to read it' }); continue; }
    const tags = (await ctx.pool.query(`SELECT tag FROM dataset_tags WHERE dataset_id=$1 AND tag <> 'latest' ORDER BY tag`, [d.id])).rows.map((r) => r.tag as string);
    files.set(`datasets/${name}/dataset.json`, json({ name, trusted: d.trusted, acl: d.acl, tags }));
    const docs = (await ctx.pool.query(`SELECT path, artifact FROM dataset_documents WHERE dataset_id=$1 AND NOT revoked ORDER BY path`, [d.id])).rows as Array<{ path: string; artifact: string }>;
    for (const doc of docs) {
      const data = ctx.artifacts.get(doc.artifact);
      if (data) files.set(`datasets/${name}/docs/${doc.path}`, data);
      else omitted.push({ kind: 'document', name: `${name}/${doc.path}`, reason: 'missing from the artifact store' });
    }
  }

  const index: BundleIndex = {
    format: BUNDLE_FORMAT,
    workflow: slug,
    exported_at: new Date().toISOString(),
    source: { version: v.version, package_hash: v.package_hash },
    secrets: [...secrets].sort(),
    omitted,
    files: Object.fromEntries([...files].map(([p, d]) => [p, sha256(d)])),
  };
  files.set('bundle.json', json(index));
  await audit(ctx, workspaceId, who.userId, 'workflow.bundle_exported', { workflow: slug, version: v.version, files: files.size });
  return { zip: writeZip(files), version: v.version };
}

interface Parsed {
  index: BundleIndex;
  package: Map<string, Buffer>;
  tools: ToolSpec[];
  assets: Array<z.infer<typeof AssetFile>>;
  datasets: Array<{ meta: z.infer<typeof DatasetFile>; docs: Array<{ path: string; content: string }> }>;
}

/** Reads and checks a bundle without touching the workspace. Everything in it is data. */
export function parseBundle(zip: Buffer): Parsed {
  const entries = readZip(zip);
  const idx = entries.get('bundle.json');
  if (!idx) throw new AzhiError(ErrorClass.invalidInput, 'not a workflow bundle: bundle.json is missing');
  let raw: unknown;
  try { raw = JSON.parse(idx.toString('utf8')); } catch { throw new AzhiError(ErrorClass.invalidInput, 'bundle.json is not valid JSON'); }
  const parsed = Index.safeParse(raw);
  if (!parsed.success) throw new AzhiError(ErrorClass.invalidInput, `bundle.json is not a ${BUNDLE_FORMAT} index: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const index = parsed.data;
  for (const [path, data] of entries) {
    if (path === 'bundle.json') continue;
    if (index.files[path] !== sha256(data)) throw new AzhiError(ErrorClass.invalidInput, `${path} does not match the bundle index (changed or not listed)`);
  }
  for (const path of Object.keys(index.files)) if (!entries.has(path)) throw new AzhiError(ErrorClass.invalidInput, `${path} is listed in the bundle index but missing`);

  const fail = (path: string, why: string): never => { throw new AzhiError(ErrorClass.invalidInput, `${path}: ${why}`); };
  const out: Parsed = { index, package: new Map(), tools: [], assets: [], datasets: [] };
  const docs = new Map<string, Array<{ path: string; content: string }>>();
  const metas = new Map<string, z.infer<typeof DatasetFile>>();
  for (const [path, data] of entries) {
    if (path === 'bundle.json' || path.startsWith('harness/')) continue;
    if (path.startsWith('package/')) { out.package.set(path.slice('package/'.length), data); continue; }
    const readJson = <T>(schema: z.ZodType<T>): T => {
      let v: unknown;
      try { v = JSON.parse(data.toString('utf8')); } catch { return fail(path, 'not valid JSON'); }
      const r = schema.safeParse(v);
      return r.success ? r.data : fail(path, r.error.issues[0]?.message ?? 'invalid');
    };
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^tools\/([^/]+)\.json$/))) {
      const spec = readJson(ToolFile) as unknown as ToolSpec;
      if (toolRef(spec) !== m[1]) fail(path, `file name does not match ${toolRef(spec)}`);
      if (BUILTIN_TOOLS.some((t) => toolRef(t) === toolRef(spec))) fail(path, 'a built-in tool cannot be imported');
      out.tools.push({ ...spec, revision: undefined, retired: undefined } as ToolSpec);
    } else if ((m = path.match(/^assets\/([a-z]+)\/([^/]+)\.json$/))) {
      const a = readJson(AssetFile);
      if (a.kind !== m[1] || a.slug !== m[2]) fail(path, 'kind or slug does not match the file name');
      const errors = validateAsset(a.kind, a.slug, a.definition);
      if (errors.length) fail(path, errors.join('; '));
      out.assets.push(a);
    } else if ((m = path.match(/^datasets\/([^/]+)\/dataset\.json$/))) {
      const meta = readJson(DatasetFile);
      if (meta.name !== m[1] || !/^[a-z0-9][a-z0-9._-]*$/.test(meta.name)) fail(path, 'invalid dataset name');
      metas.set(meta.name, meta);
    } else if ((m = path.match(/^datasets\/([^/]+)\/docs\/(.+)$/))) {
      if (!/\.(md|markdown|txt|text)$/i.test(m[2]!)) fail(path, 'only Markdown and plain text documents are supported');
      docs.set(m[1]!, [...(docs.get(m[1]!) ?? []), { path: m[2]!, content: data.toString('utf8') }]);
    } else fail(path, 'not part of a workflow bundle');
  }
  for (const [name, meta] of metas) out.datasets.push({ meta, docs: (docs.get(name) ?? []).sort((a, b) => a.path.localeCompare(b.path)) });
  for (const name of docs.keys()) if (!metas.has(name)) fail(`datasets/${name}`, 'documents without a dataset.json');
  if (!['workflow.yaml', 'workflow.yml', 'azhi.yaml'].some((f) => out.package.has(f))) throw new AzhiError(ErrorClass.invalidInput, 'the bundle has no workflow.yaml in package/');
  out.tools.sort((a, b) => toolRef(a).localeCompare(toolRef(b)));
  return out;
}

const transportOf = (t: ToolSpec) => {
  const x = t.transport as { kind: string; command?: string[]; url?: string; connection?: string };
  return `${x.kind}${x.command ? `: ${x.command.join(' ')}` : x.url ? `: ${x.url}` : x.connection ? `: ${x.connection}` : ''}`;
};

/**
 * Brings a bundle into a workspace. `add` creates what is missing and leaves everything that already
 * exists alone; `override` replaces existing tools, assets and dataset documents with the bundle's
 * (as new revisions or versions, never by deleting) and adds a new workflow version. A dry run
 * reports the same plan without writing. The workflow version is always a draft: it still has to be
 * signed and published.
 */
export async function importBundle(ctx: AppContext, workspaceId: string, zip: Buffer, o: { mode: ImportMode; dryRun: boolean; actor: string }) {
  const b = parseBundle(zip);
  const { mode, dryRun, actor } = o;
  const items: ReportItem[] = [];
  const slug = b.index.workflow;
  const note = (i: ReportItem) => void items.push(i);

  // Plan: what exists and what differs, before anything is written.
  const toolPlan = [];
  for (const spec of b.tools) {
    const ref = toolRef(spec);
    const cur = await loadToolRevision(ctx, workspaceId, ref, undefined);
    const same = cur ? (({ revision: _r, ...c }) => contentHash(c))(cur) === contentHash({ ...spec, revision: undefined, retired: undefined }) : false;
    const action: ItemAction = !cur ? 'create' : same ? 'unchanged' : mode === 'override' ? 'replace' : 'skip';
    toolPlan.push({ spec, action });
    note({ kind: 'tool', name: ref, action, detail: transportOf(spec) + (action === 'skip' ? ' (a different registration exists; kept)' : '') });
  }
  const datasetPlan = [];
  for (const d of b.datasets) {
    const cur = await getDataset(ctx, workspaceId, d.meta.name);
    const have = new Map<string, string>();
    if (cur) for (const r of (await ctx.pool.query(`SELECT path, content_hash FROM dataset_documents WHERE dataset_id=$1 AND NOT revoked`, [cur.id])).rows) have.set(r.path, r.content_hash);
    const missing = d.docs.filter((x) => !have.has(x.path));
    const changed = d.docs.filter((x) => have.has(x.path) && have.get(x.path) !== `sha256:${sha256(normalise(x.content))}`);
    const write = mode === 'override' ? [...missing, ...changed] : missing;
    const action: ItemAction = !cur ? 'create' : write.length ? (mode === 'override' && changed.length ? 'replace' : 'create') : changed.length ? 'skip' : 'unchanged';
    datasetPlan.push({ ...d, exists: Boolean(cur), write, action });
    note({ kind: 'dataset', name: d.meta.name, action, detail: `${d.docs.length} document${d.docs.length === 1 ? '' : 's'}, ${write.length} to write${action === 'skip' ? ' (changed documents kept)' : ''}` });
  }
  const local = await latestVersion(ctx, workspaceId, slug);
  const wfPath = ['workflow.yaml', 'workflow.yml', 'azhi.yaml'].find((f) => b.package.has(f))!;
  const sameFiles = local && local.manifest.files.length === b.package.size && local.manifest.files.every((f) => b.package.has(f.path) && sha256(b.package.get(f.path)!) === f.sha256);
  const wfAction: ItemAction = !local ? 'create' : sameFiles ? 'unchanged' : mode === 'override' ? 'replace' : 'skip';
  note({ kind: 'workflow', name: slug, action: wfAction, detail: wfAction === 'skip' ? `already exists at v${local!.version}; use override to add a new version` : wfAction === 'replace' ? `new draft version after v${local!.version}` : undefined });
  const assetPlan = [];
  for (const a of b.assets) {
    const cur = (await ctx.pool.query(`SELECT id FROM portable_assets WHERE workspace_id=$1 AND kind=$2 AND slug=$3`, [workspaceId, a.kind, a.slug])).rows[0] as { id: string } | undefined;
    const full = cur ? await getAsset(ctx, workspaceId, cur.id) : undefined;
    const curDef = full?.versions.find((v: { version: number }) => v.version === full.current_version)?.definition;
    const same = curDef !== undefined && contentHash(curDef) === contentHash(a.definition);
    const action: ItemAction = !cur ? 'create' : same ? 'unchanged' : mode === 'override' ? 'replace' : 'skip';
    assetPlan.push({ a, id: cur?.id, action });
    note({ kind: 'asset', name: `${a.kind}: ${a.slug}`, action, detail: action === 'skip' ? 'a different one exists; kept' : undefined });
  }
  const set = new Set((await listSecrets(ctx, workspaceId)).map((s) => s.name));
  const secrets = b.index.secrets.map((name) => ({ name, set: set.has(name) }));
  const report = { workflow: slug, mode, source_version: b.index.source.version, exported_at: b.index.exported_at, items, secrets, omitted_at_export: b.index.omitted };
  if (dryRun) return { ok: true as const, dry_run: true as const, ...report };

  // Apply. Tools and datasets go first so the workflow compiles against them (and taint analysis
  // sees the datasets' trust); library assets come last because attaching needs the workflow.
  for (const t of toolPlan) if (t.action === 'create' || t.action === 'replace') await registerTool(ctx, workspaceId, t.spec, actor);
  for (const d of datasetPlan) {
    if (d.action === 'skip' || d.action === 'unchanged') continue;
    // In add mode an existing dataset keeps its trust and ACL; only a new one takes the bundle's.
    if (!d.exists || mode === 'override') await createDataset(ctx, workspaceId, { name: d.meta.name, trusted: d.meta.trusted, acl: d.meta.acl });
    if (d.write.length) {
      await addDocuments(ctx, workspaceId, d.meta.name, d.write);
      const [first, ...rest] = d.meta.tags;
      const r = await publishRevision(ctx, workspaceId, d.meta.name, first);
      for (const tag of rest) await tagRevision(ctx, workspaceId, d.meta.name, tag, r.revision);
    }
  }
  let version: { id: string; workflow: string; version: number; draft: boolean } | undefined;
  let diagnostics: unknown[] = [];
  if (wfAction === 'create' || wfAction === 'replace') {
    const up = await uploadPackage(ctx, workspaceId, { workflow: wfPath, files: Object.fromEntries([...b.package].map(([p, d]) => [p, d.toString('base64')])) }, actor);
    if (!up.ok) return { ok: false as const, dry_run: false as const, ...report, diagnostics: up.diagnostics };
    version = { id: up.version.id, workflow: up.version.slug, version: up.version.version, draft: up.version.draft };
    diagnostics = up.diagnostics;
  } else if (local) version = { id: local.id, workflow: local.slug, version: local.version, draft: local.draft };
  for (const { a, id, action } of assetPlan) {
    let assetId = id;
    if (action === 'create') {
      assetId = (await createAsset(ctx, workspaceId, { kind: a.kind, slug: a.slug, name: a.name, description: a.description, definition: a.definition, scope: 'global' }, actor))!.id;
      await publishAsset(ctx, workspaceId, assetId!, actor);
    } else if (action === 'replace') {
      await updateAsset(ctx, workspaceId, id!, { name: a.name, description: a.description, definition: a.definition }, actor);
      await publishAsset(ctx, workspaceId, id!, actor);
    }
    // Attach what the bundle's workflow used, but never switch a workflow that already has this asset to another version in add mode.
    const attached = assetId ? (await ctx.pool.query(`SELECT 1 FROM workflow_portable_assets wpa JOIN workflows w ON w.id=wpa.workflow_id WHERE w.workspace_id=$1 AND w.slug=$2 AND wpa.asset_id=$3`, [workspaceId, slug, assetId])).rowCount : 1;
    const published = assetId ? (await getAsset(ctx, workspaceId, assetId))?.versions.some((v: { published: boolean }) => v.published) : false;
    if (assetId && published && (!attached || action === 'replace')) await attachAsset(ctx, workspaceId, slug, assetId, undefined, actor);
  }
  await audit(ctx, workspaceId, actor, 'workflow.bundle_imported', { workflow: slug, mode, version: version?.id, items: items.filter((i) => i.action !== 'unchanged' && i.action !== 'skip').map((i) => `${i.kind}:${i.name}:${i.action}`) });
  return { ok: true as const, dry_run: false as const, ...report, version, diagnostics };
}
