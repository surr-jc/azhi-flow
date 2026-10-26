import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeAnthropic, type FakeStep } from '../src/testing/fake-anthropic.js';
import { opencodeBinary } from '../src/worker/capabilities.js';
import { dcpPlugin, opencode2Binary } from '../src/worker/tools.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * OpenCode conformance (spec section 9: each adapter has a pinned harness version and a
 * conformance run). OpenCode runs for real against a scripted Anthropic-compatible endpoint, so
 * the suite needs no provider key; what it checks is the adapter's contract, not model quality.
 * AZHI_OPENCODE_MAJOR=2 runs the same suite on the OpenCode 2 adapter.
 */
const two = process.env.AZHI_OPENCODE_MAJOR === '2';
const up = (await temporalAvailable()) && Boolean(two ? opencode2Binary() : opencodeBinary());
const MODEL = 'conformance-model';

let script: FakeStep[] = [];
let delayMs = 0;

function opencodePackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-oc-'));
  cpSync('test/fixtures/agent', dir, { recursive: true });
  writeFileSync(join(dir, 'profiles/analyst@1.yaml'), 'model: {provider: anthropic, name: default}\ninstructions: Explain the CI runs in one sentence.\n');
  const wf = join(dir, 'workflow.yaml');
  // A Windows checkout (core.autocrlf) has CRLF line ends; without a match the step silently runs on the model-agent.
  const yaml = readFileSync(wf, 'utf8').replace(/( {4}profile: analyst@1)(\r?\n)/, '$1$2    executor: opencode$2');
  if (!yaml.includes('executor: opencode')) throw new Error('could not switch the fixture step to OpenCode');
  writeFileSync(wf, yaml);
  return dir;
}

/** The same step with a profile harness: an agent file, a command run after the input, a skill, `read`, token saving. */
function harnessPackage(): string {
  const dir = opencodePackage();
  mkdirSync(join(dir, 'harness/agents'), { recursive: true });
  mkdirSync(join(dir, 'harness/commands'), { recursive: true });
  mkdirSync(join(dir, 'harness/skills/run-notes'), { recursive: true });
  writeFileSync(join(dir, 'harness/agents/analyst.md'), '---\ndescription: CI analyst\n---\nAGENT-BODY: read the runs before you explain them.\n');
  writeFileSync(join(dir, 'harness/commands/explain.md'), '---\ndescription: Explain the runs\n---\nCOMMAND-BODY: explain the runs above, then submit.\n');
  writeFileSync(join(dir, 'harness/skills/run-notes/SKILL.md'), '---\nname: run-notes\ndescription: How to read CI runs\n---\nFailures first.\n');
  writeFileSync(
    join(dir, 'profiles/analyst@1.yaml'),
    'model: {provider: anthropic, name: default}\ninstructions: Explain the CI runs in one sentence.\nharness:\n  opencode:\n    agent: harness/agents/analyst.md\n    command: harness/commands/explain.md\n    skills: [harness/skills/run-notes]\n    tools: [read]\n    token_saving: "on"\n',
  );
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

    // The run page's agent transcript: prompts, the tool call with its result, and the submitted output.
    const tx = await h.api.get<any>(`/v1/runs/${run_id}/transcript?node=explain`);
    const kinds = tx.entries.map((e: any) => e.kind);
    expect(kinds).toContain('system');
    expect(kinds).toContain('user');
    expect(kinds).toContain('step');
    const tool = tx.entries.find((e: any) => e.kind === 'tool' && e.tool === 'azhi_ci_list-runs_1');
    expect(tool).toMatchObject({ status: 'completed', input: { team: 'payments' }, attempt: 1 });
    expect(tool.output).toMatch(/r3/);
    expect(tx.entries.find((e: any) => e.kind === 'tool' && e.tool === 'azhi_submit_output')).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(tx.entries)).not.toContain('sk-conformance');
    // Polling with the cursor returns only what changed since.
    expect((await h.api.get<any>(`/v1/runs/${run_id}/transcript?after=${tx.cursor}`)).entries).toEqual([]);
  });

  it('feeds schema failures back and fails after two repairs', async () => {
    script = [{ tool: 'submit_output', input: { wrong: true } }];
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: {} });
    const d = await waitForRun(h.api, run_id, 120_000);
    expect(d.run.state).toBe('failed');
    expect(d.run.error.class).toBe('contract_violation');
  });

  it("runs a profile's agent and command, with only its read tool (and DCP's when installed) added", async () => {
    const harnessVersion = (await uploadDir(h.api, harnessPackage())).version.id;
    script = [
      { tool: 'submit_output', input: { summary: '1 of 4 runs failed (r3).', failed: 1 } },
      { text: 'done' },
    ];
    const before = ours().length;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: harnessVersion, inputs: {} });
    const d = await waitForRun(h.api, run_id, 120_000);
    expect(d.run.error).toBeNull();
    expect(d.attempts.find((a: any) => a.node_id === 'explain')).toMatchObject({ state: 'succeeded', output: { summary: '1 of 4 runs failed (r3).', failed: 1 } });
    const calls = ours().slice(before);
    // The agent file's body is in the system prompt; the input arrives as its own message, before the command's body.
    expect(calls[0]!.system).toContain('AGENT-BODY');
    const first = JSON.stringify(calls[0]!.messages);
    expect(first.indexOf('COMMAND-BODY')).toBeGreaterThan(first.indexOf('r3'));
    expect(calls[0]!.tools.sort()).toEqual(['azhi_ci_list-runs_1', 'azhi_submit_output', ...(dcpPlugin() ? ['compress'] : []), 'read'].sort());
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
