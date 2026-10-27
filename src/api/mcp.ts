import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit, registerTool } from '../server/catalog.js';
import { beginMcpOAuth, createMcpConnection, discoverMcpTools, finishMcpOAuth, getMcpConnection, listMcpConnections } from '../server/mcp.js';
import type { AppContext } from '../server/context.js';
import { requireRole } from './auth.js';

const oauth = z.object({ authorization_url: z.string().url(), token_url: z.string().url(), client_id: z.string().min(1), client_secret: z.string().min(1).optional(), scopes: z.string().max(1000).optional() });
const connection = z.object({ name: z.string().min(1).max(120), url: z.string().url(), auth_kind: z.enum(['none', 'oauth']), oauth: oauth.optional() });

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = (req: any) => {
    if (req.principal?.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'this endpoint needs a user token');
    return req.principal;
  };
  app.get('/v1/mcp/connections', async (req) => {
    const p = user(req); requireRole(p, 'admin'); return listMcpConnections(ctx, p.workspaceId);
  });
  app.post('/v1/mcp/connections', async (req) => {
    const p = user(req); requireRole(p, 'admin'); return createMcpConnection(ctx, p.workspaceId, connection.parse(req.body), p.userId);
  });
  app.post('/v1/mcp/connections/:id/oauth/start', async (req) => {
    const p = user(req); requireRole(p, 'admin'); return beginMcpOAuth(ctx, p.workspaceId, (req.params as { id: string }).id, p.userId);
  });
  app.get('/v1/mcp/connections/:id/tools', async (req) => {
    const p = user(req); requireRole(p, 'admin'); return discoverMcpTools(ctx, p.workspaceId, (req.params as { id: string }).id);
  });
  app.post('/v1/mcp/connections/:id/tools', async (req) => {
    const p = user(req); requireRole(p, 'admin');
    const id = (req.params as { id: string }).id;
    await getMcpConnection(ctx, p.workspaceId, id);
    const b = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/), version: z.number().int().min(1), name: z.string().min(1), description: z.string().min(1), effect: z.enum(['read', 'write-idempotent', 'write-dedupable', 'write-unsafe']), input_schema: z.record(z.string(), z.unknown()), output_schema: z.record(z.string(), z.unknown()), source: z.string().optional(), output_trusted: z.boolean().optional(), safe_for_tainted: z.boolean().optional() }).parse(req.body);
    const r = await registerTool(ctx, p.workspaceId, { ...b, transport: { kind: 'mcp-streamable-http', connection: id, tool: b.name } }, p.userId);
    await audit(ctx, p.workspaceId, p.userId, 'mcp.tool_registered', { connection: id, tool: `${b.id}@${b.version}`, remote_tool: b.name });
    return { ref: `${b.id}@${b.version}`, ...r };
  });
  // OAuth providers redirect the browser here. State binds the callback to a connection; no API token is sent to the provider.
  app.get('/v1/mcp/oauth/callback', async (req, reply) => {
    const q = z.object({ state: z.string().min(1), code: z.string().min(1), error: z.string().optional(), error_description: z.string().optional() }).parse(req.query);
    if (q.error) throw new AzhiError(ErrorClass.authorization, `OAuth authorization failed: ${q.error_description ?? q.error}`);
    const c = await finishMcpOAuth(ctx, q.state, q.code);
    return reply.type('text/html').send(`<!doctype html><title>Azhi MCP connected</title><p>Connected <strong>${escapeHtml(c.name)}</strong>. You can close this window and return to Azhi Flow.</p>`);
  });
}
function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]!)); }
