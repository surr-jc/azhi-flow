import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { lensRows, lensSummary, type LensContext } from '../web/src/lenses.js';
import { graphOf } from '../web/src/graph.js';

const wf = parse(readFileSync('examples/pr-review/workflow.yaml', 'utf8'));
const cfg = parse(readFileSync('examples/pr-review/azhi.config.yaml', 'utf8'));
const nodes = graphOf({ nodes: wf.nodes });
const tools = [
  ...cfg.tools.map((t: any) => ({ id: t.id, version: t.version, effect: t.effect, credential: t.credential, transport: { config: { repos: ['acme/payments'] } } })),
  { id: 'slack.post-message', version: 1, effect: 'write-dedupable', credential: 'slack-bot-token' },
];
const ctx: LensContext = { tools, missing: new Set(['github-comment-token']) };
const row = (lens: 'access' | 'limits' | 'data', id: string) => lensRows(lens, nodes.find((n) => n.id === id)!, nodes, ctx);

describe('workflow lenses', () => {
  it('access: a write step shows its token, where it may act and its guard', () => {
    const rows = row('access', 'post');
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Can', value: 'change github', tone: 'warn' }));
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Token', value: 'github-comment-token (missing)', tone: 'warn' }));
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Only in', value: 'acme/payments' }));
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Guard', value: 'checked on every call', tone: 'ok' }));
  });

  it('access: a reviewer is a read-only checkout with its clone token', () => {
    const rows = row('access', 'security');
    expect(rows[0]).toMatchObject({ value: 'read a checkout', tone: 'ok' });
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Clone token', value: 'github-read-token', tone: 'ok' }));
  });

  it('limits: agents show their tool-call budget and timeout', () => {
    const rows = row('limits', 'correctness');
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Timeout', value: '15m' }));
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Tool calls', value: '10', tone: 'ok' }));
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Cost', value: 'no cap' }));
  });

  it('data: shows where a step gets its input and what it feeds', () => {
    const rows = row('data', 'pr');
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Gets', value: 'input repo, input pr' }));
    expect(rows.find((r) => r.label === 'Feeds')!.value).toContain('correctness');
  });

  it('summaries name what can be changed, by which step, and what is missing', () => {
    const access = lensSummary('access', nodes, ctx);
    expect(access[0]!.lines.join(' ')).toContain('github: post (guarded)');
    expect(access[0]!.lines.join(' ')).toContain('slack: notify (guarded)');
    expect(access[2]!.lines[0]).toContain('missing: github-comment-token');
    const limits = lensSummary('limits', nodes, ctx);
    expect(limits[0]!.lines[0]).toContain('Up to 52 tool calls');
    expect(lensSummary('data', nodes, ctx)[0]!.lines.join(' ')).toContain('input repo');
  });
});
