import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import type { AppContext } from '../server/context.js';
import { handleDelivery, HOOK_PATH, listDeliveries, listTriggers, setTriggerEnabled } from '../server/triggers.js';
import { requireRole } from './auth.js';

/**
 * Event triggers (docs/triggers.md). `POST /v1/hooks/:id` is the only unauthenticated route that starts work: the
 * HMAC signature of the raw body is its authentication, checked against the workspace secret the trigger names.
 * The rest is for mission control and the CLI, as the person who asks.
 */
export const isHookPath = (url: string) => url.startsWith(HOOK_PATH);

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

export function registerTriggerRoutes(app: FastifyInstance, ctx: AppContext, interpreterBuild: string) {
  // The signature covers the raw body, so this route reads it unparsed.
  app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    sub.post(`${HOOK_PATH}:id`, async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const r = await handleDelivery(ctx, (req.params as { id: string }).id, req.headers, raw, interpreterBuild);
      return reply.status(r.status).send(r.body);
    });
  });

  app.get('/v1/triggers', async (req) => {
    const p = user(req);
    const base = ctx.settings.publicUrl.replace(/\/$/, '');
    return (await listTriggers(ctx, p.workspaceId)).map((t) => ({ ...t, url: `${base}${HOOK_PATH}${t.id}` }));
  });

  app.get('/v1/triggers/:id/deliveries', async (req) => {
    const p = user(req);
    return listDeliveries(ctx, p.workspaceId, (req.params as { id: string }).id);
  });

  app.patch('/v1/triggers/:id', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ enabled: z.boolean() }).parse(req.body);
    const id = (req.params as { id: string }).id;
    if (!(await setTriggerEnabled(ctx, p.workspaceId, id, b.enabled, p.userId))) throw new AzhiError(ErrorClass.invalidInput, 'trigger not found');
    return { id, enabled: b.enabled };
  });
}
