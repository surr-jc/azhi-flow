import { describe, expect, it } from 'vitest';
import { applyContextBudget } from '../src/agents/context-budget.js';
import { settings } from '../src/config/settings.js';
import { byteSize } from '../src/lib/json.js';

const big = (n: number) => 'x'.repeat(n);

describe('applyContextBudget', () => {
  it('returns the very same input when no limit is set', () => {
    const input = { a: big(5000) };
    const r = applyContextBudget(input, { onExceed: 'fail' }, 'n');
    expect(r.input).toBe(input);
    expect(r.withheld).toEqual([]);
  });

  it('fails by default and names the node, the field and the numbers', () => {
    const input = { ticket: 'short', diff: big(2000) };
    expect(() => applyContextBudget(input, { maxItemBytes: 1000, onExceed: 'fail' }, 'review')).toThrowError(/node 'review' input field 'diff' is 2002 bytes, above context_budget.max_item_bytes of 1000/);
    expect(() => applyContextBudget(input, { maxInputBytes: 1500, onExceed: 'fail' }, 'review')).toThrowError(/above context_budget.max_input_bytes of 1500/);
  });

  it('passes an input exactly at the limit', () => {
    const input = { a: big(10) };
    const n = byteSize(input);
    expect(applyContextBudget(input, { maxInputBytes: n, onExceed: 'fail' }, 'n').input).toBe(input);
    expect(() => applyContextBudget(input, { maxInputBytes: n - 1, onExceed: 'fail' }, 'n')).toThrowError();
  });

  it('withholds an oversized field with a note, its size and its hash, and keeps the rest', () => {
    const input = { ticket: 'short', diff: big(2000) };
    const r = applyContextBudget(input, { maxItemBytes: 1000, onExceed: 'withhold' }, 'n');
    expect(r.input).toMatchObject({ ticket: 'short', diff: { bytes: 2002, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), note: expect.stringContaining('you cannot read it') } });
    expect(r.withheld).toEqual([{ key: 'diff', bytes: 2002, sha256: (r.input as any).diff.sha256 }]);
    expect(JSON.stringify(r.input)).not.toContain('xxxx');
  });

  it('withholds the largest remaining field first until the total fits, ties by key order', () => {
    const input = { a: big(900), b: big(1200), c: big(900), d: 'tiny' };
    const r = applyContextBudget(input, { maxInputBytes: 2000, onExceed: 'withhold' }, 'n');
    expect(r.withheld.map((w) => w.key)).toEqual(['b', 'a']);
    expect(byteSize(r.input)).toBeLessThanOrEqual(2000);
    expect((r.input as any).c).toBe(input.c);
  });

  it('still fails when withholding every field is not enough', () => {
    const input = { a: big(200), b: big(200) };
    expect(() => applyContextBudget(input, { maxInputBytes: 100, onExceed: 'withhold' }, 'n')).toThrowError(/with every field withheld/);
  });

  it('measures a non-object input whole, and cannot withhold part of it', () => {
    expect(() => applyContextBudget(big(2000), { maxInputBytes: 1000, onExceed: 'withhold' }, 'n')).toThrowError(/input is 2002 bytes/);
    expect(applyContextBudget(null, { maxInputBytes: 1000, onExceed: 'fail' }, 'n').input).toBeNull();
    expect(() => applyContextBudget([big(2000)], { maxItemBytes: 1000, onExceed: 'withhold' }, 'n')).toThrowError();
  });

  it('counts bytes, not characters', () => {
    const input = { a: 'é'.repeat(300) }; // 300 characters, 600 bytes of text
    expect(() => applyContextBudget(input, { maxItemBytes: 500, onExceed: 'fail' }, 'n')).toThrowError(/602 bytes/);
  });
});

describe('server default', () => {
  it('is off unless the environment sets it, and ignores values below the minimum', () => {
    const was = [process.env.AZHI_CONTEXT_MAX_ITEM_BYTES, process.env.AZHI_CONTEXT_MAX_INPUT_BYTES];
    try {
      delete process.env.AZHI_CONTEXT_MAX_ITEM_BYTES;
      delete process.env.AZHI_CONTEXT_MAX_INPUT_BYTES;
      expect(settings().contextBudget).toEqual({ maxItemBytes: undefined, maxInputBytes: undefined });
      process.env.AZHI_CONTEXT_MAX_ITEM_BYTES = '4096';
      process.env.AZHI_CONTEXT_MAX_INPUT_BYTES = '10';
      expect(settings().contextBudget).toEqual({ maxItemBytes: 4096, maxInputBytes: undefined });
    } finally {
      for (const [k, v] of [['AZHI_CONTEXT_MAX_ITEM_BYTES', was[0]], ['AZHI_CONTEXT_MAX_INPUT_BYTES', was[1]]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
