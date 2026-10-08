import type { AgentProfile } from './profile.js';

/**
 * GitHub Copilot usage-based billing (since June 1, 2026): chat and agent use is metered in GitHub
 * AI Credits, 1 credit = USD 0.01. A request costs its input, cached-input, cache-write and output
 * tokens at the model's published per-million-token rate (docs.github.com "Models and pricing for
 * GitHub Copilot"). Business and Enterprise plans include a monthly credit pool for the whole
 * organization (Enterprise: 3,900 per seat); it resets on the 1st at 00:00 UTC. Past the pool,
 * usage is charged at the same rates when additional usage is allowed, or blocked when it is not.
 *
 * Azhi sees only its own runs, not the IDE and chat use drawing on the same pool, so "pool left"
 * and "past the pool" are as far as Azhi's own usage this month can tell.
 */

/** USD per AI Credit. */
export const COPILOT_CREDIT_USD = 0.01;

/** USD per million tokens. Cache rates absent means cached tokens are billed at the input rate. */
export interface CopilotRate {
  input: number;
  cached?: number;
  cache_write?: number;
  output: number;
}

/**
 * Fallback per-model rates: GitHub's published usage-based rates as carried in OpenCode 1.18.34's
 * model catalog for its github-copilot provider (`opencode models github-copilot --verbose`), which
 * agree with the rates on docs.github.com "Models and pricing for GitHub Copilot" where checked.
 * A Copilot step normally uses the cost OpenCode itself reports from its current catalog (see
 * harnessCost); this table is for steps where OpenCode reports none. Override with AZHI_COPILOT_RATES.
 * No `cache_write` means cache writes are billed at the input rate.
 */
export const COPILOT_RATES: Record<string, CopilotRate> = {
  'claude-fable-5': { input: 10, cached: 1, cache_write: 12.5, output: 50 },
  'claude-fable-5.1': { input: 10, cached: 0.25, cache_write: 12.5, output: 50 },
  'claude-haiku-4.5': { input: 1, cached: 0.1, cache_write: 1.25, output: 5 },
  'claude-opus-4.7': { input: 5, cached: 0.5, cache_write: 6.25, output: 25 },
  'claude-opus-4.7-fast': { input: 30, cached: 3, cache_write: 37.5, output: 150 },
  'claude-opus-4.8': { input: 5, cached: 0.5, cache_write: 6.25, output: 25 },
  'claude-opus-4.8-fast': { input: 10, cached: 1, cache_write: 12.5, output: 50 },
  'claude-opus-5': { input: 5, cached: 0.5, cache_write: 6.25, output: 25 },
  'claude-opus-5.5': { input: 4, cached: 0.2, cache_write: 5, output: 20 },
  'claude-sonnet-4.6': { input: 3, cached: 0.3, cache_write: 3.75, output: 15 },
  'claude-sonnet-5': { input: 2, cached: 0.2, cache_write: 2.5, output: 10 },
  'claude-sonnet-5.5': { input: 2, cached: 0.2, cache_write: 2.5, output: 10 },
  'gemini-3.5-flash': { input: 1.5, cached: 0.15, output: 9 },
  'gemini-3.6-flash': { input: 0.75, cached: 0.075, output: 3.75 },
  'gemini-3.7-flash': { input: 0.75, cached: 0.075, output: 3.75 },
  'gemini-3.8-flash': { input: 0.75, cached: 0.075, output: 3.75 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5.3-codex': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, cache_write: 0.25, output: 1.2 },
  'gpt-5.6-sol': { input: 4, cached: 0.4, cache_write: 5, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, cache_write: 2.5, output: 12 },
  'gpt-6-astra': { input: 10, cached: 1, cache_write: 12.5, output: 50 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, cache_write: 0.125, output: 0.5 },
  'gpt-6-sol': { input: 2, cached: 0.2, cache_write: 2.5, output: 10 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, cache_write: 2.5, output: 10 },
  'grok-4.5': { input: 2, cached: 0.5, output: 6 },
  'grok-4.6': { input: 2, cached: 0.5, output: 6 },
  'grok-4.7': { input: 2, cached: 0.5, output: 6 },
  'kimi-k2.7-code': { input: 0.95, cached: 0.19, output: 4 },
  'kimi-k3': { input: 3, cached: 0.3, output: 15 },
  'mai-code-1-flash-picker': { input: 0.75, cached: 0.075, output: 4.5 },
  'mai-code-1.1-flash': { input: 0.2, cached: 0.02, output: 1.2 },
  // Older models no longer in OpenCode's catalog.
  'claude-sonnet-4': { input: 3, cached: 0.3, cache_write: 3.75, output: 15 },
  'claude-sonnet-4.5': { input: 3, cached: 0.3, cache_write: 3.75, output: 15 },
  'claude-opus-4.5': { input: 5, cached: 0.5, cache_write: 6.25, output: 25 },
  'claude-opus-4.6': { input: 5, cached: 0.5, cache_write: 6.25, output: 25 },
};

export const COPILOT_PRICING_REVISION = 'copilot-ai-credits-2026-06';

/**
 * Per-model rates in USD per million tokens, separated by commas or new lines:
 * `model=input/output`, `model=input/cached/output` or `model=input/cached/cache_write/output`;
 * an empty field is billed at the input rate, e.g. `gpt-5.5=5/0.5/30, claude-sonnet-5=2/0.2/2.5/10`.
 */
export function parseRates(text: string | undefined): Record<string, CopilotRate> {
  const out: Record<string, CopilotRate> = {};
  const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? undefined : Number(s));
  for (const part of (text ?? '').split(/[,\n]/)) {
    const m = /^\s*([^=\s]+)\s*=\s*([^=]+?)\s*$/.exec(part);
    if (!m) continue;
    const f = m[2]!.split('/').map((x) => x.trim());
    const [input, cached, cacheWrite, output] =
      f.length === 2 ? [num(f[0]), undefined, undefined, num(f[1])] : f.length === 3 ? [num(f[0]), num(f[1]), undefined, num(f[2])] : f.length === 4 ? f.map(num) : [];
    if (![input, output, cached ?? 0, cacheWrite ?? 0].every((n) => n !== undefined && Number.isFinite(n) && n >= 0)) continue;
    out[m[1]!.toLowerCase()] = { input: input!, output: output!, ...(cached !== undefined ? { cached } : {}), ...(cacheWrite !== undefined ? { cache_write: cacheWrite } : {}) };
  }
  return out;
}

