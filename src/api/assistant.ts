import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Message } from '../agents/providers.js';
import { assistantTurn, checkPage } from '../assistant/assistant.js';
import { handleMcp } from '../assistant/mcp.js';
import { checkCall, type AssistantDeps } from '../assistant/tools.js';
import { builderProviders } from '../builder/builder.js';
import { builderModels } from '../builder/models.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit } from '../server/catalog.js';

/**
 * The assistant (src/assistant): the chat bubble on every mission control page, the actions a
 * person confirms from it, and the same tools as an MCP server for outside agents. Every route
 * runs as the calling person, with their role; run tokens are refused.
 */
function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

const block = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.string(), is_error: z.boolean().optional() }),
]);
const chat = z.object({
  provider: z.enum(['anthropic', 'openai', 'opencode', 'chatgpt']).optional(),
  model: z.string().min(1).max(160).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.array(block) })),
  text: z.string().min(1).max(8_000),
  page: z.unknown().optional(),
});

export function registerAssistantRoutes(app: FastifyInstance, d: AssistantDeps) {
  const { ctx } = d;

  // Which model providers are set up, so the bubble can say what to do when none is.
  app.get('/v1/assistant', async (req) => builderProviders(ctx, user(req).workspaceId));

  // A provider's models for the assistant's picker; unlike the builder's, any role may chat, so any role may list them.
  app.get('/v1/assistant/models', async (req) => {
    const p = user(req);
    const q = z.object({ provider: z.enum(['anthropic', 'openai', 'opencode', 'chatgpt']), refresh: z.enum(['1', 'true']).optional() }).parse(req.query);
    return builderModels(ctx, p.workspaceId, q.provider, Boolean(q.refresh));
  });

  app.post('/v1/assistant/chat', async (req) => {
    const p = user(req);
    const b = chat.parse(req.body);
    if (b.messages.length > 200 || JSON.stringify(b.messages).length > 1_000_000) throw new AzhiError(ErrorClass.invalidInput, 'this conversation is too long; start a new one');
    const r = await assistantTurn(d, p, { messages: b.messages as Message[], text: b.text, page: checkPage(b.page), provider: b.provider, model: b.model });
    await audit(ctx, p.workspaceId, p.userId, 'assistant.turn', { provider: r.provider, model: r.model, event: r.event.kind, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens });
    return r;
  });

  // An action the assistant proposed, run once the person confirms it: the role and arguments are checked again here.
  app.post('/v1/assistant/actions', async (req) => {
    const p = user(req);
    const b = z.object({ tool: z.string().max(80), args: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
    const { tool, args } = checkCall(p, b.tool, b.args);
    if (tool.effect !== 'act') throw new AzhiError(ErrorClass.invalidInput, `${b.tool} is not an action`);
    const result = await tool.run(d, p, args);
    await audit(ctx, p.workspaceId, p.userId, 'assistant.action', { tool: tool.name, args });
    return { ok: true, result };
  });

  // MCP over Streamable HTTP, stateless: POST only; GET (server-sent stream) and DELETE (sessions) are not offered.
  app.post('/v1/assistant/mcp', async (req, reply) => {
    const p = user(req);
    reply.hijack();
    await handleMcp(d, p, req.raw, reply.raw, req.body);
  });
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/v1/assistant/mcp', handler: async (_req, reply) => reply.status(405).header('allow', 'POST').send({ error: 'method_not_allowed', message: 'this MCP server is stateless: POST only' }) });
  }
}
