import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit, registerTool } from '../server/catalog.js';
import { beginMcpOAuth, createMcpConnection, discoverMcpTools, failMcpOAuth, finishMcpOAuth, getMcpConnection, listMcpConnections, publicConnection } from '../server/mcp.js';
import type { AppContext } from '../server/context.js';
import { requireRole } from './auth.js';

// With no fields at all the server's published metadata and dynamic registration supply everything; any field given overrides it.
const oauth = z.object({ authorization_url: z.string().url().optional(), token_url: z.string().url().optional(), client_id: z.string().min(1).optional(), client_secret: z.string().min(1).optional(), scopes: z.string().max(1000).optional() });
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
    const p = user(req); requireRole(p, 'admin');
    const created = await createMcpConnection(ctx, p.workspaceId, connection.parse(req.body), p.userId);
    // Sign-in starts at once: the caller gets the authorization URL and then waits for the connection to become ready.
    if (created.auth_kind !== 'oauth') return created;
    const { authorization_url } = await beginMcpOAuth(ctx, p.workspaceId, created.id, p.userId);
    return { ...publicConnection(await getMcpConnection(ctx, p.workspaceId, created.id)), authorization_url };
  });
  app.get('/v1/mcp/connections/:id', async (req) => {
    const p = user(req); requireRole(p, 'admin'); return publicConnection(await getMcpConnection(ctx, p.workspaceId, (req.params as { id: string }).id));
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
    // input_schema is optional: it comes from the server's own tool listing when omitted.
    const one = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/), version: z.number().int().min(1), name: z.string().min(1), description: z.string().min(1), effect: z.enum(['read', 'write-idempotent', 'write-dedupable', 'write-unsafe']), input_schema: z.record(z.string(), z.unknown()).optional(), output_schema: z.record(z.string(), z.unknown()), source: z.string().optional(), output_trusted: z.boolean().optional(), safe_for_tainted: z.boolean().optional() });
    const body = z.union([one, z.object({ tools: z.array(one).min(1).max(50) })]).parse(req.body);
    const batch = 'tools' in body;
    let remote: Awaited<ReturnType<typeof discoverMcpTools>> | undefined;
    const results = [];
    for (const b of batch ? body.tools : [body]) {
      let input_schema = b.input_schema;
      if (!input_schema) {
        remote ??= await discoverMcpTools(ctx, p.workspaceId, id);
        const found = remote.find((t) => t.name === b.name);
        if (!found) throw new AzhiError(ErrorClass.invalidInput, `the server does not list a tool named '${b.name}'`);
        input_schema = found.input_schema;
      }
      const r = await registerTool(ctx, p.workspaceId, { ...b, input_schema: input_schema as Record<string, never>, transport: { kind: 'mcp-streamable-http', connection: id, tool: b.name } }, p.userId);
      await audit(ctx, p.workspaceId, p.userId, 'mcp.tool_registered', { connection: id, tool: `${b.id}@${b.version}`, remote_tool: b.name });
      results.push({ ref: `${b.id}@${b.version}`, ...r });
    }
    return batch ? { tools: results } : results[0];
  });
  // OAuth providers redirect the browser here. State binds the callback to a connection; no API token is sent to the provider.
  app.get('/v1/mcp/oauth/callback', async (req, reply) => {
    const q = z.object({ state: z.string().min(1).optional(), code: z.string().min(1).optional(), error: z.string().max(200).optional(), error_description: z.string().max(500).optional() }).safeParse(req.query);
    const page = (status: number, title: string, body: string, script = '') => reply.code(status).type('text/html').headers({ 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).send(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>${body}${script}`);
    const back = '<p><a href="/ui/tools">Back to Azhi Flow</a></p>';
    if (!q.success || !q.data.state) return page(400, 'Azhi MCP sign-in failed', `<p>This sign-in link is not valid.</p>${back}`);
    const { state, code, error, error_description } = q.data;
    if (error || !code) {
      const message = error_description ?? error ?? 'the provider did not return a code';
      await failMcpOAuth(ctx, state, message);
      return page(400, 'Azhi MCP sign-in failed', `<p>Sign-in failed: ${escapeHtml(message)}</p>${back}`);
    }
    try {
      const c = await finishMcpOAuth(ctx, state, code);
      // Tell the window that opened this popup, then close it; the link covers the case where there is no opener.
      const note = JSON.stringify({ type: 'azhi-mcp-connected', id: c.id }).replace(/</g, '\u003c');
      return page(200, 'Azhi MCP connected', `<p>Connected <strong>${escapeHtml(c.name)}</strong>. You can close this window and return to Azhi Flow.</p>${back}`, `<script>try{window.opener&&window.opener.postMessage(${note},location.origin);window.close()}catch(e){}</script>`);
    } catch (err) {
      return page(400, 'Azhi MCP sign-in failed', `<p>Sign-in failed: ${escapeHtml((err as Error).message)}</p>${back}`);
    }
  });
}
function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]!)); }
