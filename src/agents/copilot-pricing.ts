import type { AgentProfile } from './profile.js';

/**
 * GitHub Copilot is billed by premium requests, not tokens: each prompt a person (or Azhi) sends
 * counts as one request times the model's multiplier, and the tool calls the agent makes on its
 * own after that prompt count nothing. A paid plan includes a monthly allowance (Business 300,
 * Enterprise 1,000 per seat); past it, each premium request costs the overage price.
 *
 * Azhi cannot see a seat's remaining allowance, so the dollar figure is always an estimate: the
 * premium requests a step used, priced at the configured price per premium request (GitHub's
 * published overage rate unless set). Inside the allowance the real extra spend is zero.
 */

/** GitHub's published price for a premium request past the plan's allowance, in USD. */
export const COPILOT_OVERAGE_USD = 0.04;

/**
 * Multipliers for paid plans as GitHub published them (docs "Requests in GitHub Copilot",
 * late 2025). GitHub changes these; override with AZHI_COPILOT_MULTIPLIERS or the profile.
 * A model missing here is counted at 1 and marked as assumed.
 */
export const COPILOT_MULTIPLIERS: Record<string, number> = {
  'gpt-4.1': 0,
  'gpt-4o': 0,
  'gpt-5-mini': 0,
  'grok-code-fast-1': 0.25,
  'claude-haiku-4.5': 0.33,
  'claude-sonnet-4': 1,
  'claude-sonnet-4.5': 1,
  'gemini-2.5-pro': 1,
  'gpt-5': 1,
  'gpt-5-codex': 1,
  'claude-opus-4.1': 10,
};

export const COPILOT_PRICING_REVISION = 'copilot-premium-requests-2025-11';

/** `model=multiplier` pairs separated by commas or new lines, e.g. `claude-sonnet-5=1, claude-opus-5=3`. */
export function parseMultipliers(text: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (text ?? '').split(/[,\n]/)) {
    const m = /^\s*([^=\s]+)\s*=\s*([0-9]*\.?[0-9]+)\s*$/.exec(part);
    if (m) out[m[1]!.toLowerCase()] = Number(m[2]);
  }
  return out;
}

export interface CopilotPricing {
  currency: string;
  per_premium_request: number;
  multiplier: number;
  /** True when no table or setting names the model, so the multiplier 1 is a guess. */
  assumed: boolean;
  revision: string;
}

/**
 * How one Copilot step is priced. The profile's `pricing` wins when it gives `per_premium_request`
 * or `multiplier`; then the server settings; then GitHub's published defaults.
 */
export function copilotPricing(model: string, profile: AgentProfile['pricing'], s: { copilotPremiumRequestUsd: number; copilotMultipliers: Record<string, number> }): CopilotPricing {
  const key = model.toLowerCase().replace(/^github-copilot\//, '');
  const configured = s.copilotMultipliers[key] ?? COPILOT_MULTIPLIERS[key];
  const multiplier = profile?.multiplier ?? configured;
  return {
    currency: profile?.currency ?? 'USD',
    per_premium_request: profile?.per_premium_request ?? s.copilotPremiumRequestUsd,
    multiplier: multiplier ?? 1,
    assumed: multiplier === undefined,
    revision: profile?.revision ?? COPILOT_PRICING_REVISION,
  };
}

/** Premium requests and estimated cost for `requests` prompts sent to the model. */
export function copilotCost(requests: number, p: CopilotPricing): { premium_requests: number; cost: number } {
  const premium = round(requests * p.multiplier, 3);
  return { premium_requests: premium, cost: round(premium * p.per_premium_request, 6) };
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
