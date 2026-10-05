import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeAnthropic, type FakeStep } from '../src/testing/fake-anthropic.js';
import { startFakeOpenAIResponses } from '../src/testing/fake-openai-responses.js';
import { claudeAgentSdkVersion, codexBinary } from '../src/worker/capabilities.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * Conformance for the Claude Agent SDK and Codex adapters (spec section 9: each adapter has a
 * pinned harness version and a conformance run). Each harness runs for real against a scripted
 * endpoint (Anthropic Messages for Claude, OpenAI Responses for Codex), so no provider key is
 * needed; what is checked is the adapter's contract, not model quality.
 */
const up = await temporalAvailable();
const MODEL = 'conformance-model';

let script: FakeStep[] = [];
let delayMs = 0;

function pkg(executor: string, provider: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-harness-'));
  cpSync('test/fixtures/agent', dir, { recursive: true });
  writeFileSync(join(dir, 'profiles/analyst@1.yaml'), `model: {provider: ${provider}, name: default}\ninstructions: Explain the CI runs in one sentence.\n`);
  const wf = join(dir, 'workflow.yaml');
  writeFileSync(wf, readFileSync(wf, 'utf8').replace('    profile: analyst@1\n', `    profile: analyst@1\n    executor: ${executor}\n`));
  return dir;
}

interface Fake {
  url: string;
  close(): Promise<void>;
  /** Tool names offered in each request to our model. */
  offered(): string[][];
  /** Text of everything sent to the model, per request. */
  sent(): string[];
  count(): number;
}

const suites = [
  {
    executor: 'claude-agent-sdk',
    provider: 'anthropic',
    available: () => Boolean(claudeAgentSdkVersion()),
    start: async (): Promise<Fake> => {
      const f = await startFakeAnthropic({ script: () => script, get delayMs() { return delayMs; } } as never);
      const ours = () => f.requests.filter((r) => r.model === MODEL);
      return { url: f.url, close: f.close, offered: () => ours().map((r) => r.tools), sent: () => ours().map((r) => r.system + JSON.stringify(r.messages)), count: () => ours().length };
    },
    settings: (url: string) => ({ anthropicApiUrl: url, anthropicModel: MODEL }),
    secret: 'anthropic-api-key',
    ambient: 'none' as const,
  },
  {
    executor: 'codex',
    provider: 'openai',
    // Skipped: Codex 0.160 defers MCP tools behind a model-driven tool_search step that a scripted
    // Responses endpoint does not play, so this suite cannot pass until the fake does (or a live key is used).
    available: () => process.env.AZHI_EXPERIMENTAL_CODEX === '1' && Boolean(codexBinary()),
    start: async (): Promise<Fake> => {
      const f = await startFakeOpenAIResponses({ script: () => script, get delayMs() { return delayMs; } } as never);
      const ours = () => f.requests.filter((r) => r.model === MODEL);
      return { url: f.url, close: f.close, offered: () => ours().map((r) => r.tools), sent: () => ours().map((r) => r.instructions + JSON.stringify(r.body.input)), count: () => ours().length };
    },
    settings: (url: string) => ({ openaiApiUrl: url, openaiModel: MODEL }),
    secret: 'openai-api-key',
    ambient: 'uncontrolled' as const,
  },
];

for (const s of suites) {
  describe.skipIf(!up || !s.available())(`${s.executor} adapter conformance`, () => {
    let h: Harness;
    let fake: Fake;
    let version: string;

    beforeAll(async () => {
      fake = await s.start();
      h = await startHarness({ settings: s.settings(fake.url) as never });
      for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
      await h.api.put(`/v1/secrets/${s.secret}`, { value: 'sk-conformance' });
      version = (await uploadDir(h.api, pkg(s.executor, s.provider))).version.id;
    });
    afterAll(async () => {
      await h?.stop();
      await fake?.close();
    });

    it('plans the executor honestly', async () => {
      const plan = await h.api.get<any>(`/v1/versions/${version}/plan`);
      const node = plan.nodes.find((n: any) => n.id === 'explain');
      expect(node.executor).toBe(s.executor);
      expect(node.requirements).toContainEqual(expect.objectContaining({ name: 'gateway tools', mark: expect.stringMatching(/bridged|unverified/) }));
      expect(node.requirements).toContainEqual(expect.objectContaining({ name: `${s.executor} runtime on a worker`, mark: 'native' }));
      expect(node.requirements).toContainEqual(expect.objectContaining({ name: 'model binding', mark: 'native' }));
      expect(node.coverage).toContainEqual(expect.objectContaining({ action: 'ambient (built-in) tools', enforcement: s.ambient === 'none' ? 'harness' : 'unobservable' }));
      expect(plan.ok).toBe(true);
    });

    it('runs through the bridged gateway with validated output and usage', async () => {
      script = [
        { tool: 'ci_list-runs_1', input: { team: 'payments' } },
        { tool: 'submit_output', input: { summary: '1 of 4 runs failed (r3).', failed: 1 } },
        { text: 'done' },
      ];
      const before = fake.count();
      const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: {} });
      const d = await waitForRun(h.api, run_id, 120_000);
      expect(d.run.error).toBeNull();
      expect(d.run.state).toBe('succeeded');
      expect(d.attempts.find((a: any) => a.node_id === 'explain')).toMatchObject({ state: 'succeeded', output: { summary: '1 of 4 runs failed (r3).', failed: 1 } });

      const offered = fake.offered().slice(before);
      expect(offered.length).toBeGreaterThanOrEqual(2);
      // The gateway's tools reached the model through the bridge.
      expect(offered[0]!.some((t) => t.endsWith('ci_list-runs_1'))).toBe(true);
      expect(offered[0]!.some((t) => t.endsWith('submit_output'))).toBe(true);
      if (s.ambient === 'none') expect(offered[0]!.every((t) => t.includes('azhi'))).toBe(true);
      // The projected result of the tool call came back to the model, and the platform rules were sent.
      expect(fake.sent().slice(before).at(-1)).toMatch(/r3.*failure/);
      expect(fake.sent()[before]).toContain('Numbers in your input come from scripts and tools');

      expect(d.usage.records[0]).toMatchObject({ executor: expect.stringMatching(new RegExp(`^${s.executor}@`)), provider: s.provider });
      expect(d.usage.records[0].input_tokens).toBeGreaterThan(0);
      expect(d.usage.records[0].output_tokens).toBeGreaterThan(0);
      const m = d.context_manifests.find((x: any) => x.node_id === 'explain');
      expect(m.items.at(-1)).toMatchObject({ source: s.executor, content_hash: 'unobservable' });
      expect(h.slack.messages.at(-1)!.text).toBe('1 of 4 runs failed (r3).');
    });

    it('feeds schema failures back and fails after two repairs', async () => {
      script = [{ tool: 'submit_output', input: { wrong: true } }];
      const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: {} });
      const d = await waitForRun(h.api, run_id, 120_000);
      expect(d.run.state).toBe('failed');
      expect(d.run.error.class).toBe('contract_violation');
    });

    it('cancels a running harness (best effort) and stops its process', async () => {
      script = [{ tool: 'submit_output', input: { summary: 'late', failed: 0 } }];
      delayMs = 20_000;
      try {
        const before = fake.count();
        const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: {} });
        for (let i = 0; i < 300; i++) {
          const d = await h.api.get<any>(`/v1/runs/${run_id}`);
          if (d.attempts.some((a: any) => a.node_id === 'explain' && a.state === 'running') && fake.count() > before) break;
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
}
