import { lookup, parseRates, round, type CopilotRate, type Tokens } from './copilot-pricing.js';
import type { AgentProfile } from './profile.js';

/**
 * OpenAI API token pricing, for every step that runs an OpenAI model: the built-in model agent, and
 * OpenCode / Codex steps with `provider: openai`. Cost is tokens at a per-million-token rate, in USD.
 *
 * Which price is used, highest first (the same order for every workflow):
 *   1. the profile's own `pricing` (input and output prices both set),
 *   2. AZHI_OPENAI_RATES on the server,
 *   3. the cost OpenCode reports from its model catalog (OpenCode steps only),
 *   4. the built-in table below.
 * A model with none of these is left "unavailable", never guessed.
 */

/**
 * Standard-tier rates (not batch, flex or priority) for the models whose price is settled. Only
 * models confirmed by more than one source are listed, and they agree with the rates OpenCode's
 * catalog carries for the same models (see COPILOT_RATES). A newer model is added by setting
 * AZHI_OPENAI_RATES or the profile's pricing; check platform.openai.com/docs/pricing first.
 * No `cached` means cached tokens are billed at the input rate.
 */
export const OPENAI_RATES: Record<string, CopilotRate> = {
  'gpt-5.3-codex': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
};

export const OPENAI_PRICING_REVISION = 'openai-standard-2026-06';

export interface OpenAiSettings {
  openaiRates: Record<string, CopilotRate>;
}

/** The rate for a model, and where it came from. */
export function openaiRate(model: string, profile: AgentProfile['pricing'], s: Pick<OpenAiSettings, 'openaiRates'>): { rate: CopilotRate; source: 'profile' | 'configured' | 'builtin' } | undefined {
  if (profile?.input_per_mtok !== undefined && profile.output_per_mtok !== undefined) {
    return {
      source: 'profile',
      rate: { input: profile.input_per_mtok, output: profile.output_per_mtok, ...(profile.cache_read_per_mtok !== undefined ? { cached: profile.cache_read_per_mtok } : {}), ...(profile.cache_write_per_mtok !== undefined ? { cache_write: profile.cache_write_per_mtok } : {}) },
    };
  }
  const configured = lookup(s.openaiRates, model);
  if (configured) return { rate: configured, source: 'configured' };
  const builtin = lookup(OPENAI_RATES, model);
  return builtin && { rate: builtin, source: 'builtin' };
}

/** USD for one step's tokens (input excludes cached tokens, as the usage records keep them). */
export function openaiCost(t: Tokens, r: CopilotRate): number | null {
  if (t.input_tokens === null || t.output_tokens === null) return null;
  const usd = (t.input_tokens * r.input + t.output_tokens * r.output + (t.cache_read_tokens ?? 0) * (r.cached ?? r.input) + (t.cache_write_tokens ?? 0) * (r.cache_write ?? r.input)) / 1_000_000;
  return round(usd, 6);
}

export { parseRates };