export interface CopilotSettings {
  copilotCreditUsd: number;
  copilotRates: Record<string, CopilotRate>;
  /** The organization's monthly credit pool, if set (AZHI_COPILOT_CREDIT_POOL). */
  copilotCreditPool?: number;
}

/** A rate someone set for the model: the profile's token prices, then AZHI_COPILOT_RATES. */
export function configuredCopilotRate(model: string, profile: AgentProfile['pricing'], s: CopilotSettings): CopilotRate | undefined {
  if (profile?.input_per_mtok !== undefined && profile.output_per_mtok !== undefined) {
    return { input: profile.input_per_mtok, output: profile.output_per_mtok, ...(profile.cache_read_per_mtok !== undefined ? { cached: profile.cache_read_per_mtok } : {}), ...(profile.cache_write_per_mtok !== undefined ? { cache_write: profile.cache_write_per_mtok } : {}) };
  }
  return lookup(s.copilotRates, model);
}

/** The rate for a model: one someone set, then the built-in table. */
export function copilotRate(model: string, profile: AgentProfile['pricing'], s: CopilotSettings): CopilotRate | undefined {
  return configuredCopilotRate(model, profile, s) ?? lookup(COPILOT_RATES, model);
}

/** Model names compared loosely: case, a provider prefix, and `.`/`_`/space against `-` (gpt-5.6-luna = GPT 5.6 Luna = gpt-5-6-luna). */
const norm = (m: string) => m.toLowerCase().replace(/^github-copilot\//, '').trim().replace(/[.\s_]+/g, '-');

/** The model's rate, or the rate of the longest name it extends with a suffix (a dated or preview build, e.g. gpt-5.6-luna-2026-09-01). */
function lookup(table: Record<string, CopilotRate>, model: string): CopilotRate | undefined {
  const m = norm(model);
  let best: [string, CopilotRate] | undefined;
  for (const [k, r] of Object.entries(table)) {
    const n = norm(k);
    if (n === m) return r;
    // Only a date or preview suffix counts: claude-sonnet-4-7 is a different model from claude-sonnet-4.
    if (m.startsWith(`${n}-`) && /^(\d{4}|preview|latest|exp)/.test(m.slice(n.length + 1)) && (!best || n.length > best[0].length)) best = [n, r];
  }
  return best?.[1];
}

export interface Tokens {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

/** AI Credits for one step's tokens (input excludes cached tokens, as OpenCode reports them), and their USD value. */
export function copilotCredits(t: Tokens, r: CopilotRate, creditUsd: number): { credits: number; cost: number } | null {
  if (t.input_tokens === null || t.output_tokens === null) return null;
  const usd =
    (t.input_tokens * r.input + t.output_tokens * r.output + (t.cache_read_tokens ?? 0) * (r.cached ?? r.input) + (t.cache_write_tokens ?? 0) * (r.cache_write ?? r.input)) / 1_000_000;
  return { credits: round(usd / COPILOT_CREDIT_USD, 3), cost: round((usd / COPILOT_CREDIT_USD) * creditUsd, 6) };
}

/**
 * How much of `run` credits falls past the monthly pool, given `before` credits Azhi already used
 * this month. Null without a pool size.
 */
export function poolPosition(pool: number | undefined, before: number, run: number) {
  if (pool === undefined) return null;
  const over = (n: number) => Math.max(0, n - pool);
  return { monthly: pool, used_before: round(before, 3), left_after: round(Math.max(0, pool - before - run), 3), past_pool: round(over(before + run) - over(before), 3) };
}

export const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
