import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

const up = await temporalAvailable();

/** A copy of the agent fixture with its profile script (and optionally the workflow) replaced. */
function variant(script: unknown[], edit: (wf: string) => string = (w) => w): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-agent-'));
  cpSync('test/fixtures/agent', dir, { recursive: true });
  const profile = join(dir, 'profiles/analyst@1.yaml');
  const p = parse(readFileSync(profile, 'utf8'));
  writeFileSync(profile, JSON.stringify({ ...p, script }));
  writeFileSync(join(dir, 'workflow.yaml'), edit(readFileSync(join(dir, 'workflow.yaml'), 'utf8')));
  return dir;
}

async function run(h: Harness, dir: string) {
  const v = (await uploadDir(h.api, dir)).version.id;
  const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v, inputs: {} });
  return waitForRun(h.api, run_id);
}

describe.skipIf(!up)('model agent', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ worker: false });
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
  });
  afterAll(async () => h?.stop());

  it('runs the tool loop, repairs invalid output, and records usage and context manifests', async () => {
    const d = await run(h, 'test/fixtures/agent');
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    expect(d.attempts.find((a: any) => a.node_id === 'explain').output).toEqual({ summary: '1 of 4 runs failed (r3).', failed: 1 });
    expect(h.slack.messages.map((m) => m.text)).toContain('1 of 4 runs failed (r3).');

    expect(d.usage.turns).toBe(3);
    expect(d.usage.completeness_pct).toBe(100);
    expect(d.usage.input_tokens).toBe(300);
    expect(d.usage.cost).toMatchObject({ label: 'estimated', currency: 'USD', pricing_revision: 'test-2026-10' });
    expect(d.usage.cost.amount).toBeCloseTo((300 * 1 + 60 * 5) / 1e6, 9);

    const last = d.context_manifests.filter((m: any) => m.node_id === 'explain').at(-1);
    const kinds = last.items.map((i: any) => i.kind);
    expect(kinds).toEqual(['instructions', 'profile', 'tool_schema', 'output_schema', 'input', 'tool_result', 'repair']);
    expect(last.items.find((i: any) => i.kind === 'profile').source).toBe('profiles/analyst@1.yaml');
    expect(last.items.find((i: any) => i.kind === 'input').source).toBe('nodes.fetch');
    expect(last.items.every((i: any) => i.content === undefined && i.content_hash.startsWith('sha256:'))).toBe(true);
    expect(last.token_source).toBe('reported');
    expect(last.tainted).toBe(true); // ci.list-runs output is not marked trusted
  });

  it('plans the model binding and refuses a run with no provider credential', async () => {
    const dir = variant([]);
    writeFileSync(join(dir, 'profiles/analyst@1.yaml'), 'model: {provider: anthropic, name: default}\ninstructions: Explain.\n');
    const v = (await uploadDir(h.api, dir)).version.id;
    const plan = await h.api.get<any>(`/v1/versions/${v}/plan`);
    const explain = plan.nodes.find((n: any) => n.id === 'explain');
    expect(explain.requirements.map((r: any) => [r.name, r.mark])).toEqual(
      expect.arrayContaining([
        ['model binding', 'unsupported'],
        ['credential anthropic-api-key', 'unsupported'],
        ['gateway tools', 'native'],
      ]),
    );
    expect(explain.coverage.map((c: any) => c.enforcement)).toEqual(['enforced', 'enforced']);
    expect(plan.missing_grants).toContainEqual({ kind: 'secret', name: 'anthropic-api-key', node: 'explain' });
    await expect(h.api.post('/v1/runs', { version: v, inputs: {} })).rejects.toThrow(/blocker/);
  });

  it('marks usage incomplete when the executor does not report it (null, never zero)', async () => {
    const d = await run(h, variant([{ output: { summary: 'ok', failed: 1 }, usage: null }]));
    expect(d.run.state).toBe('succeeded');
    expect(d.run.flags.usage_incomplete).toBe(true);
    expect(d.usage.completeness_pct).toBe(0);
    expect(d.usage.input_tokens).toBeNull();
    expect(d.usage.cost.label).toBe('unavailable');
    expect(d.usage.records[0].input_tokens).toBeNull();
  });

  it('fails with contract_violation after two repair attempts', async () => {
    const d = await run(h, variant([{ output: { wrong: true } }]));
    expect(d.run.state).toBe('failed');
    expect(d.run.error.class).toBe('contract_violation');
    expect(d.attempts.find((a: any) => a.node_id === 'explain').state).toBe('failed');
    expect(d.usage.turns).toBe(3);
  });

  it('enforces the tool-call budget', async () => {
    const d = await run(h, variant([{ tool: 'ci.list-runs@1', args: { team: 'payments' } }], (w) => w.replace('max_tool_calls: 3', 'max_tool_calls: 1')));
    expect(d.run.state).toBe('failed');
    expect(d.run.error.class).toBe('budget_exceeded');
  });

  it('stops repeated identical failing tool calls after two corrections', async () => {
    const d = await run(h, variant([{ tool: 'ci.list-runs@1', args: { bogus: 1 } }]));
    expect(d.run.state).toBe('failed');
    expect(d.run.error.class).toBe('contract_violation');
    expect(d.run.error.message).toMatch(/repeated a failing call/);
  });
});
