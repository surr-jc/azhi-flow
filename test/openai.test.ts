import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openaiProvider } from '../src/agents/providers.js';
import { startFakeOpenAI } from '../src/testing/fake-openai.js';
import type { FakeStep } from '../src/testing/fake-anthropic.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

describe('openai provider', () => {
  it('maps blocks to Chat Completions and back, with tool calls, tool results and usage', async () => {
    let seen: any;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { headers: req.headers, body: JSON.parse(body), url: req.url };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            model: 'o-test',
            choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'submit_output', arguments: '{"summary":"ok"}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const p = openaiProvider({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'k' });
      const r = await p.complete({
        model: 'o-test',
        system: 'sys',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'ci_list-runs_1', input: { team: 'x' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '[]', is_error: true }] },
        ],
        tools: [{ name: 'ci_list-runs_1', description: 'd', input_schema: { type: 'object' } }],
        maxTokens: 50,
      });
      expect(seen.url).toBe('/v1/chat/completions');
      expect(seen.headers.authorization).toBe('Bearer k');
      expect(seen.body.max_completion_tokens).toBe(50);
      expect(seen.body.tools[0]).toEqual({ type: 'function', function: { name: 'ci_list-runs_1', description: 'd', parameters: { type: 'object' } } });
      expect(seen.body.messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ci_list-runs_1', arguments: '{"team":"x"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ERROR: []' },
      ]);
      expect(r.stop).toBe('tool_use');
      expect(r.content).toEqual([{ type: 'tool_use', id: 'c2', name: 'submit_output', input: { summary: 'ok' } }]);
      expect(r.usage).toEqual({ input_tokens: 120, output_tokens: 30, cache_read_tokens: 100, cache_write_tokens: null, reasoning_tokens: null });
    } finally {
      server.close();
    }
  });
});

const up = await temporalAvailable();
let script: FakeStep[] = [];

function openaiPackage(profile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-openai-'));
  cpSync('test/fixtures/agent', dir, { recursive: true });
  writeFileSync(join(dir, 'profiles/analyst@1.yaml'), profile);
  return dir;
}

describe.skipIf(!up)('model agent on OpenAI', () => {
  let h: Harness;
  let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
  beforeAll(async () => {
    fake = await startFakeOpenAI({ script: () => script });
    h = await startHarness({ worker: false, settings: { openaiApiUrl: fake.url, openaiModel: 'openai-test-model' } });
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
  });
  afterAll(async () => {
    await h?.stop();
    await fake?.close();
  });

  it('plans the binding and the openai credential, then runs the tool loop with repair', async () => {
    const v = (await uploadDir(h.api, openaiPackage('model: {provider: openai, name: default}\ninstructions: Explain.\npricing: {currency: USD, input_per_mtok: 2, output_per_mtok: 8, revision: test}\n'))).version.id;
    let plan = await h.api.get<any>(`/v1/versions/${v}/plan`);
    let explain = plan.nodes.find((n: any) => n.id === 'explain');
    expect(explain.requirements).toContainEqual(expect.objectContaining({ name: 'model binding', mark: 'native', detail: 'openai openai-test-model (server default)' }));
    expect(plan.missing_grants).toContainEqual({ kind: 'secret', name: 'openai-api-key', node: 'explain' });

    await h.api.put('/v1/secrets/openai-api-key', { value: 'sk-test' });
    plan = await h.api.get<any>(`/v1/versions/${v}/plan`);
    expect(plan.ok).toBe(true);

    script = [
      { tool: 'ci_list-runs_1', input: { team: 'payments' } },
      { tool: 'submit_output', input: { summary: 'missing failed' } },
      { tool: 'submit_output', input: { summary: '1 of 4 runs failed (r3).', failed: 1 } },
    ];
    const before = fake.requests.length;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v, inputs: {} });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.error).toBeNull();
    expect(d.attempts.find((a: any) => a.node_id === 'explain').output).toEqual({ summary: '1 of 4 runs failed (r3).', failed: 1 });
    const calls = fake.requests.slice(before);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.model).toBe('openai-test-model');
    expect(calls[0]!.tools.sort()).toEqual(['ci_list-runs_1', 'submit_output']);
    expect(calls[1]!.messages.some((m) => m.role === 'tool' && /r3/.test(m.content))).toBe(true);
    expect(calls[2]!.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('contract_violation') });
    expect(d.usage).toMatchObject({ turns: 3, completeness_pct: 100, input_tokens: 300, output_tokens: 60, cost: { label: 'estimated' } });
    expect(d.usage.records[0]).toMatchObject({ provider: 'openai', model: 'openai-test-model' });
  });

  it('marks an OpenAI profile unsupported on the OpenCode executor', async () => {
    const dir = openaiPackage('model: {provider: openai, name: default}\ninstructions: Explain.\n');
    const wf = join(dir, 'workflow.yaml');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace('    profile: analyst@1\n', '    profile: analyst@1\n    executor: opencode\n'));
    const plan = await h.api.get<any>(`/v1/versions/${(await uploadDir(h.api, dir)).version.id}/plan`);
    const explain = plan.nodes.find((n: any) => n.id === 'explain');
    expect(explain.requirements).toContainEqual(expect.objectContaining({ name: 'model binding', mark: 'unsupported' }));
    expect(plan.ok).toBe(false);
  });
});
