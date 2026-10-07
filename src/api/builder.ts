import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Message } from '../agents/providers.js';
import { builderProviders, builderTurn, checkProposal, registerProposedTool } from '../builder/builder.js';
import { builderModels } from '../builder/models.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { uploadPackage } from '../server/workflows.js';
import { requireRole } from './auth.js';

/**
 * The workflow builder chat in mission control (src/builder/builder.ts). Authors chat with the
 * workspace's model provider; a compiling proposal is saved through the normal package upload as
 * an unsigned draft, so publishing still needs a signature.
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
  provider: z.enum(['anthropic', 'openai', 'opencode']).optional(),
  model: z.string().min(1).max(160).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.array(block) })).max(400),
  text: z.string().min(1).max(20_000),
});

export function registerBuilderRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/builder', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    return builderProviders(ctx, p.workspaceId);
  });

  // The provider's models (its live list, or a built-in one) with the one recommended for building workflows.
  app.get('/v1/builder/models', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const q = z.object({ provider: z.enum(['anthropic', 'openai', 'opencode']), refresh: z.enum(['1', 'true']).optional() }).parse(req.query);
    return builderModels(ctx, p.workspaceId, q.provider, Boolean(q.refresh));
  });

  app.post('/v1/builder/chat', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const b = chat.parse(req.body);
    if (JSON.stringify(b.messages).length > 2_000_000) throw new AzhiError(ErrorClass.invalidInput, 'this conversation is too long; start a new one');
    const r = await builderTurn(ctx, p.workspaceId, { messages: b.messages as Message[], text: b.text, provider: b.provider, model: b.model });
    await audit(ctx, p.workspaceId, p.userId, 'builder.turn', { provider: r.provider, model: r.model, event: r.event.kind, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens });
    return r;
  });

  // Registers a tool the builder proposed, once an admin confirms it; checked again as at proposal time.
  app.post('/v1/builder/register-tool', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ tool: z.record(z.string(), z.unknown()) }).parse(req.body);
    const r = await registerProposedTool(ctx, p.workspaceId, b.tool, p.userId);
    await audit(ctx, p.workspaceId, p.userId, 'builder.tool-registered', { tool: r.ref, revision: r.revision, changed: r.changed });
    return r;
  });

  // Saves a proposal as a new unsigned draft version, checked again exactly as at proposal time.
  app.post('/v1/builder/save', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const b = z.object({ files: z.record(z.string(), z.string()), new_version_of: z.string().optional() }).parse(req.body);
    const checked = await checkProposal(ctx, p.workspaceId, b.files, b.new_version_of);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    const files = Object.fromEntries(Object.entries(checked.files).map(([k, t]) => [k, Buffer.from(t).toString('base64')]));
    const r = await uploadPackage(ctx, p.workspaceId, { workflow: 'workflow.yaml', files }, p.userId);
    if (!r.ok) return { ok: false, errors: r.diagnostics.map((d) => d.message) };
    const v = r.version;
    await audit(ctx, p.workspaceId, p.userId, 'builder.saved', { workflow: v.slug, version_id: v.id });
    return { ok: true, version: { id: v.id, workflow: v.slug, version: v.version, draft: v.draft, signed: Boolean(v.signature) } };
  });
}
