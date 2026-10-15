import { describe, expect, it } from 'vitest';
import { bundleItems, matchItem, type Inventory } from '../web/src/bundle.js';

const inv: Inventory = {
  agents: [{ id: 'engineer@1', description: 'Implements a plan', provider: 'openai', model: 'gpt', skills: ['s1'], command: 'implement', tools: ['read'], mcp: [], steps: ['build'] }],
  skills: [{ id: 's1', description: null, agents: ['engineer@1'] }],
  commands: [],
  mcp: [],
  harness_tools: [{ name: 'read', agents: ['engineer@1'] }],
  files: 4,
};

describe('bundleItems', () => {
  const items = bundleItems(inv, [{ ref: 'github.get-issue@1', effect: 'read', description: 'Reads an issue' }, { ref: 'github.comment@1', effect: 'write-unsafe', description: 'Comments' }]);
  it('counts each kind', () => {
    expect(items.agents).toHaveLength(1);
    expect(items.commands).toHaveLength(0);
    expect(items.tools).toHaveLength(3);
  });
  it('labels writes in words, not only by tone', () => {
    expect(items.tools[1]!.chips[0]).toEqual({ text: 'writes · write-unsafe', tone: 'warn' });
    expect(items.tools[0]!.chips[0]!.text).toBe('read only');
  });
  it('searches title and summary', () => {
    expect(matchItem(items.agents[0]!, 'implements')).toBe(true);
    expect(matchItem(items.agents[0]!, 'zzz')).toBe(false);
    expect(matchItem(items.agents[0]!, '  ')).toBe(true);
  });
});
