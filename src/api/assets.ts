import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSET_KINDS, archiveAsset, attachAsset, createAsset, getAsset, listAssets, openCodeGuide, publishAsset, renderOpenCode, updateAsset, workflowAssets } from '../server/assets.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { requireRole } from './auth.js';
import type { AppContext } from '../server/context.js';

const definition = z.record(z.string(), z.unknown());
const body = z.object({ kind: z.enum(ASSET_KINDS), slug: z.string().min(1).max(64), name: z.string().min(1).max(120), description: z.string().max(2000).optional(), definition });
function user(req: FastifyRequest) { if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'this endpoint needs a user token'); return req.principal; }
export function registerAssetRoutes(app: FastifyInstance, ctx: AppContext) {
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
}
