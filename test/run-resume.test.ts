import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * A failed run can be resumed as a new run: steps that succeeded are carried over with their outputs
 * and not run again; the failed step and what comes after it run.
 */
const FIRST = 'import json\nprint(json.dumps({"n": 1}))\n';
const FLAKY = 'import json, os, sys\nd = json.load(sys.stdin)\nif os.path.exists(d["block"]):\n    sys.exit("blocked")\nprint(json.dumps({"n": d["n"] + 1}))\n';
const LAST = 'import json, sys\nd = json.load(sys.stdin)\nprint(json.dumps({"n": d["n"] * 10}))\n';
const workflow = `schema_version: "2.0"
id: resumable
inputs:
  type: object
  properties: {block: {type: string}}
nodes:
  - id: first
    type: script
    runtime: python
    entrypoint: scripts/first.py
    output_schema: {type: object, properties: {n: {type: integer}}, required: [n]}
  - id: flaky
    type: script
    runtime: python
    entrypoint: scripts/flaky.py
    retry: {max_attempts: 1}
    input: {map: "{'n': nodes.first.output.n, 'block': inputs.block}"}
    output_schema: {type: object, properties: {n: {type: integer}}, required: [n]}
  - id: last
    type: script
    runtime: python
    entrypoint: scripts/last.py
    input: {ref: nodes.flaky.output}
    output_schema: {type: object, properties: {n: {type: integer}}, required: [n]}
`;

// A script step takes a while to start on a cold worker.
const SLOW = 240_000;
const up = await temporalAvailable();

describe.skipIf(!up)('resuming a failed run', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h?.stop());

  it('carries the steps that succeeded and runs the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-resume-'));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'workflow.yaml'), workflow);
    writeFileSync(join(dir, 'scripts/first.py'), FIRST);
    writeFileSync(join(dir, 'scripts/flaky.py'), FLAKY);
    writeFileSync(join(dir, 'scripts/last.py'), LAST);
    const block = join(dir, 'block');
    writeFileSync(block, '');
    const v = await uploadDir(h.api, dir);
    expect(v.ok).toBe(true);

    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs: { block } });
    const failed = await waitForRun(h.api, run_id, SLOW);
    expect(failed.run.state).toBe('failed');
    await expect(h.api.post(`/v1/runs/${run_id}/resume`, { from_node: 'nope' })).rejects.toThrow();

    rmSync(block);
    const r = await h.api.post<{ run_id: string; carried: string[]; rerun: string[] }>(`/v1/runs/${run_id}/resume`, {});
    expect(r.carried).toEqual(['first']);
    expect(r.rerun).toEqual(['flaky', 'last']);
    const done = await waitForRun(h.api, r.run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    const out = (id: string) => done.attempts.find((a: any) => a.node_id === id && a.state === 'succeeded');
    expect(out('first')).toMatchObject({ output: { n: 1 }, worker_id: null });
    expect(out('last').output).toEqual({ n: 20 });
    expect(done.run.snapshot.resume).toEqual({ from_run: run_id, nodes: ['first'] });

    // Resuming a run that succeeded is refused; resuming from a step reruns it and what follows.
    await expect(h.api.post(`/v1/runs/${r.run_id}/resume`, {})).rejects.toThrow();
  }, 600_000);

  it('reruns from a chosen step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-resume-'));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'workflow.yaml'), workflow.replace('id: resumable', 'id: resumable-from'));
    writeFileSync(join(dir, 'scripts/first.py'), FIRST);
    writeFileSync(join(dir, 'scripts/flaky.py'), FLAKY);
    writeFileSync(join(dir, 'scripts/last.py'), LAST);
    const block = join(dir, 'block');
    writeFileSync(block, '');
    const v = await uploadDir(h.api, dir);
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs: { block } });
    await waitForRun(h.api, run_id, SLOW);
    const r = await h.api.post<{ carried: string[]; rerun: string[] }>(`/v1/runs/${run_id}/resume`, { from_node: 'first' });
    expect(r.carried).toEqual([]);
    expect(r.rerun).toEqual(['first', 'flaky', 'last']);
  }, 300_000);
});
