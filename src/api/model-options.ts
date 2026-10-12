import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROVIDER_DEFAULTS } from '../agents/providers.js';
import { MODEL_PROVIDERS, type ModelProviderName } from '../agents/profile.js';
import { builderModels, type ModelProviderId } from '../builder/models.js';
import { builderProviders } from '../builder/builder.js';
import { EXECUTORS } from '../executors/capabilities.js';
import type { AppContext } from '../server/context.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit } from '../server/catalog.js';
import { filterModels, readModelAvailability, updateModelAvailability } from '../server/model-availability.js';
import { requireRole } from './auth.js';

/** A model provider as agent profiles name it, and as the builder's model lists name it. */
const BUILDER_ID: Record<ModelProviderName, ModelProviderId> = { anthropic: 'anthropic', openai: 'openai', 'github-copilot': 'opencode', 'openai-chatgpt': 'chatgpt' };
const LABEL: Record<ModelProviderName, string> = { anthropic: 'Anthropic', openai: 'OpenAI', 'github-copilot': 'GitHub Copilot (OpenCode)', 'openai-chatgpt': 'ChatGPT plan (OpenCode)' };

/**
 * What a person can choose as the provider and model for a workflow or a run: every provider a profile
 * may name, whether its credential is set in this workspace, the model a `name: default` step gets from
 * the server today, and which executors can drive it (the built-in model agent drives Anthropic and
 * OpenAI; OpenCode also drives Copilot and ChatGPT plan models).
 */
export function registerModelOptionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/model-options', async (req) => {
    const p = req.principal;
    if (p.kind !== 'user') return { providers: [] };
    requireRole(p, 'viewer');
    const availability = await readModelAvailability(ctx, p.workspaceId);
    const known = await builderProviders(ctx, p.workspaceId);
    return {
      providers: MODEL_PROVIDERS.map((id) => {
        const info = known.providers.find((x) => x.id === BUILDER_ID[id]);
        const d = PROVIDER_DEFAULTS[id];
        return {
          id,
          enabled: availability[id]?.enabled !== false,
          label: LABEL[id],
          ready: Boolean(info?.ready),
          ...(info?.ready ? {} : { reason: info?.reason ?? `the workspace secret ${d.credential} is not set` }),
          credential: d.credential,
          /** What a step that says `name: default` runs on today when no provider is chosen. */
          server_default_model: d.model(ctx.settings) ?? null,
          server_default_env: d.modelEnv,
          executors: ['model-agent', ...Object.keys(EXECUTORS).filter((e) => e !== 'model-agent')].filter((e) => (EXECUTORS[e]?.providers as string[] | undefined)?.includes(id)),
        };
      }),
    };
  });

  app.get('/v1/settings/model-availability', async (req) => {
    const p = req.principal;
    if (p.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'this endpoint needs a user token');
    requireRole(p, 'viewer');
    return { providers: await readModelAvailability(ctx, p.workspaceId) };
  });

  app.put('/v1/settings/model-availability/:provider', async (req) => {
    const p = req.principal;
    if (p.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'this endpoint needs a user token');
    requireRole(p, 'admin');
    const { provider } = z.object({ provider: z.enum(MODEL_PROVIDERS) }).parse(req.params);
    const body = z.object({ enabled: z.boolean(), allowed_model_ids: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/)).nullable() }).strict().parse(req.body);
    const policy = { enabled: body.enabled, allowed_model_ids: body.allowed_model_ids === null ? null : [...new Set(body.allowed_model_ids)] };
    await updateModelAvailability(ctx, p.workspaceId, provider, policy);
    await audit(ctx, p.workspaceId, p.userId, 'settings.model_availability_changed', { provider, ...policy });
    return { provider, ...policy };
  });

  app.get('/v1/model-options/models', async (req) => {
    const p = req.principal;
    if (p.kind !== 'user') return { provider: '', models: [], source: 'built-in' };
    requireRole(p, 'viewer');
    const q = z.object({ provider: z.enum(MODEL_PROVIDERS), refresh: z.enum(['1', 'true']).optional() }).parse(req.query);
    const policy = (await readModelAvailability(ctx, p.workspaceId))[q.provider];
    if (policy?.enabled === false) throw new AzhiError(ErrorClass.invalidInput, `provider ${q.provider} is disabled for this workspace`);
    const models = await builderModels(ctx, p.workspaceId, BUILDER_ID[q.provider], Boolean(q.refresh));
    return { ...filterModels(models, policy), allowed_model_ids: policy?.allowed_model_ids ?? null };
  });
}
