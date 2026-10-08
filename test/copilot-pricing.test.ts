import { describe, expect, it } from 'vitest';
import { COPILOT_CREDIT_USD, copilotCredits, copilotRate, parseRates, poolPosition } from '../src/agents/copilot-pricing.js';
import type { AgentProfile } from '../src/agents/profile.js';
import { settings } from '../src/config/settings.js';
import { harnessCost } from '../src/runtime/gateway-activities.js';
import { summariseUsage } from '../src/server/runs.js';

/** Copilot bills GitHub AI Credits: tokens at per-model rates, 1 credit = USD 0.01. These use made-up models. */
const S = { copilotCreditUsd: COPILOT_CREDIT_USD, copilotRates: parseRates('dummy-big=10/1/12.5/50, Dummy-Plain=2/8'), copilotCreditPool: undefined };
const usage = { input_tokens: 100_000, output_tokens: 2_000, cache_read_tokens: 400_000, cache_write_tokens: 10_000, reasoning_tokens: 0 };
const copilot = (pricing?: AgentProfile['pricing']): AgentProfile => ({ model: { provider: 'github-copilot', name: 'default' }, instructions: 'x', ...(pricing ? { pricing } : {}) });

describe('GitHub Copilot AI credit pricing', () => {
  it('reads per-model rates from settings text, ignoring malformed entries', () => {
    expect(parseRates('a=1/0.1/1.25/5, b = 2/8\nc=5//30, d=x/1, e=1/2/3/4/5, =1/2')).toEqual({
      a: { input: 1, cached: 0.1, cache_write: 1.25, output: 5 },
      b: { input: 2, output: 8 },
      c: { input: 5, output: 30 },
    });
    expect(parseRates(undefined)).toEqual({});
  });

  it('takes the rate from the profile, then settings, then GitHub\'s table', () => {
    expect(copilotRate('dummy-big', undefined, S)).toEqual({ input: 10, cached: 1, cache_write: 12.5, output: 50 });
    expect(copilotRate('github-copilot/claude-sonnet-5', undefined, S)).toEqual({ input: 2, cached: 0.2, cache_write: 2.5, output: 10 });
    expect(copilotRate('dummy-unknown', undefined, S)).toBeUndefined();
    expect(copilotRate('claude-sonnet-5.5', undefined, S)).toEqual({ input: 2, cached: 0.2, cache_write: 2.5, output: 10 });
    expect(copilotRate('gpt-5.4', undefined, S)).toEqual({ input: 2.5, cached: 0.25, output: 15 });
    // Names are matched loosely, and a dated or preview build takes its model's rate, but a new version does not.
    const luna = { input: 0.2, cached: 0.02, cache_write: 0.25, output: 1.2 };
    for (const m of ['gpt-5.6-luna', 'GPT 5.6 Luna', 'gpt-5-6-luna', 'github-copilot/gpt-5.6-luna', 'gpt-5.6-luna-2026-09-01', 'gpt-5.6-luna-preview']) expect(copilotRate(m, undefined, S)).toEqual(luna);
    expect(copilotRate('claude-sonnet-4.7', undefined, S)).toBeUndefined();
    expect(copilotRate('gpt-5.6-luna-mini', undefined, S)).toBeUndefined();
    expect(copilotRate('claude-sonnet-5', undefined, { ...S, copilotRates: { 'claude-sonnet-5': { input: 1, output: 1 } } })).toEqual({ input: 1, output: 1 });
    expect(copilotRate('dummy-unknown', { input_per_mtok: 4, output_per_mtok: 20, cache_read_per_mtok: 0.4 }, S)).toEqual({ input: 4, output: 20, cached: 0.4 });
  });

  it('counts credits from input, cached, cache-write and output tokens', () => {
    // (100k x 10 + 2k x 50 + 400k x 1 + 10k x 12.5) / 1M = USD 1.625 = 162.5 credits.
    expect(copilotCredits(usage, copilotRate('dummy-big', undefined, S)!, 0.01)).toEqual({ credits: 162.5, cost: 1.625 });
    // Without cache rates, cached tokens cost the input rate.
    expect(copilotCredits(usage, copilotRate('dummy-plain', undefined, S)!, 0.01)).toEqual({ credits: 103.6, cost: 1.036 });
    // A contract price per credit changes the money, not the credits.
    expect(copilotCredits(usage, copilotRate('dummy-big', undefined, S)!, 0.008)).toEqual({ credits: 162.5, cost: 1.3 });
    expect(copilotCredits({ ...usage, input_tokens: null }, { input: 1, output: 1 }, 0.01)).toBeNull();
  });

  it('prices a Copilot step in credits, and leaves a model without a rate unavailable', () => {
    expect(harnessCost({ settings: S as any }, copilot(), 'dummy-big', { usage })).toEqual({ cost: 1.625, currency: 'USD', credits: 162.5, revision: 'configured rate at 0.01 USD/credit' });
    expect(harnessCost({ settings: S as any }, copilot(), 'dummy-unknown', { usage })).toBeNull();
    // OpenCode's own cost (from its model catalog, which lists every model its Copilot provider offers) prices a model nobody set.
    expect(harnessCost({ settings: S as any }, copilot(), 'dummy-unknown', { usage, reported_cost: 0.4321 })).toEqual({ cost: 0.4321, currency: 'USD', credits: 43.21, revision: 'OpenCode model catalog at 0.01 USD/credit' });
    expect(harnessCost({ settings: { ...S, copilotCreditUsd: 0.008 } as any }, copilot(), 'dummy-unknown', { usage, reported_cost: 0.5 })).toMatchObject({ credits: 50, cost: 0.4 });
    // A rate someone set wins over OpenCode's.
    expect(harnessCost({ settings: S as any }, copilot(), 'dummy-big', { usage, reported_cost: 99 })).toMatchObject({ credits: 162.5 });
    // OpenCode reports 0 for a model missing from its catalog: then the built-in table, else unavailable.
    expect(harnessCost({ settings: S as any }, copilot(), 'claude-sonnet-5.5', { usage, reported_cost: 0 })).toMatchObject({ revision: 'copilot-ai-credits-2026-06 at 0.01 USD/credit' });
    expect(harnessCost({ settings: S as any }, copilot(), 'dummy-unknown', { usage, reported_cost: 0 })).toBeNull();
    const p: AgentProfile = { model: { provider: 'anthropic', name: 'm' }, instructions: 'x', pricing: { currency: 'USD', input_per_mtok: 3, output_per_mtok: 15, revision: 'r1' } };
    expect(harnessCost({ settings: S as any }, p, 'm', { usage })).toMatchObject({ credits: null, revision: 'r1' });
  });

  it('places a run in the monthly pool', () => {
    expect(poolPosition(undefined, 10, 5)).toBeNull();
    expect(poolPosition(10_000, 9_000, 500)).toEqual({ monthly: 10_000, used_before: 9_000, left_after: 500, past_pool: 0 });
    expect(poolPosition(10_000, 9_800, 500)).toEqual({ monthly: 10_000, used_before: 9_800, left_after: 0, past_pool: 300 });
    expect(poolPosition(10_000, 12_000, 500)).toEqual({ monthly: 10_000, used_before: 12_000, left_after: 0, past_pool: 500 });
  });

  it('reads the credit price, rates and pool from the environment', () => {
    const keys = ['AZHI_COPILOT_CREDIT_USD', 'AZHI_COPILOT_RATES', 'AZHI_COPILOT_CREDIT_POOL'] as const;
    const saved = keys.map((k) => process.env[k]);
    try {
      for (const k of keys) delete process.env[k];
      expect(settings()).toMatchObject({ copilotCreditUsd: 0.01, copilotRates: {}, copilotCreditPool: undefined });
      process.env.AZHI_COPILOT_CREDIT_USD = '0.009';
      process.env.AZHI_COPILOT_RATES = 'dummy-x=1/2';
      process.env.AZHI_COPILOT_CREDIT_POOL = '12000';
      expect(settings()).toMatchObject({ copilotCreditUsd: 0.009, copilotRates: { 'dummy-x': { input: 1, output: 2 } }, copilotCreditPool: 12000 });
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  it('summarises a run\'s credits per model, the pool, and models without a rate', () => {
    const row = (model: string, credits: number | null) => ({
      node_id: 'n', attempt: 1, turn: 1, provider: 'github-copilot', model, input_tokens: 1, output_tokens: 1, credits, cost: credits === null ? null : credits * 0.01, currency: credits === null ? null : 'USD', cost_label: credits === null ? 'unavailable' : 'estimated',
    });
    const s = { copilotCreditUsd: 0.01, copilotCreditPool: 10_000 };
    const u = summariseUsage([row('dummy-big', 300), row('dummy-big', 200), row('dummy-plain', 100)], 9_800, s);
    expect(u.cost.amount).toBeCloseTo(6, 6);
    expect(u.credits).toBe(600);
    expect(u.copilot).toEqual({
      credits: 600,
      cost: 6,
      currency: 'USD',
      credit_usd: 0.01,
      models: [{ model: 'dummy-big', credits: 500, cost: 5 }, { model: 'dummy-plain', credits: 100, cost: 1 }],
      unpriced_models: [],
      pool: { monthly: 10_000, used_before: 9_800, left_after: 0, past_pool: 400, past_pool_cost: 4 },
    });
    const partly = summariseUsage([row('dummy-big', 300), row('dummy-unknown', null)], 0, { copilotCreditUsd: 0.01, copilotCreditPool: undefined });
    expect(partly.cost.amount).toBeNull();
    expect(partly.copilot).toMatchObject({ credits: 300, unpriced_models: ['dummy-unknown'], pool: null });
    const other = summariseUsage([{ ...row('m', 1), provider: 'anthropic', credits: null }], 0, s);
    expect(other.copilot).toBeNull();
    expect(other.credits).toBeNull();
  });
});
