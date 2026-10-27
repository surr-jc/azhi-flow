import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleInventory } from '../src/api/bundle-inventory.js';

const examples = join(import.meta.dirname, '..', 'examples');

describe('bundleInventory', () => {
  it('lists what ai-sdlc-v2 ships and which agents use it', () => {
    const inv = bundleInventory(join(examples, 'ai-sdlc-v2'), []);
    expect(inv.agents).toHaveLength(12);
    expect(inv.skills.length).toBeGreaterThan(0);
    expect(inv.commands.length).toBeGreaterThan(0);
    const engineer = inv.agents.find((a) => a.id === 'engineer@1')!;
    expect(engineer.skills).toContain('implement-change');
    expect(engineer.tools).toEqual(['read', 'grep', 'glob', 'skill']);
    expect(inv.skills.find((s) => s.id === 'implement-change')!.agents).toContain('engineer@1');
    expect(inv.files).toBeGreaterThan(12);
  });

  it('links agents to the steps that run them', () => {
    const inv = bundleInventory(join(examples, 'ai-sdlc-v2'), [{ id: 'build', type: 'agent', profile: 'engineer@1' }]);
    expect(inv.agents.find((a) => a.id === 'engineer@1')!.steps).toEqual(['build']);
  });

  it('returns empty lists, not guesses, for a template without profiles', () => {
    const inv = bundleInventory(join(examples, 'doubler'), []);
    expect(inv.agents).toEqual([]);
    expect(inv.mcp).toEqual([]);
  });

  it('keeps environment values out and ignores paths that leave the template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'));
    mkdirSync(join(dir, 'profiles'));
    writeFileSync(join(dir, 'profiles', 'a@1.yaml'), 'model: {provider: scripted}\ninstructions: x\nharness:\n  opencode:\n    agent: ../../outside.md\n    mcp:\n      docs: {command: [node, s.mjs], environment: {TOKEN: hunter2}}\n');
    const inv = bundleInventory(dir, []);
    expect(inv.agents[0]!.description).toBeNull();
    expect(inv.mcp[0]).toMatchObject({ name: 'docs', env_names: ['TOKEN'] });
    expect(JSON.stringify(inv)).not.toContain('hunter2');
  });
});
