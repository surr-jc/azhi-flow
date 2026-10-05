import { describe, expect, it } from 'vitest';
import { COPILOT_OVERAGE_USD, copilotCost, copilotPricing, parseMultipliers } from '../src/agents/copilot-pricing.js';
import type { AgentProfile } from '../src/agents/profile.js';
import { settings } from '../src/config/settings.js';
import { harnessCost } from '../src/runtime/gateway-activities.js';
import { summariseUsage } from '../src/server/runs.js';

/** Copilot is billed by premium requests (prompts x model multiplier), not tokens; these use made-up models. */
const S = { copilotPremiumRequestUsd: COPILOT_OVERAGE_USD, copilotMultipliers: parseMultipliers('dummy-cheap=0.33, Dummy-Big=10\ndummy-free=0') };
const usage = { input_tokens: 50_000, output_tokens: 1_200, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 };
const copilot = (pricing?: AgentProfile['pricing']): AgentProfile => ({ model: { provider: 'github-copilot', name: 'default' }, instructions: 'x', ...(pricing ? { pricing } : {}) });

describe('GitHub Copilot premium request pricing', () => {
  it('reads multipliers from settings text, ignoring malformed pairs', () => {
    expect(parseMultipliers('a=1, b = 0.25\nc=x, =3, d')).toEqual({ a: 1, b: 0.25 });
    expect(parseMultipliers(undefined)).toEqual({});
  });

  it('prices a model by settings, then GitHub\'s table, then an assumed 1', () => {
    expect(copilotPricing('dummy-big', undefined, S)).toMatchObject({ multiplier: 10, per_premium_request: 0.04, currency: 'USD', assumed: false });
    expect(copilotPricing('gpt-4.1', undefined, S)).toMatchObject({ multiplier: 0, assumed: false });
    expect(copilotPricing('github-copilot/claude-sonnet-4.5', undefined, S)).toMatchObject({ multiplier: 1, assumed: false });
    expect(copilotPricing('dummy-unknown', undefined, S)).toMatchObject({ multiplier: 1, assumed: true });
    // A setting overrides GitHub's table.
    expect(copilotPricing('gpt-4.1', undefined, { ...S, copilotMultipliers: { 'gpt-4.1': 2 } }).multiplier).toBe(2);
  });

  it('lets the profile set the multiplier and the price per premium request', () => {
    const p = copilotPricing('dummy-big', { multiplier: 3, per_premium_request: 0.05, revision: 'contract-2026' }, S);
    expect(p).toMatchObject({ multiplier: 3, per_premium_request: 0.05, revision: 'contract-2026', assumed: false });
    expect(copilotCost(4, p)).toEqual({ premium_requests: 12, cost: 0.6 });
  });

  it('counts one premium request per prompt times the multiplier, whatever the tokens', () => {
    const big = harnessCost({ settings: S as any }, copilot(), 'dummy-big', { usage, prompts: 2 })!;
    expect(big).toMatchObject({ premium_requests: 20, multiplier: 10, cost: 0.8, currency: 'USD' });
    expect(big.revision).toBe('copilot-premium-requests-2025-11 at 0.04 USD/request');
    expect(harnessCost({ settings: S as any }, copilot(), 'dummy-cheap', { usage, prompts: 3 })).toMatchObject({ premium_requests: 0.99, cost: 0.0396 });
    expect(harnessCost({ settings: S as any }, copilot(), 'dummy-free', { usage, prompts: 5 })).toMatchObject({ premium_requests: 0, cost: 0 });
    expect(harnessCost({ settings: S as any }, copilot(), 'dummy-unknown', { usage, prompts: 1 })!.revision).toContain('multiplier assumed 1');
    // Older results without a prompt count stay unavailable rather than guessed.
    expect(harnessCost({ settings: S as any }, copilot(), 'dummy-big', { usage })).toBeNull();
  });

  it('still prices token-billed providers by their declared token prices', () => {
    const p: AgentProfile = { model: { provider: 'anthropic', name: 'm' }, instructions: 'x', pricing: { currency: 'USD', input_per_mtok: 3, output_per_mtok: 15, revision: 'r1' } };
    expect(harnessCost({ settings: S as any }, p, 'm', { usage, prompts: 1 })).toMatchObject({ cost: expect.closeTo(0.168, 6), premium_requests: null, revision: 'r1' });
    expect(harnessCost({ settings: S as any }, { ...p, pricing: undefined }, 'm', { usage, prompts: 1 })).toBeNull();
  });

  it('reads the price and multipliers from the environment', () => {
    const saved = { p: process.env.AZHI_COPILOT_PREMIUM_REQUEST_USD, m: process.env.AZHI_COPILOT_MULTIPLIERS };
    try {
      delete process.env.AZHI_COPILOT_PREMIUM_REQUEST_USD;
      delete process.env.AZHI_COPILOT_MULTIPLIERS;
      expect(settings().copilotPremiumRequestUsd).toBe(0.04);
      process.env.AZHI_COPILOT_PREMIUM_REQUEST_USD = '0';
      process.env.AZHI_COPILOT_MULTIPLIERS = 'dummy-x=1.5';
      expect(settings()).toMatchObject({ copilotPremiumRequestUsd: 0, copilotMultipliers: { 'dummy-x': 1.5 } });
      process.env.AZHI_COPILOT_PREMIUM_REQUEST_USD = 'lots';
      expect(settings().copilotPremiumRequestUsd).toBe(0.04);
    } finally {
      for (const [k, v] of [['AZHI_COPILOT_PREMIUM_REQUEST_USD', saved.p], ['AZHI_COPILOT_MULTIPLIERS', saved.m]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('summarises a run\'s premium requests per model next to its tokens', () => {
    const row = (node: string, model: string, premium: number, mult: number, cost: number, rev = 'copilot-premium-requests-2025-11 at 0.04 USD/request') => ({
      node_id: node, attempt: 1, turn: 1, model, input_tokens: 50_000, output_tokens: 1_000, cost, currency: 'USD', cost_label: 'estimated', pricing_revision: rev, premium_requests: premium, premium_multiplier: mult,
    });
    const u = summariseUsage([row('a', 'dummy-big', 10, 10, 0.4), row('b', 'dummy-big', 20, 10, 0.8), row('c', 'dummy-new', 1, 1, 0.04, 'copilot-premium-requests-2025-11 (multiplier assumed 1) at 0.04 USD/request')]);
    expect(u.input_tokens).toBe(150_000);
    expect(u.cost.amount).toBeCloseTo(1.24, 6);
    expect(u.premium_requests).toEqual({
      total: 31,
      cost: 1.24,
      currency: 'USD',
      per_premium_request: 0.04,
      models: [
        { model: 'dummy-big', multiplier: 10, premium_requests: 30, cost: 1.2, currency: 'USD', assumed: false },
        { model: 'dummy-new', multiplier: 1, premium_requests: 1, cost: 0.04, currency: 'USD', assumed: true },
      ],
    });
    expect(summariseUsage([{ ...row('a', 'm', 0, 0, 0), premium_requests: null }]).premium_requests).toBeNull();
  });
});
