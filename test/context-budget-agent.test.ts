import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentBegin, harnessPrepare, type AgentBeginInput } from '../src/agents/model-agent.js';
import { fsArtifactStore } from '../src/artifacts/store.js';
import { settings } from '../src/config/settings.js';
import { sha256 } from '../src/lib/hash.js';
import type { AppContext } from '../src/server/context.js';
import { stagePackage } from '../src/server/packages.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { compile } from '../src/compiler/compile.js';

/**
 * agentBegin with a context_budget, without a database or Temporal: the profile comes from a staged
 * package and the transcript step is skipped, which is how harness executors call it too.
 */
const PROFILE = 'model: {provider: scripted}\ninstructions: Review the change.\nscript:\n  - {output: {ok: true}}\n';
const WS = 'ws-budget';

function context(over: Partial<ReturnType<typeof settings>> = {}): { ctx: AppContext; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-budget-'));
  const ctx = { settings: { ...settings(), ...over }, artifacts: fsArtifactStore(dir) } as unknown as AppContext;
  const hash = `sha256:${sha256(`budget-${Math.random()}`)}`;
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
  inputSources: ['change'],
  ...extra,
});

const manifestOf = (ctx: AppContext, state: { transcript: string }) => JSON.parse(ctx.artifacts.get(state.transcript)!.toString('utf8')) as { items: Array<Record<string, any>>; messages: any[] };

describe('agentBegin with a context_budget', () => {
  const input = { ticket: 'short', diff: 'd'.repeat(4000) };

  it('without a budget the prompt and the manifest are as before', async () => {
    const { ctx, hash } = context();
    const state = await agentBegin(ctx, begin(hash, input), { transcript: false });
    const t = manifestOf(ctx, state);
    expect(state.withheld).toBeUndefined();
    expect(t.items.filter((i) => i.kind === 'input')).toHaveLength(1);
    expect(t.messages[0].content[0].text).toContain('d'.repeat(4000));
  });

  it('fails with budget_exceeded by default, before any model call', async () => {
    const { ctx, hash } = context();
    await expect(agentBegin(ctx, begin(hash, input, { contextBudget: { max_item_bytes: 1000 } }), { transcript: false })).rejects.toMatchObject({ errorClass: 'budget_exceeded', message: expect.stringContaining("node 'review' input field 'diff'") });
  });

  it('withholds the field: the prompt lacks it, the manifest records hash and size, nothing is stored', async () => {
    const { ctx, hash } = context({ storeContextContent: true });
    const state = await agentBegin(ctx, begin(hash, input, { contextBudget: { max_item_bytes: 1000, on_exceed: 'withhold' } }), { transcript: false });
    const t = manifestOf(ctx, state);
    const text: string = t.messages[0].content[0].text;
    expect(text).not.toContain('dddd');
    expect(text).toContain('you cannot read it');
    expect(state.withheld).toEqual([{ key: 'diff', bytes: 4002, sha256: sha256(JSON.stringify(input.diff)) }]);
    const item = t.items.find((i) => i.source === 'input.diff')!;
    expect(item).toMatchObject({ kind: 'input', tokens: 0, content_hash: `sha256:${sha256(JSON.stringify(input.diff))}` });
    // Even with content storage on, the withheld value is not kept in the manifest.
    expect(item.content).toBeUndefined();
    expect(JSON.stringify(t.items)).not.toContain('dddd');
  });

  it('measures after artifact handles are expanded', async () => {
    const { ctx, hash } = context();
    const stored = ctx.artifacts.put(JSON.stringify('d'.repeat(4000)));
    const handle = { $artifact: { hash: stored.hash } };
    await expect(agentBegin(ctx, begin(hash, { diff: handle }, { contextBudget: { max_item_bytes: 1000 } }), { transcript: false })).rejects.toMatchObject({ errorClass: 'budget_exceeded' });
  });

  it('applies the server default, and a node limit overrides it key by key', async () => {
    const { ctx, hash } = context({ contextBudget: { maxItemBytes: 1000, maxInputBytes: undefined } });
    await expect(agentBegin(ctx, begin(hash, input), { transcript: false })).rejects.toMatchObject({ errorClass: 'budget_exceeded' });
    const ok = await agentBegin(ctx, begin(hash, input, { contextBudget: { max_item_bytes: 8000 } }), { transcript: false });
    expect(ok.withheld).toBeUndefined();
  });

  it('reaches harness executors through harnessPrepare', async () => {
    const { ctx, hash } = context();
    // The scripted provider is refused for harnesses, but the cap is applied first, so a breach surfaces as budget_exceeded.
    await expect(harnessPrepare(ctx, begin(hash, input, { contextBudget: { max_item_bytes: 1000 } }), 'opencode')).rejects.toMatchObject({ errorClass: 'budget_exceeded' });
  });
});

describe('context_budget in a workflow definition', () => {
  const wf = (budget: string) => `
schema_version: "2.0"
id: cap
nodes:
  - id: review
    type: agent
    profile: reviewer@1
    output_schema: {type: object}
    context_budget: ${budget}
`;
  it('accepts the three keys and compiles to an unchanged plan node shape', () => {
    const r = loadDefinitionText(wf('{max_item_bytes: 4096, max_input_bytes: 65536, on_exceed: withhold}'));
    expect(r.diagnostics).toEqual([]);
    expect(compile(r.definition!).plan?.nodes[0]?.def).toMatchObject({ context_budget: { max_item_bytes: 4096, max_input_bytes: 65536, on_exceed: 'withhold' } });
  });

  it('rejects unknown keys, tiny limits, an empty block and a bad mode', () => {
    for (const bad of ['{max_tokens: 5}', '{max_item_bytes: 10}', '{max_input_bytes: 100}', '{}', '{on_exceed: truncate}']) {
      const d = loadDefinitionText(wf(bad)).diagnostics;
      expect(d.length, bad).toBeGreaterThan(0);
      // Rejected for the budget itself, not for something else in the document.
      expect(d.every((x) => /context_budget/.test(`${x.path ?? ''} ${x.message}`)), `${bad}: ${JSON.stringify(d)}`).toBe(true);
    }
  });
});
