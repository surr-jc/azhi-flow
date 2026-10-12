import type { ModelProviderName } from '../agents/profile.js';
import type { BuilderModels } from '../builder/models.js';
import type { AppContext } from './context.js';

export interface ProviderAvailability { enabled: boolean; allowed_model_ids?: string[] | null }
export type ModelAvailability = Partial<Record<ModelProviderName, ProviderAvailability>>;

export async function readModelAvailability(ctx: AppContext, workspaceId: string): Promise<ModelAvailability> {
  const value = (await ctx.pool.query(`SELECT settings->'model_availability' AS value FROM workspaces WHERE id=$1`, [workspaceId])).rows[0]?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ModelAvailability : {};
}

export function filterModels(models: BuilderModels, policy?: ProviderAvailability): BuilderModels {
  const allowed = policy?.allowed_model_ids;
  if (allowed == null) return { ...models, models: [...models.models] };
  const ids = new Set(allowed);
  const filtered = models.models.filter((model) => ids.has(model.id));
  const recommended = models.recommended && ids.has(models.recommended.id) ? models.recommended : undefined;
  return { ...models, models: filtered, recommended };
}

export async function updateModelAvailability(ctx: AppContext, workspaceId: string, provider: ModelProviderName, policy: ProviderAvailability): Promise<void> {
  // Merge both levels atomically so initial writes create the parent and concurrent providers survive.
  await ctx.pool.query(`UPDATE workspaces SET settings = jsonb_set(
    COALESCE(settings, '{}'::jsonb), '{model_availability}',
    COALESCE(settings->'model_availability', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb), true
  ) WHERE id=$1`, [workspaceId, provider, JSON.stringify(policy)]);
}
