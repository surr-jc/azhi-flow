import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../src/agents/profile.js';
import { openaiCost, openaiRate, parseRates } from '../src/agents/openai-pricing.js';
import { harnessCost } from '../src/runtime/gateway-activities.js';

const S = { openaiRates: parseRates('dummy-x=1/0.1/4') };
const usage = { input_tokens: 100_000, output_tokens: 2_000, cache_read_tokens: 400_000, cache_write_tokens: 0, reasoning_tokens: 0 };
const openai = (pricing?: AgentProfile['pricing']): AgentProfile => ({ model: { provider: 'openai', name: 'default' }, instructions: 'x', ...(pricing ? { pricing } : {}) });

describe('OpenAI token cost', () => {
  it('takes the rate from the profile, then settings, then the built-in table', () => {
    expect(openaiRate('dummy-x', undefined, S)).toMatchObject({ source: 'configured' });
    expect(openaiRate('gpt-5.5', undefined, S)).toEqual({ source: 'builtin', rate: { input: 5, cached: 0.5, output: 30 } });
    expect(openaiRate('gpt-5.5-2026-04-23', undefined, S)?.source).toBe('builtin');
    expect(openaiRate('gpt-5.5-pro', undefined, S)).toBeUndefined();
    expect(openaiRate('dummy-y', undefined, S)).toBeUndefined();
    expect(openaiRate('gpt-5.5', { input_per_mtok: 1, output_per_mtok: 2 }, S)).toEqual({ source: 'profile', rate: { input: 1, output: 2 } });
  });

  it('prices input, cached input and output once each', () => {
    // (100k x 5 + 2k x 30 + 400k x 0.5) / 1M = 0.76
    expect(openaiCost(usage, { input: 5, cached: 0.5, output: 30 })).toBe(0.76);
    expect(openaiCost({ ...usage, output_tokens: null }, { input: 5, output: 30 })).toBeNull();
  });

  it('prices a step for every executor, and leaves an unknown model unavailable', () => {
    expect(harnessCost({ settings: S as any }, openai(), 'gpt-5.5', { usage })).toEqual({ cost: 0.76, currency: 'USD', credits: null, revision: 'openai-standard-2026-06' });
    expect(harnessCost({ settings: S as any }, openai(), 'dummy-x', { usage })).toMatchObject({ cost: 0.148, revision: 'configured rate' });
    expect(harnessCost({ settings: S as any }, openai(), 'dummy-y', { usage })).toBeNull();
    // OpenCode's catalog cost prices a model nobody set; a configured rate still wins.
    expect(harnessCost({ settings: S as any }, openai(), 'dummy-y', { usage, reported_cost: 0.5 })).toMatchObject({ cost: 0.5, revision: 'OpenCode model catalog' });
    expect(harnessCost({ settings: S as any }, openai(), 'dummy-x', { usage, reported_cost: 9 })).toMatchObject({ revision: 'configured rate' });
  });
});
