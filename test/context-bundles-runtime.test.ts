import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentBegin, type AgentBeginInput } from '../src/agents/model-agent.js';
import { fsArtifactStore } from '../src/artifacts/store.js';
import { settings } from '../src/config/settings.js';
import { sha256 } from '../src/lib/hash.js';
import { queryInput } from '../src/runtime/gateway-activities.js';
import type { AppContext } from '../src/server/context.js';
import { stagePackage } from '../src/server/packages.js';

/** What a step that takes keys from a context bundle gets at run time: a per-field manifest, and the same retrieval query. */
const WS = 'ws-bundles';
const PROFILE = 'model: {provider: scripted}\ninstructions: Review.\nscript:\n  - {output: {ok: true}}\n';

function context() {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-bundles-'));
  const ctx = { settings: { ...settings() }, artifacts: fsArtifactStore(dir) } as unknown as AppContext;
  const hash = `sha256:${sha256(`bundles-${Math.random()}`)}`;
  const bytes = Buffer.from(PROFILE);
  stagePackage(ctx, WS, hash, { format: 'azhi-package/1', workflow: 'workflow.yaml', files: [{ path: 'profiles/reviewer@1.yaml', sha256: sha256(bytes), size: bytes.length }] }, new Map([['profiles/reviewer@1.yaml', bytes]]));
  return { ctx, hash };
}

const begin = (hash: string, input: unknown, extra: Partial<AgentBeginInput> = {}): AgentBeginInput => ({
  runId: 'r1',
  workspaceId: WS,
  nodeId: 'review',
  packageHash: hash,
  profile: 'reviewer@1',
  outputSchema: { type: 'object' },
  tools: [],
  input,
  inputSources: ['intake', 'plan'],
  ...extra,
});

const transcript = (ctx: AppContext, state: { transcript: string }) => JSON.parse(ctx.artifacts.get(state.transcript)!.toString('utf8')) as { items: Array<Record<string, any>>; messages: any[] };
const inputs = (ctx: AppContext, state: { transcript: string }) => transcript(ctx, state).items.filter((i) => i.kind === 'input');

describe('manifest for a step that uses a context', () => {
  const input = { title: 'T-1', items: [1, 2, 3], mine: 'own' };
  const parts = [
    { key: 'title', source: 'context:brief' },
    { key: 'items', source: 'context:brief' },
    { key: 'mine', source: 'input' },
  ];

  it('has one input item per key, saying where it came from', async () => {
    const { ctx, hash } = context();
    const state = await agentBegin(ctx, begin(hash, input, { inputParts: parts }), { transcript: false });
    const items = inputs(ctx, state);
    expect(items.map((i) => i.source)).toEqual(['context:brief.title', 'context:brief.items', 'input.mine']);
    expect(items[0]).toMatchObject({ reason: "node input field 'title', from context 'brief'", content_hash: `sha256:${sha256(JSON.stringify('T-1'))}` });
    expect(items[2]!.reason).toBe("node input field 'mine'");
    // The model still gets the whole input in one block.
    expect(transcript(ctx, state).messages[0].content[0].text).toContain('"items"');
  });

  it('keeps the single item, byte for byte, when the step uses no context', async () => {
    const { ctx, hash } = context();
    const state = await agentBegin(ctx, begin(hash, input), { transcript: false });
    const items = inputs(ctx, state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'nodes.intake, nodes.plan', reason: 'node input' });
  });

  it('leaves a withheld key to its own item, with no content', async () => {
    const { ctx, hash } = context();
    const state = await agentBegin(ctx, begin(hash, { ...input, items: 'x'.repeat(5000) }, { inputParts: parts, contextBudget: { max_item_bytes: 1000, on_exceed: 'withhold' } }), { transcript: false });
    const sources = inputs(ctx, state).map((i) => i.source);
    expect(sources).toEqual(['context:brief.title', 'input.mine', 'input.items']);
    expect(inputs(ctx, state).find((i) => i.source === 'input.items')!.reason).toContain('withheld by context_budget');
  });
});

describe('retrieval query', () => {
  const value = { question: 'how do I rotate keys', title: 'T-1', items: ['a', 'b'] };

  it('is the whole input for a step with no context, as before', () => {
    expect(queryInput({ input: value })).toBe(value);
  });

  it('is built from the step\'s own keys only, so adding a bundle does not change what it retrieves', () => {
    const without = queryInput({ input: { question: value.question } });
    const withBundle = queryInput({
      input: value,
      inputParts: [
        { key: 'title', source: 'context:brief' },
        { key: 'items', source: 'context:brief' },
        { key: 'question', source: 'input' },
      ],
    });
    expect(withBundle).toEqual(without);
  });

  it('falls back to every key when the step wrote none of its own', () => {
    const only = { title: 'T-1', items: [1] };
    expect(queryInput({ input: only, inputParts: [{ key: 'title', source: 'context:brief' }, { key: 'items', source: 'context:brief' }] })).toBe(only);
  });

  it('leaves a non-object input alone', () => {
    expect(queryInput({ input: 'text', inputParts: [{ key: 'a', source: 'input' }] })).toBe('text');
    expect(queryInput({ input: null, inputParts: [{ key: 'a', source: 'input' }] })).toBeNull();
  });
});
