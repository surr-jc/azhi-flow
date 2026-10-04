import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

const up = await temporalAvailable();

describe.skipIf(!up)('test-node', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
  });
  afterAll(async () => h?.stop());

  it('runs one script node on fixture inputs and runs nothing else', async () => {
    const v = (await uploadDir(h.api, 'examples/ci-digest')).version.id;
    const runs = [
      { id: 'a', status: 'success', duration_s: 10 },
      { id: 'b', status: 'failure', duration_s: 20 },
    ];
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v, inputs: { team: 'x' }, test: true, node: 'metrics', fixtures: { fetch: runs } });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.state).toBe('succeeded');
    expect(d.run.trigger).toBe('test');
    expect(d.attempts.find((a: any) => a.node_id === 'metrics').output).toMatchObject({ runs: 2, passed: 1, pass_rate: 0.5 });
    expect(d.attempts.find((a: any) => a.node_id === 'post').state).toBe('skipped');
    expect(d.actions).toHaveLength(0);
  });

  it('mocks the write of a notify node', async () => {
    const v = (await uploadDir(h.api, 'examples/ci-digest')).version.id;
    const before = h.slack.messages.length;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v, inputs: { team: 'x' }, test: true, node: 'post', fixtures: { report: { markdown: 'hello' } } });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.state).toBe('succeeded');
    expect(h.slack.messages.length).toBe(before);
  });

  it('requires fixtures for every data dependency and test mode', async () => {
    const v = (await uploadDir(h.api, 'examples/ci-digest')).version.id;
    await expect(h.api.post('/v1/runs', { version: v, inputs: { team: 'x' }, test: true, node: 'metrics', fixtures: {} })).rejects.toThrow(/nodes\.fetch/);
    await expect(h.api.post('/v1/runs', { version: v, inputs: { team: 'x' }, node: 'metrics', fixtures: {} })).rejects.toThrow(/test: true/);
  });
});
