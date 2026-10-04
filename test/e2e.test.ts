import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

const up = await temporalAvailable();

describe.skipIf(!up)('end to end: tool -> script -> report -> notify', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    const config = parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8'));
    for (const t of config.tools) await h.api.post('/v1/tools', t);
  });
  afterAll(async () => h?.stop());

  it('runs the workflow durably and delivers exactly one Slack message', async () => {
    const up = await uploadDir(h.api, 'examples/ci-digest');
    expect(up.ok).toBe(true);
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: up.version.id, inputs: { team: 'payments' } });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');

    const metrics = d.attempts.find((a: any) => a.node_id === 'metrics' && a.state === 'succeeded');
    expect(metrics.output).toMatchObject({ runs: 4, passed: 3, pass_rate: 0.75 });

    expect(h.slack.messages).toHaveLength(1);
    expect(h.slack.messages[0]!.text).toContain('3 of 4 runs passed (75%)');
    expect(h.slack.messages[0]!.text).toMatch(/ci data as of \d{4}-/);

    expect(d.actions).toHaveLength(1);
    expect(d.actions[0].state).toBe('confirmed');
    expect(d.actions[0].transitions.map((t: any) => t.state)).toEqual(['planned', 'dispatched', 'confirmed']);
  });

  it('rejects inputs that do not match the input schema', async () => {
    const up = await uploadDir(h.api, 'examples/ci-digest');
    await expect(h.api.post('/v1/runs', { version: up.version.id, inputs: {} })).rejects.toThrow(/input schema/);
  });

  it('cancels a running run', async () => {
    const up = await uploadDir(h.api, 'examples/ci-digest');
    await h.worker!.stop(); // no worker: the run waits at the script node
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: up.version.id, inputs: { team: 'payments' } });
    for (let i = 0; i < 100; i++) {
      const d = await h.api.get<any>(`/v1/runs/${run_id}`);
      if (d.run.state === 'waiting') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    // Heartbeats stop, but the worker row stays fresh for up to 30 s; either way the run must cancel.
    await h.api.post(`/v1/runs/${run_id}/cancel`);
    const d = await waitForRun(h.api, run_id);
    expect(d.run.state).toBe('cancelled');
  });
});
