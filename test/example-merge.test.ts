import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { mergePackages, summarise } from '../src/api/example-merge.js';

const wf = (nodes: unknown[], extra: Record<string, unknown> = {}) => Buffer.from(stringify({ schema_version: '2.0', id: 'w', name: 'W', ...extra, nodes }));
const pkg = (files: Record<string, string | Buffer>) => new Map(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]));
const definition = (m: Map<string, Buffer>) => (m.get('workflow.yaml')!.toString('utf8'));

const baseNodes = [
  { id: 'pr', type: 'tool', tool: 'github.get-pull-request@1', timeout: '1m' },
  { id: 'review', type: 'agent', profile: 'r@1', timeout: '15m', budget: { max_tool_calls: 10 } },
  { id: 'post', type: 'tool', tool: 'github.comment-on-pr@1' },
];

describe('marketplace update merge', () => {
  it('takes the marketplace file verbatim when nothing was edited locally', () => {
    const base = pkg({ 'workflow.yaml': wf(baseNodes), 'profiles/r@1.yaml': 'v1' });
    const up = pkg({ 'workflow.yaml': wf([...baseNodes, { id: 'notify', type: 'notify', channel: 'slack', destination: 'C1', message: 'hi' }]), 'profiles/r@1.yaml': 'v2' });
    const r = mergePackages(base, base, up, 'workflow.yaml');
    expect(r.files.get('workflow.yaml')).toEqual(up.get('workflow.yaml'));
    expect(r.files.get('profiles/r@1.yaml')!.toString()).toBe('v2');
    expect(r.report.reformatted).toBe(false);
    expect(r.report.changes).toContainEqual(expect.objectContaining({ scope: 'step', target: 'notify', kind: 'added' }));
    expect(r.report.changes).toContainEqual(expect.objectContaining({ scope: 'file', target: 'profiles/r@1.yaml', kind: 'updated' }));
  });

  it('keeps local edits and applies the marketplace changes to other settings', () => {
    const base = pkg({ 'workflow.yaml': wf(baseNodes) });
    // Local: a longer timeout on review, and a new step of its own.
    const local = pkg({ 'workflow.yaml': wf([baseNodes[0], { ...baseNodes[1], timeout: '30m' }, baseNodes[2], { id: 'mine', type: 'script', runtime: 'python', entrypoint: 'x.py' }]) });
    // Marketplace: review gets a bigger budget and a new setting, pr gets a new timeout.
    const up = pkg({ 'workflow.yaml': wf([{ ...baseNodes[0], timeout: '2m' }, { ...baseNodes[1], budget: { max_tool_calls: 20 }, description: 'Review the change.' }, baseNodes[2]]) });
    const r = mergePackages(base, local, up, 'workflow.yaml');
    const text = definition(r.files);
    expect(text).toContain('timeout: 30m'); // yours stays
    expect(text).toContain('max_tool_calls: 20'); // theirs applied
    expect(text).toContain('description: Review the change.'); // new field loaded
    expect(text).toContain('timeout: 2m'); // other step updated
    expect(text).toContain('id: mine'); // your step survives
    expect(r.report.reformatted).toBe(true);
    expect(summarise(r.report).conflicts).toBe(0);
    expect(r.report.kept).toBeGreaterThan(0);
  });

  it('reports a setting both sides changed and keeps the local value', () => {
    const base = pkg({ 'workflow.yaml': wf(baseNodes) });
    const local = pkg({ 'workflow.yaml': wf([baseNodes[0], { ...baseNodes[1], timeout: '30m' }, baseNodes[2]]) });
    const up = pkg({ 'workflow.yaml': wf([baseNodes[0], { ...baseNodes[1], timeout: '20m' }, baseNodes[2]]) });
    const r = mergePackages(base, local, up, 'workflow.yaml');
    expect(definition(r.files)).toContain('timeout: 30m');
    expect(r.report.changes).toContainEqual(expect.objectContaining({ target: 'review', field: 'timeout', kind: 'conflict' }));
  });

  it('does not bring back a step you deleted, nor remove one you changed', () => {
    const base = pkg({ 'workflow.yaml': wf(baseNodes) });
    const local = pkg({ 'workflow.yaml': wf([baseNodes[0], { ...baseNodes[1], timeout: '30m' }]) }); // deleted post, edited review
    const up = pkg({ 'workflow.yaml': wf([baseNodes[0], baseNodes[2]]) }); // dropped review
    const r = mergePackages(base, local, up, 'workflow.yaml');
    const text = definition(r.files);
    expect(text).not.toContain('id: post');
    expect(text).toContain('id: review');
    expect(r.report.changes).toContainEqual(expect.objectContaining({ target: 'review', kind: 'conflict' }));
  });

  it('keeps locally edited files and conflicts when both sides changed one', () => {
    const base = pkg({ 'workflow.yaml': wf(baseNodes), 'a.md': 'base', 'b.md': 'base', 'c.md': 'base' });
    const local = pkg({ 'workflow.yaml': wf(baseNodes), 'a.md': 'mine', 'b.md': 'mine', 'c.md': 'base', 'own.md': 'mine' });
    const up = pkg({ 'workflow.yaml': wf(baseNodes), 'a.md': 'base', 'b.md': 'theirs', 'c.md': 'theirs', 'new.md': 'theirs' });
    const r = mergePackages(base, local, up, 'workflow.yaml');
    const get = (p: string) => r.files.get(p)?.toString();
    expect([get('a.md'), get('b.md'), get('c.md'), get('own.md'), get('new.md')]).toEqual(['mine', 'mine', 'theirs', 'mine', 'theirs']);
    expect(r.report.changes).toContainEqual(expect.objectContaining({ target: 'b.md', kind: 'conflict' }));
  });

  it('without a base only adds what is missing', () => {
    const local = pkg({ 'workflow.yaml': wf([{ ...baseNodes[0], timeout: '9m' }, baseNodes[1]]), 'a.md': 'mine' });
    const up = pkg({ 'workflow.yaml': wf([{ ...baseNodes[0], timeout: '2m', retry: { max_attempts: 3 } }, baseNodes[1], baseNodes[2]]), 'a.md': 'theirs', 'new.md': 'theirs' });
    const r = mergePackages(undefined, local, up, 'workflow.yaml');
    const text = definition(r.files);
    expect(text).toContain('timeout: 9m');
    expect(text).toContain('max_attempts: 3');
    expect(text).toContain('id: post');
    expect(r.files.get('a.md')!.toString()).toBe('mine');
    expect(r.files.get('new.md')!.toString()).toBe('theirs');
    expect(summarise(r.report).conflicts).toBe(0);
  });
});
