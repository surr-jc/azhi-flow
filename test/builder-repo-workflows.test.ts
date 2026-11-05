import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadExample } from '../src/api/examples.js';
import { searchDocs } from '../src/assistant/tools.js';

/**
 * The workflow builder chat knows the patterns of the PR conflict resolver: the skill (sent on every turn) names the
 * workspace options, the checks and the example to read, stays short, and the assistant can find the doc.
 */
const skill = readFileSync('src/builder/skill.md', 'utf8').replace(/\r\n/g, '\n');
const section = (title: string) => {
  const from = skill.indexOf(`## ${title}`);
  const next = skill.indexOf('\n## ', from + 1);
  return skill.slice(from, next < 0 ? undefined : next);
};

describe('builder skill: repository change workflows', () => {
  const s = section('Repository change workflows');

  it('teaches the merge workspace, the literal test command, the credential split and the unrolled retry', () => {
    expect(s).toContain('read_example pr-conflict-resolver');
    expect(s).toContain('`workspace.merge_ref`');
    expect(s).toContain('`workspace_merge`');
    expect(s).toMatch(/not a `\{ref\}`/);
    expect(s).toContain('`&test`');
    expect(s).toMatch(/inconclusive[\s\S]*never a pass/);
    expect(s).toMatch(/read token[\s\S]*`approval`[\s\S]*write token/);
    expect(s).toContain('`guard`');
    expect(s).toContain('`cli_fallback`');
    expect(s).toMatch(/cannot be a loop body/);
    expect(s).toContain('`merge: any`');
  });

  it('lists the new workspace keys in the agent reference, and stays short because it is sent on every turn', () => {
    expect(skill).toMatch(/`merge_ref` merges a second ref/);
    expect(skill).toMatch(/`test: \{command, timeout, attempts\}`/);
    expect(s.trim().split('\n').length).toBeLessThanOrEqual(26);
    expect(skill.length).toBeLessThan(30_000);
  });

  it('points at an example that ships and uses what the skill teaches', () => {
    const e = loadExample('pr-conflict-resolver')!;
    expect(e).toBeDefined();
    const ws = e.nodes.filter((n) => n.type === 'agent' && (n as any).workspace);
    expect(ws.some((n: any) => n.workspace.merge_ref)).toBe(true);
    expect(ws.some((n: any) => n.workspace.from)).toBe(true);
    expect(e.nodes.some((n) => (n as any).merge === 'any')).toBe(true);
  });
});

describe('assistant docs', () => {
  it('finds the conflict resolver page when asked about merge conflicts', () => {
    expect(searchDocs('how does the pr conflict resolver merge conflicts workspace merge_ref').map((r) => r.doc)).toContain('docs/pr-conflict-resolver.md');
  });
});
