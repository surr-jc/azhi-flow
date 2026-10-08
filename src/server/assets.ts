import { newId } from '../lib/ids.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import type { AppContext } from './context.js';
import { audit } from './catalog.js';

export const ASSET_KINDS = ['mcp', 'agent', 'skill', 'command'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export type PortableDefinition = Record<string, unknown>;

const slugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateAsset(kind: AssetKind, slug: string, definition: PortableDefinition): string[] {
  const errors: string[] = [];
  if (!slugPattern.test(slug)) errors.push('slug must be lowercase letters, numbers, and single hyphens');
  if (kind === 'mcp') {
    if (definition.transport !== 'local' && definition.transport !== 'remote') errors.push('MCP transport must be local or remote');
    if (definition.transport === 'local' && (!Array.isArray(definition.command) || !definition.command.length || !definition.command.every((v) => typeof v === 'string' && v))) errors.push('local MCP requires a non-empty command array');
    if (definition.transport === 'remote' && (typeof definition.url !== 'string' || !/^https:\/\//.test(definition.url))) errors.push('remote MCP requires an https URL');
  }
  if (kind === 'agent' && typeof definition.prompt !== 'string') errors.push('agent requires a prompt');
  if (kind === 'skill') {
    if (typeof definition.instructions !== 'string' || !definition.instructions.trim()) errors.push('skill requires instructions');
    if (!slugPattern.test(slug)) errors.push('OpenCode skill names must be lowercase kebab-case');
  }
  if (kind === 'command' && (typeof definition.template !== 'string' || !definition.template.trim())) errors.push('command requires a template');
  return errors;
}

export async function listAssets(ctx: AppContext, workspaceId: string, kind?: AssetKind) {
  const r = await ctx.pool.query(
    `SELECT a.id, a.kind, a.slug, a.name, a.description, a.status, a.current_version, a.created_at, a.updated_at,
      v.id AS version_id, v.definition, v.published, v.created_at AS version_created_at
     FROM portable_assets a LEFT JOIN portable_asset_versions v ON v.asset_id=a.id AND v.version=a.current_version
     WHERE a.workspace_id=$1 AND ($2::text IS NULL OR a.kind=$2) ORDER BY a.kind, a.name`, [workspaceId, kind ?? null],
  );
  return r.rows;
}

export async function getAsset(ctx: AppContext, workspaceId: string, id: string) {
  const a = (await ctx.pool.query(`SELECT * FROM portable_assets WHERE workspace_id=$1 AND id=$2`, [workspaceId, id])).rows[0];
  if (!a) return undefined;
  const versions = (await ctx.pool.query(`SELECT id, version, definition, published, created_at FROM portable_asset_versions WHERE asset_id=$1 ORDER BY version DESC`, [id])).rows;
  return { ...a, versions };
}

export async function createAsset(ctx: AppContext, workspaceId: string, input: { kind: AssetKind; slug: string; name: string; description?: string; definition: PortableDefinition }, actor: string) {
  const errors = validateAsset(input.kind, input.slug, input.definition);
  if (errors.length) throw new AzhiError(ErrorClass.invalidInput, errors.join('; '));
  const id = newId('ast'); const versionId = newId('astv');
  await ctx.pool.query(`INSERT INTO portable_assets(id, workspace_id, kind, slug, name, description, current_version, created_by) VALUES ($1,$2,$3,$4,$5,$6,1,$7)`, [id, workspaceId, input.kind, input.slug, input.name, input.description ?? '', actor]);
  await ctx.pool.query(`INSERT INTO portable_asset_versions(id, asset_id, version, definition, created_by) VALUES ($1,$2,1,$3,$4)`, [versionId, id, JSON.stringify(input.definition), actor]);
  await audit(ctx, workspaceId, actor, 'portable_asset.created', { asset: id, kind: input.kind, slug: input.slug });
  return getAsset(ctx, workspaceId, id);
}

export async function updateAsset(ctx: AppContext, workspaceId: string, id: string, input: { name: string; description?: string; definition: PortableDefinition }, actor: string) {
  const asset = await getAsset(ctx, workspaceId, id);
  if (!asset) throw new AzhiError(ErrorClass.invalidInput, 'portable asset not found');
  if (asset.status === 'archived') throw new AzhiError(ErrorClass.invalidInput, 'archived assets cannot be edited');
  const errors = validateAsset(asset.kind, asset.slug, input.definition);
  if (errors.length) throw new AzhiError(ErrorClass.invalidInput, errors.join('; '));
  const version = Number(asset.current_version) + 1; const versionId = newId('astv');
  await ctx.pool.query(`INSERT INTO portable_asset_versions(id, asset_id, version, definition, created_by) VALUES ($1,$2,$3,$4,$5)`, [versionId, id, version, JSON.stringify(input.definition), actor]);
  await ctx.pool.query(`UPDATE portable_assets SET name=$3, description=$4, current_version=$5, status='draft', updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, id, input.name, input.description ?? '', version]);
  await audit(ctx, workspaceId, actor, 'portable_asset.updated', { asset: id, version });
  return getAsset(ctx, workspaceId, id);
}

export async function publishAsset(ctx: AppContext, workspaceId: string, id: string, actor: string) {
  const asset = await getAsset(ctx, workspaceId, id);
  if (!asset) throw new AzhiError(ErrorClass.invalidInput, 'portable asset not found');
  const current = asset.versions.find((v: any) => v.version === asset.current_version);
  if (!current) throw new AzhiError(ErrorClass.invalidInput, 'portable asset has no current version');
  const errors = validateAsset(asset.kind, asset.slug, current.definition);
  if (errors.length) throw new AzhiError(ErrorClass.invalidInput, errors.join('; '));
  await ctx.pool.query(`UPDATE portable_asset_versions SET published=true WHERE id=$1`, [current.id]);
  await ctx.pool.query(`UPDATE portable_assets SET status='published', updated_at=now() WHERE id=$1`, [id]);
  await audit(ctx, workspaceId, actor, 'portable_asset.published', { asset: id, version: asset.current_version });
  return getAsset(ctx, workspaceId, id);
}

export async function archiveAsset(ctx: AppContext, workspaceId: string, id: string, actor: string) {
  const r = await ctx.pool.query(`UPDATE portable_assets SET status='archived', updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`, [workspaceId, id]);
  if (!r.rows[0]) throw new AzhiError(ErrorClass.invalidInput, 'portable asset not found');
  await audit(ctx, workspaceId, actor, 'portable_asset.archived', { asset: id });
}

export async function attachAsset(ctx: AppContext, workspaceId: string, workflowSlug: string, assetId: string, version: number | undefined, actor: string) {
  const workflow = (await ctx.pool.query(`SELECT id FROM workflows WHERE workspace_id=$1 AND slug=$2`, [workspaceId, workflowSlug])).rows[0];
  if (!workflow) throw new AzhiError(ErrorClass.invalidInput, 'workflow not found');
  const asset = await getAsset(ctx, workspaceId, assetId);
  if (!asset) throw new AzhiError(ErrorClass.invalidInput, 'portable asset not found');
  const v = asset.versions.find((x: any) => x.version === (version ?? asset.current_version));
  if (!v?.published) throw new AzhiError(ErrorClass.invalidInput, 'attach a published asset version');
  await ctx.pool.query(`INSERT INTO workflow_portable_assets(workspace_id, workflow_id, asset_id, asset_version_id, attached_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(workflow_id, asset_id) DO UPDATE SET asset_version_id=EXCLUDED.asset_version_id, attached_by=EXCLUDED.attached_by, attached_at=now()`, [workspaceId, workflow.id, assetId, v.id, actor]);
  await audit(ctx, workspaceId, actor, 'workflow.portable_asset_attached', { workflow: workflowSlug, asset: assetId, version: v.version });
}

export async function workflowAssets(ctx: AppContext, workspaceId: string, workflowSlug: string) {
  return (await ctx.pool.query(`SELECT a.id, a.kind, a.slug, a.name, v.version, v.definition, wpa.enabled FROM workflow_portable_assets wpa JOIN workflows w ON w.id=wpa.workflow_id JOIN portable_assets a ON a.id=wpa.asset_id JOIN portable_asset_versions v ON v.id=wpa.asset_version_id WHERE w.workspace_id=$1 AND w.slug=$2 ORDER BY a.kind,a.slug`, [workspaceId, workflowSlug])).rows;
}

function frontmatter(data: Record<string, unknown>, content: string) { return `---\n${Object.entries(data).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}\n---\n\n${content.trim()}\n`; }
export function renderOpenCode(assets: Array<{ kind: AssetKind; slug: string; definition: any }>) {
  const config: Record<string, any> = { '$schema': 'https://opencode.ai/config.json' };
  const files: Record<string, string> = {};
  const mcp: Record<string, any> = {};
  for (const a of assets) {
    const d = a.definition;
    if (a.kind === 'mcp') {
      mcp[a.slug] = d.transport === 'local' ? { type: 'local', command: d.command, ...(d.cwd ? { cwd: d.cwd } : {}), ...(d.environment ? { environment: d.environment } : {}), ...(d.enabled === false ? { enabled: false } : {}), ...(d.timeout ? { timeout: d.timeout } : {}) } : { type: 'remote', url: d.url, ...(d.headers ? { headers: d.headers } : {}), ...(d.oauth === false ? { oauth: false } : d.oauth ? { oauth: d.oauth } : {}), ...(d.enabled === false ? { enabled: false } : {}), ...(d.timeout ? { timeout: d.timeout } : {}) };
    }
    if (a.kind === 'agent') files[`.opencode/agents/${a.slug}.md`] = frontmatter({ description: d.description ?? a.slug, mode: d.mode ?? 'all', model: d.model, temperature: d.temperature, steps: d.steps, permission: d.permission }, d.prompt);
    if (a.kind === 'skill') files[`.opencode/skills/${a.slug}/SKILL.md`] = frontmatter({ name: a.slug, description: d.description ?? a.slug, license: d.license, compatibility: 'opencode', metadata: d.metadata }, d.instructions);
    if (a.kind === 'command') files[`.opencode/commands/${a.slug}.md`] = frontmatter({ description: d.description ?? a.slug, agent: d.agent, model: d.model, subtask: d.subtask }, d.template);
  }
  if (Object.keys(mcp).length) config.mcp = mcp;
  files['opencode.jsonc'] = `${JSON.stringify(config, null, 2)}\n`;
  return files;
}

export function openCodeGuide(asset: { kind: AssetKind; slug: string; definition: any }) {
  if (asset.kind !== 'mcp') return { title: 'OpenCode export', steps: ['Export the asset package and copy it into your project root.', 'Restart OpenCode to discover the new definition.'] };
  const auth = asset.definition.transport === 'remote' && asset.definition.oauth ? [`Run \`opencode mcp auth ${asset.slug}\` to complete OAuth.`] : [];
  return { title: `Install ${asset.slug} in OpenCode`, steps: ['Copy the generated mcp entry into `opencode.jsonc` in the project root (or `~/.config/opencode/opencode.json` for all projects).', 'Set every required environment variable before starting OpenCode.', ...auth, `Verify it with \`opencode mcp list\`; diagnose connection problems with \`opencode mcp debug ${asset.slug}\`.`], note: 'Use `{env:VARIABLE_NAME}` for API keys and other secrets; Azhi Flow never exports secret values.' };
}
