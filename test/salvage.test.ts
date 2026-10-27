import { describe, expect, it } from 'vitest';
import { salvageLeakedParameters } from '../src/agents/gateway-mcp.js';

describe('salvageLeakedParameters', () => {
  it('recovers a parameter a model wrote inside the previous string', () => {
    const leaked = 'Found no issues.</summary>\n<parameter name="findings">[]</parameter>\n</invoke>\n';
    expect(salvageLeakedParameters({ summary: leaked, reviewer: 'security' })).toEqual({ summary: 'Found no issues.', reviewer: 'security', findings: [] });
    // The first attempt in the screenshot: markup cut off before the closing tags.
    expect(salvageLeakedParameters({ summary: 'ok.</summary>\n<parameter name="findings">[{"path":"a"}]', reviewer: 'x' })).toEqual({ summary: 'ok.', reviewer: 'x', findings: [{ path: 'a' }] });
  });
  it('leaves ordinary output alone and never overwrites a given field', () => {
    expect(salvageLeakedParameters({ summary: 'fine', findings: [] })).toBeUndefined();
    expect(salvageLeakedParameters({ summary: 'x</summary><parameter name="findings">[]</parameter>', findings: [{ a: 1 }] })).toEqual({ summary: 'x', findings: [{ a: 1 }] });
    expect(salvageLeakedParameters('text')).toBeUndefined();
  });
});
