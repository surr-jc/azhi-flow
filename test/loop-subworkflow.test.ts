import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * Loop and subworkflow nodes: the compiler's checks, and runs against Temporal. A loop repeats a
 * script step until its exit condition holds; a subworkflow runs a published workflow as a child
 * run of its own and hands back its outputs.
 */
const INC = 'import json, sys\nd = json.load(sys.stdin)\nprint(json.dumps({"n": d["n"] + 1}))\n';
const DOUBLE = 'import json, sys\nd = json.load(sys.stdin)\nprint(json.dumps({"doubled": d["x"] * 2}))\n';

function pkg(workflow: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-loop-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'workflow.yaml'), workflow);
  for (const [p, t] of Object.entries(files)) writeFileSync(join(dir, p), t);
  return dir;
}

const loopWorkflow = (extra = '', max = 5) => `schema_version: "2.0"
id: counter
nodes:
  - id: count
    type: loop
    initial: {n: 0}
    max_iterations: ${max}
    exit: "state.n >= 3"${extra}
    node:
      type: script
      runtime: python
      entrypoint: scripts/inc.py
      input: {map: "{'n': state.n}"}
      output_schema: {type: object, properties: {n: {type: integer}}, required: [n]}
`;

describe('compiling loops and subworkflows', () => {
  const compileText = (t: string) => compile(loadDefinitionText(t).definition!);
  it('accepts a loop and types its output', () => {
    const r = compileText(`${loopWorkflow()}  - id: after
    type: script
    runtime: python
    entrypoint: scripts/inc.py
    input: {ref: nodes.count.output.state}
`);
    expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual(expect.not.arrayContaining([expect.stringMatching(/state/)]));
  });
  it('allows state and iteration only inside a loop body', () => {
    const r = compileText(`schema_version: "2.0"
id: x
nodes:
  - id: a
    type: script
    runtime: python
    entrypoint: scripts/a.py
    input: {ref: state.n}
`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_ref', message: expect.stringContaining("only available inside a loop node's body") })]));
  });
  it('checks the exit condition as CEL and the body type', () => {
    const r = compileText(loopWorkflow().replace('state.n >= 3', 'state.n >='));
    expect(r.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_cel' })]));
    expect(loadDefinitionText(loopWorkflow().replace('type: script', 'type: agent')).diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });
  it('treats a subworkflow output as untrusted', () => {
    const r = compileText(`schema_version: "2.0"
id: parent
nodes:
  - id: child
    type: subworkflow
    workflow: other
    input: {x: 2}
`);
    expect(r.ok).toBe(true);
    expect(r.plan!.taint.untrusted.child).toMatch(/subworkflow/);
  });
});

const up = await temporalAvailable();

describe.skipIf(!up)('loops and subworkflows at run time', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h?.stop());

  it('repeats a script step until the exit condition holds', async () => {
    const v = await uploadDir(h.api, pkg(loopWorkflow(), { 'scripts/inc.py': INC }));
    expect(v.ok).toBe(true);
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs: {} });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    const out = d.attempts.find((a: any) => a.node_id === 'count' && a.state === 'succeeded')?.output;
    expect(out).toMatchObject({ state: { n: 3 }, count: 3, exited: true, iterations: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  });

  it('fails when max_iterations is reached without exiting, and continues when asked to', async () => {
    const failing = await uploadDir(h.api, pkg(loopWorkflow('', 2), { 'scripts/inc.py': INC }));
    const a = await waitForRun(h.api, (await h.api.post<{ run_id: string }>('/v1/runs', { version: failing.version.id, inputs: {} })).run_id);
    expect(a.run.state).toBe('failed');
    expect(a.run.error.class).toBe('contract_violation');
    expect(a.run.error.message).toMatch(/max_iterations \(2\)/);

    const lenient = await uploadDir(h.api, pkg(loopWorkflow('\n    on_max: continue', 2), { 'scripts/inc.py': INC }));
    const b = await waitForRun(h.api, (await h.api.post<{ run_id: string }>('/v1/runs', { version: lenient.version.id, inputs: {} })).run_id);
    expect(b.run.state).toBe('succeeded');
    expect(b.attempts.find((x: any) => x.node_id === 'count' && x.state === 'succeeded').output).toMatchObject({ count: 2, exited: false });
  });

  it('runs a published workflow as a child run and returns its outputs', async () => {
    const child = await uploadDir(
      h.api,
      pkg(
        `schema_version: "2.0"
id: doubler
inputs: {type: object, properties: {x: {type: integer}}, required: [x]}
nodes:
  - id: double
    type: script
    runtime: python
    entrypoint: scripts/double.py
    input: {map: "{'x': inputs.x}"}
    output_schema: {type: object, properties: {doubled: {type: integer}}, required: [doubled]}
`,
        { 'scripts/double.py': DOUBLE },
      ),
    );
    await h.api.post(`/v1/versions/${child.version.id}/publish`, {});

    const parentDir = pkg(
      `schema_version: "2.0"
id: caller
nodes:
  - id: sub
    type: subworkflow
    workflow: doubler
    input: {x: 21}
  - id: after
    type: script
    runtime: python
    entrypoint: scripts/inc.py
    input: {map: "{'n': nodes.sub.output.nodes.double.doubled}"}
    output_schema: {type: object, properties: {n: {type: integer}}, required: [n]}
`,
      { 'scripts/inc.py': INC },
    );
    const parent = await uploadDir(h.api, parentDir);
    expect(parent.ok).toBe(true);
    const plan = await h.api.get<any>(`/v1/versions/${parent.version.id}/plan`);
    expect(plan.nodes.find((n: any) => n.id === 'sub').requirements).toContainEqual(expect.objectContaining({ name: 'subworkflow doubler', mark: 'native' }));

    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: parent.version.id, inputs: {} });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    const sub = d.attempts.find((a: any) => a.node_id === 'sub' && a.state === 'succeeded').output;
    expect(sub).toMatchObject({ workflow: 'doubler', state: 'succeeded', nodes: { double: { doubled: 42 } } });
    expect(d.attempts.find((a: any) => a.node_id === 'after').output).toEqual({ n: 43 });

    // The child is a run of its own, started by the parent.
    const childRun = await h.api.get<any>(`/v1/runs/${sub.run_id}`);
    expect(childRun.run).toMatchObject({ state: 'succeeded', trigger: 'subworkflow', workflow: 'doubler' });
    expect(childRun.run.snapshot.parent).toMatchObject({ run_id, node_id: 'sub', chain: ['caller'] });
  });

  it('blocks a subworkflow that is not published or that calls its own workflow', async () => {
    const missing = await uploadDir(h.api, pkg('schema_version: "2.0"\nid: lonely\nnodes:\n  - id: sub\n    type: subworkflow\n    workflow: nobody\n'));
    const plan = await h.api.get<any>(`/v1/versions/${missing.version.id}/plan`);
    expect(plan.ok).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'subworkflow_missing', node: 'sub' }));

    const self = await uploadDir(h.api, pkg('schema_version: "2.0"\nid: ouroboros\nnodes:\n  - id: sub\n    type: subworkflow\n    workflow: ouroboros\n'));
    await h.api.post(`/v1/versions/${self.version.id}/publish`, {});
    const p2 = await h.api.get<any>(`/v1/versions/${self.version.id}/plan`);
    expect(p2.blockers).toContainEqual(expect.objectContaining({ code: 'subworkflow_recursion' }));
  });
});
