import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { exportBundle, importBundle } from '../server/bundle.js';
import type { AppContext } from '../server/context.js';
import { requireRole } from './auth.js';

/**
 * Export a workflow with everything it uses as one zip, and import such a zip into any workspace
 * (see src/server/bundle.ts). Importing registers tools, so it needs the admin role.
 */
export function registerBundleRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addContentTypeParser(['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/v1/workflows/:slug/export', async (req, reply) => {
    const p = req.principal;
    if (p.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'this endpoint needs a user token');
    requireRole(p, 'author');
    const slug = (req.params as { slug: string }).slug;
    const { zip, version } = await exportBundle(ctx, p.workspaceId, slug, { userId: p.userId, role: p.role });
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${slug.replace(/[^\w.-]/g, '_')}-v${version}.azhi.zip"`)
      .send(zip);
  });

  app.post('/v1/workflows/import', async (req) => {
    const p = req.principal;
    if (p.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'this endpoint needs a user token');
    requireRole(p, 'admin');
    const q = z.object({ mode: z.enum(['add', 'override']).default('add'), dry_run: z.enum(['true', 'false', '1', '0']).default('false') }).parse(req.query);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AzhiError(ErrorClass.invalidInput, 'send the bundle zip as the request body (content-type application/zip)');
    return importBundle(ctx, p.workspaceId, req.body, { mode: q.mode, dryRun: q.dry_run === 'true' || q.dry_run === '1', actor: p.userId });
  });
}
