import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeAnthropic, type FakeStep } from '../src/testing/fake-anthropic.js';
import { opencodeBinary } from '../src/worker/capabilities.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * OpenCode conformance (spec section 9: each adapter has a pinned harness version and a
 * conformance run). OpenCode runs for real against a scripted Anthropic-compatible endpoint, so
 * the suite needs no provider key; what it checks is the adapter's contract, not model quality.
 */
const up = (await temporalAvailable()) && Boolean(opencodeBinary());
const MODEL = 'conformance-model';

let script: FakeStep[] = [];
let delayMs = 0;

function opencodePackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-oc-'));
  cpSync('test/fixtures/agent', dir, { recursive: true });
  writeFileSync(join(dir, 'profiles/analyst@1.yaml'), 'model: {provider: anthropic, name: default}\ninstructions: Explain the CI runs in one sentence.\n');
  const wf = join(dir, 'workflow.yaml');
  writeFileSync(wf, readFileSync(wf, 'utf8').replace('    profile: analyst@1\n', '    profile: analyst@1\n    executor: opencode\n'));
  return dir;
}

describe.skipIf(!up)('OpenCode adapter conformance', () => {
  let h: Harness;
  let fake: Awaited<ReturnType<typeof startFakeAnthropic>>;
  let version: string;
  const ours = () => fake.requests.filter((r) => r.model === MODEL);

  beforeAll(async () => {
    fake = await startFakeAnthropic({ script: () => script, get delayMs() { return delayMs; } } as never);
    h = await startHarness({ settings: { anthropicApiUrl: fake.url, anthropicModel: MODEL } });
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    await h.api.put('/v1/secrets/anthropic-api-key', { value: 'sk-conformance' });
    version = (await uploadDir(h.api, opencodePackage())).version.id;
  });
  afterAll(async () => {
    await h?.stop();
    await fake?.close();
  });

  it('plans OpenCode honestly: bridged gateway, restrictable ambient tools, unverified fields', async () => {
    const plan = await h.api.get<any>(`/v1/versions/${version}/plan`);
    const node = plan.nodes.find((n: any) => n.id === 'explain');
    expect(node.executor).toBe('opencode');
    expect(node.requirements).toContainEqual(expect.objectContaining({ name: 'gateway tools', mark: 'bridged' }));
    expect(node.requirements).toContainEqual(expect.objectContaining({ name: 'opencode runtime on a worker', mark: 'native' }));
    expect(node.coverage).toContainEqual(expect.objectContaining({ action: 'ambient (built-in) tools', enforcement: 'harness' }));
    expect(plan.ok).toBe(true);
  });

  it('runs through the bridged gateway with only gateway tools offered, validated output and usage', async () => {
    script = [
      { tool: 'ci_list-runs_1', input: { team: 'payments' } },
      { tool: 'submit_output', input: { summary: '1 of 4 runs failed (r3).', failed: 1 } },
      { text: 'done' },
    ];
    const before = ours().length;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: {} });
    const d = await waitForRun(h.api, run_id, 120_000);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    expect(d.attempts.find((a: any) => a.node_id === 'explain')).toMatchObject({ state: 'succeeded', output: { summary: '1 of 4 runs failed (r3).', failed: 1 } });

    const calls = ours().slice(before);
    // Ambient tools: the model was offered the gateway's tools and nothing else.
    for (const c of calls) expect(c.tools.every((t) => t.startsWith('azhi_'))).toBe(true);
    expect(calls[0]!.tools.sort()).toEqual(['azhi_ci_list-runs_1', 'azhi_submit_output']);
    // The tool call went through the gateway and its projected result came back to the model.
    expect(JSON.stringify(calls[1]!.messages)).toMatch(/r3.*failure/);
    expect(calls[0]!.system).toContain('Numbers in your input come from scripts and tools');

    expect(d.usage.records[0]).toMatchObject({ executor: expect.stringMatching(/^opencode@/), input_tokens: 100 * calls.length, output_tokens: 20 * calls.length });
    expect(d.run.flags.usage_incomplete).toBe(true);
    const m = d.context_manifests.find((x: any) => x.node_id === 'explain');
    expect(m.items.at(-1)).toMatchObject({ source: 'opencode', content_hash: 'unobservable' });
    expect(h.slack.messages.at(-1)!.text).toBe('1 of 4 runs failed (r3).');
  });

  it('feeds schema failures back and fails after two repairs', async () => {
    script = [{ tool: 'submit_output', input: { wrong: true } }];
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: {} });
    const d = await waitForRun(h.api, run_id, 120_000);
    expect(d.run.state).toBe('failed');
    expect(d.run.error.class).toBe('contract_violation');
  });

  it('cancels a running harness (best effort) and stops OpenCode', async () => {
    script = [{ tool: 'submit_output', input: { summary: 'late', failed: 0 } }];
    delayMs = 20_000;
    try {
      const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: {} });
      for (let i = 0; i < 200; i++) {
        const d = await h.api.get<any>(`/v1/runs/${run_id}`);
        if (d.attempts.some((a: any) => a.node_id === 'explain' && a.state === 'running') && ours().some((r) => r.messages.length === 1)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await h.api.post(`/v1/runs/${run_id}/cancel`);
      const d = await waitForRun(h.api, run_id, 60_000);
      expect(d.run.state).toBe('cancelled');
    } finally {
      delayMs = 0;
    }
  });
});
