import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { mergePackages } from '../src/api/example-merge.js';
import { agentBegin } from '../src/agents/model-agent.js';
import { fsArtifactStore } from '../src/artifacts/store.js';
import { compile } from '../src/compiler/compile.js';
import { settings } from '../src/config/settings.js';
import { loadDefinitionFile, loadDefinitionText } from '../src/definition/load.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { resolveValue } from '../src/runtime/values.js';
import type { AppContext } from '../src/server/context.js';
import { stagePackage } from '../src/server/packages.js';

/** examples/context-review-revise: a shared context, a cap with withhold, and a notes field, run as far as a test can without Temporal. */
const DIR = 'examples/context-review-revise';
const loaded = loadDefinitionFile(`${DIR}/workflow.yaml`);
const pkg = packageFromDirectory(DIR);
const result = compile(loaded.definition!, { pkg });
const node = (id: string) => result.plan!.nodes.find((n) => n.id === id)!;

describe('the example compiles', () => {
  it('has no errors and no warnings', () => {
    expect(loaded.diagnostics).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('gives each agent the brief, in the order the bundle declares, then its own keys', () => {
    expect(Object.keys((node('draft').def as { input: object }).input)).toEqual(['topic', 'facts']);
    expect(Object.keys((node('critique').def as { input: object }).input)).toEqual(['topic', 'facts', 'draft']);
    expect(Object.keys((node('revise').def as { input: object }).input)).toEqual(['topic', 'facts', 'draft', 'notes', 'issues']);
    expect(node('critique').inputParts).toEqual([
      { key: 'topic', source: 'context:brief' },
      { key: 'facts', source: 'context:brief' },
      { key: 'draft', source: 'input' },
    ]);
  });

  it('orders the steps by what the context reads, and nothing is skippable here', () => {
    expect(node('draft').deps).toEqual(['gather']);
    expect(node('critique').deps).toEqual(['draft', 'gather']);
    expect(node('revise').deps).toEqual(['critique', 'draft', 'gather']);
  });
});

describe('the example at run time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-crr-'));
  const ctx = { settings: settings(), artifacts: fsArtifactStore(dir) } as unknown as AppContext;
  const WS = 'ws-crr';
  stagePackage(ctx, WS, pkg.hash, pkg.manifest, new Map(pkg.manifest.files.map((f) => [f.path, pkg.read(f.path)!])));

  const scope = (draftText: string) => ({
    inputs: { topic: 'tides' },
    config: {},
    nodes: {
      gather: { output: { topic: 'tides', facts: ['f1', 'f2'] } },
      draft: { output: { text: draftText, notes: 'check the example' } },
      critique: { output: { approved: false, issues: ['the example is weak'] } },
    },
  });
  const begin = async (id: string, draftText: string) => {
    const n = node(id);
    const def = n.def as unknown as { input: never; profile: string; context_budget?: { max_item_bytes?: number; on_exceed?: 'fail' | 'withhold' } };
    const input = resolveValue(def.input, scope(draftText) as never);
    const state = await agentBegin(
      ctx,
      { runId: 'r1', workspaceId: WS, nodeId: id, packageHash: pkg.hash, profile: def.profile, outputSchema: n.outputSchema as Record<string, unknown>, tools: [], input, inputSources: n.dataDeps, inputParts: n.inputParts, ...(def.context_budget ? { contextBudget: def.context_budget } : {}) },
      { transcript: false },
    );
    const t = JSON.parse(ctx.artifacts.get(state.transcript)!.toString('utf8')) as { items: Array<Record<string, any>>; messages: any[] };
    return { state, items: t.items.filter((i) => i.kind === 'input'), prompt: t.messages[0].content[0].text as string };
  };

  it('sends the critic the brief and the draft, one manifest item per field', async () => {
    const r = await begin('critique', 'a short draft');
    expect(r.state.withheld).toBeUndefined();
    expect(r.items.map((i) => i.source)).toEqual(['context:brief.topic', 'context:brief.facts', 'input.draft']);
    expect(r.prompt).toContain('a short draft');
  });

  it('keeps back a draft over the cap and records it, while the brief still arrives', async () => {
    const r = await begin('critique', 'x'.repeat(6000));
    expect(r.state.withheld).toEqual([{ key: 'draft', bytes: 6002, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(r.prompt).not.toContain('xxxx');
    expect(r.prompt).toContain('tides');
    expect(r.items.map((i) => i.source)).toEqual(['context:brief.topic', 'context:brief.facts', 'input.draft']);
    expect(r.items.find((i) => i.source === 'input.draft')!.reason).toContain('withheld by context_budget');
  });

  it('passes the writer\'s notes to the reviser as an ordinary field', async () => {
    const r = await begin('revise', 'a short draft');
    expect(r.prompt).toContain('check the example');
    expect(r.items.map((i) => i.source)).toEqual(['context:brief.topic', 'context:brief.facts', 'input.draft', 'input.notes', 'input.issues']);
  });
});

const python = (() => {
  const r = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === '1';
})();

describe('the example\'s script', () => {
  it.skipIf(!python)('prints facts for the topic it is given', () => {
    const r = spawnSync('python3', [`${DIR}/scripts/gather.py`], { input: JSON.stringify({ topic: 'tides' }), encoding: 'utf8' });
    const out = JSON.parse(r.stdout) as { topic: string; facts: string[] };
    expect(out.topic).toBe('tides');
    expect(out.facts.length).toBeGreaterThan(0);
    expect(out.facts.join(' ')).toContain('tides');
  });
});

describe('updating an installed copy that has contexts', () => {
  const wf = (contexts: Record<string, unknown>) => Buffer.from(stringify({ schema_version: '2.0', id: 'w', name: 'W', contexts, nodes: [{ id: 'a', type: 'agent', profile: 'p@1', output_schema: {}, context: ['one', 'two'] }] }));
  const base = new Map([['workflow.yaml', wf({ one: { x: 1, y: 1 }, two: { z: 1 } })]]);
  const merged = (local: Buffer, up: Buffer) => mergePackages(base, new Map([['workflow.yaml', local]]), new Map([['workflow.yaml', up]]), 'workflow.yaml');

  it('keeps a local edit to one context and takes the marketplace\'s change to another', () => {
    const r = merged(wf({ one: { x: 2, y: 1 }, two: { z: 1 } }), wf({ one: { x: 1, y: 1 }, two: { z: 9 } }));
    expect(parse(r.files.get('workflow.yaml')!.toString()).contexts).toEqual({ one: { x: 2, y: 1 }, two: { z: 9 } });
    expect(r.report.changes.filter((c) => c.kind === 'conflict')).toEqual([]);
  });

  it('keeps a local edit and takes a marketplace change to another key of the same context', () => {
    const r = merged(wf({ one: { x: 2, y: 1 }, two: { z: 1 } }), wf({ one: { x: 1, y: 7 }, two: { z: 1 } }));
    expect(parse(r.files.get('workflow.yaml')!.toString()).contexts.one).toEqual({ x: 2, y: 7 });
  });

  it('reports a conflict when a local edit to an old map input meets an update that moved it into a context, and the merged step does not compile until it is resolved', () => {
    const step = (extra: Record<string, unknown>) => ({ id: 'a', type: 'agent', profile: 'p@1', output_schema: {}, ...extra });
    const file = (n: unknown, contexts?: unknown) => Buffer.from(stringify({ schema_version: '2.0', id: 'w', ...(contexts ? { contexts } : {}), nodes: [n] }));
    const r = mergePackages(
      new Map([['workflow.yaml', file(step({ input: { map: "{'t': 1}" } }))]]),
      new Map([['workflow.yaml', file(step({ input: { map: "{'t': 1, 'mine': 3}" } }))]]),
      new Map([['workflow.yaml', file(step({ context: ['c'] }), { c: { t: 1 } })]]),
      'workflow.yaml',
    );
    expect(r.report.changes).toContainEqual(expect.objectContaining({ scope: 'step', target: 'a', field: 'input', kind: 'conflict' }));
    const merged = loadDefinitionText(r.files.get('workflow.yaml')!.toString());
    expect(compile(merged.definition!).diagnostics.map((d) => d.code)).toContain('context_input_shape');
  });

  it('reports a conflict, and keeps the local value, when both changed the same key', () => {
    const r = merged(wf({ one: { x: 2, y: 1 }, two: { z: 1 } }), wf({ one: { x: 3, y: 1 }, two: { z: 1 } }));
    expect(parse(r.files.get('workflow.yaml')!.toString()).contexts.one.x).toBe(2);
    expect(r.report.changes.some((c) => c.kind === 'conflict')).toBe(true);
  });
});
