import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSET_KINDS, archiveAsset, attachAsset, createAsset, getAsset, harnessGuides, listAssets, openCodeGuide, publishAsset, renderClaudeCode, renderOpenCode, updateAsset, workflowAssets } from '../server/assets.js';
import { BUILTIN_SOURCES, defaultDeps, importItem, marketConfig, resolve, saveMarketConfig, search, sourcesFor, type MarketDeps } from '../server/marketplace.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { requireRole } from './auth.js';
import type { AppContext } from '../server/context.js';

const definition = z.record(z.string(), z.unknown());
const body = z.object({ kind: z.enum(ASSET_KINDS), slug: z.string().min(1).max(64), name: z.string().min(1).max(120), description: z.string().max(2000).optional(), definition });
function user(req: FastifyRequest) { if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'this endpoint needs a user token'); return req.principal; }
export function registerAssetRoutes(app: FastifyInstance, ctx: AppContext, deps: MarketDeps = defaultDeps()) {
  app.get('/v1/assets', async (req) => { const p = user(req); const kind = z.object({ kind: z.enum(ASSET_KINDS).optional() }).parse(req.query).kind; return listAssets(ctx, p.workspaceId, kind); });
  app.get('/v1/assets/:id', async (req) => { const p = user(req); const a = await getAsset(ctx, p.workspaceId, (req.params as { id: string }).id); if (!a) throw new AzhiError(ErrorClass.invalidInput, 'portable asset not found'); return a; });
  app.post('/v1/assets', async (req) => { const p = user(req); requireRole(p, 'author'); return createAsset(ctx, p.workspaceId, body.parse(req.body), p.userId); });
  app.put('/v1/assets/:id', async (req) => { const p = user(req); requireRole(p, 'author'); const b = body.omit({ kind: true, slug: true }).parse(req.body); return updateAsset(ctx, p.workspaceId, (req.params as { id: string }).id, b, p.userId); });
  app.post('/v1/assets/:id/publish', async (req) => { const p = user(req); requireRole(p, 'author'); return publishAsset(ctx, p.workspaceId, (req.params as { id: string }).id, p.userId); });
  app.post('/v1/assets/:id/archive', async (req) => { const p = user(req); requireRole(p, 'author'); await archiveAsset(ctx, p.workspaceId, (req.params as { id: string }).id, p.userId); return { ok: true }; });
  app.get('/v1/assets/:id/opencode-guide', async (req) => { const p = user(req); const a = await getAsset(ctx, p.workspaceId, (req.params as { id: string }).id); if (!a) throw new AzhiError(ErrorClass.invalidInput, 'portable asset not found'); const v = a.versions.find((x: any) => x.version === a.current_version); return openCodeGuide({ kind: a.kind, slug: a.slug, definition: v.definition }); });
  app.post('/v1/workflows/:slug/assets', async (req) => { const p = user(req); requireRole(p, 'author'); const b = z.object({ asset_id: z.string(), version: z.number().int().positive().optional() }).parse(req.body); await attachAsset(ctx, p.workspaceId, (req.params as { slug: string }).slug, b.asset_id, b.version, p.userId); return { ok: true }; });
  app.get('/v1/workflows/:slug/assets', async (req) => workflowAssets(ctx, user(req).workspaceId, (req.params as { slug: string }).slug));
  app.get('/v1/workflows/:slug/opencode-export', async (req) => { const p = user(req); const assets = await workflowAssets(ctx, p.workspaceId, (req.params as { slug: string }).slug); return { provider: 'opencode', files: renderOpenCode(assets) }; });

  app.get('/v1/workflows/:slug/claude-export', async (req) => { const p = user(req); const assets = await workflowAssets(ctx, p.workspaceId, (req.params as { slug: string }).slug); return { provider: 'claude-code', files: renderClaudeCode(assets) }; });
  app.get('/v1/assets/:id/harness-guides', async (req) => { const p = user(req); const a = await getAsset(ctx, p.workspaceId, (req.params as { id: string }).id); if (!a) throw new AzhiError(ErrorClass.invalidInput, 'portable asset not found'); const v = a.versions.find((x: any) => x.version === a.current_version); return harnessGuides({ kind: a.kind, slug: a.slug, definition: v.definition }); });

  // Live marketplaces: the official MCP Registry and GitHub plugin marketplaces.
  const kindQuery = z.object({ kind: z.enum(ASSET_KINDS), q: z.string().max(200).default(''), source: z.string().max(200).optional(), cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(60).optional() });
  app.get('/v1/marketplace/config', async (req) => { const p = user(req); const cfg = await marketConfig(ctx, p.workspaceId); return { ...cfg, builtin_sources: BUILTIN_SOURCES.map((s) => s.id), sources_all: sourcesFor(cfg), github_token_set: Boolean(deps.githubToken) }; });
  app.put('/v1/marketplace/config', async (req) => {
    const p = user(req); requireRole(p, 'admin');
    const b = z.object({ enabled: z.boolean(), sources: z.array(z.object({ repo: z.string().max(200), ref: z.string().max(100).default('main') })).max(20) }).parse(req.body);
    return saveMarketConfig(ctx, p.workspaceId, p.userId, b);
  });
  app.get('/v1/marketplace/search', async (req) => {
    const p = user(req); const q = kindQuery.parse(req.query);
    const cfg = await marketConfig(ctx, p.workspaceId);
    if (!cfg.enabled) return { items: [], warnings: [{ source: 'marketplace', message: 'The marketplace is turned off for this workspace.' }], sources: [], disabled: true };
    return search(deps, sourcesFor(cfg), { kind: q.kind, q: q.q, ...(q.source ? { source: q.source } : {}), ...(q.cursor ? { cursor: q.cursor } : {}), ...(q.limit ? { limit: q.limit } : {}) });
  });
  app.get('/v1/marketplace/item', async (req) => {
    const p = user(req); const id = z.object({ id: z.string().min(3).max(600) }).parse(req.query).id;
    const cfg = await marketConfig(ctx, p.workspaceId);
    if (!cfg.enabled) throw new AzhiError(ErrorClass.invalidInput, 'the marketplace is turned off for this workspace');
    const r = await resolve(deps, sourcesFor(cfg), id);
    return { ...r, guides: harnessGuides({ kind: r.item.kind, slug: r.item.slug, definition: r.definition }) };
  });
  app.post('/v1/marketplace/import', async (req) => {
    const p = user(req); requireRole(p, 'author');
    const b = z.object({ id: z.string().min(3).max(600), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(), name: z.string().min(1).max(120).optional() }).parse(req.body);
    return importItem(ctx, deps, p.workspaceId, p.userId, b.id, { ...(b.slug ? { slug: b.slug } : {}), ...(b.name ? { name: b.name } : {}) });
  });
}
