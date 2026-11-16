import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromFiles } from '../src/definition/package.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * A parallel step whose body is a subworkflow: one child run per item of a list known only at run time, in one step
 * of the plan. The items come back in input order; a child kept under on_failure: continue is an item like any other
 * and does not stop the rest.
 */
const STEP = `import json, sys
d = json.load(sys.stdin)
if d["x"] == d["fail_at"]:
    raise SystemExit("this step fails")
print(json.dumps({"value": d["x"] + 10}))
`;
const LIST = 'import json, sys\nprint(json.dumps({"items": [{"x": n} for n in json.load(sys.stdin)["xs"]]}))\n';
const AFTER = 'import json, sys\nprint(json.dumps({"seen": json.load(sys.stdin)}))\n';

const stepper = `schema_version: "2.0"
id: stepper
inputs: {type: object, properties: {x: {type: integer}, fail_at: {type: integer}}, required: [x, fail_at]}
nodes:
  - id: step
    type: script
    runtime: python
    entrypoint: scripts/step.py
    retry: {max_attempts: 1}
    input: {map: "{'x': inputs.x, 'fail_at': inputs.fail_at}"}
    output_schema: {type: object, properties: {value: {type: integer}}, required: [value]}
`;

const fan = (id: string, body = 'on_failure: continue', concurrency = 1) => `schema_version: "2.0"
id: ${id}
inputs: {type: object, properties: {xs: {type: array, items: {type: integer}}, fail_at: {type: integer}}, required: [xs, fail_at]}
nodes:
  - id: list
    type: script
    runtime: python
    entrypoint: scripts/list.py
    input: {map: "{'xs': inputs.xs}"}
    output_schema: {type: object, properties: {items: {type: array, items: {type: object, properties: {x: {type: integer}}, required: [x]}}}, required: [items]}
  - id: each
    type: parallel
    for_each: {ref: nodes.list.output.items}
    max_concurrency: ${concurrency}
    max_items: 5
    node:
      type: subworkflow
      workflow: stepper
      ${body}
      input: {x: {ref: item.x}, fail_at: {ref: inputs.fail_at}}
  - id: after
    type: script
    runtime: python
    entrypoint: scripts/after.py
    input: {map: "{'completed': nodes.each.output.completed, 'failed': nodes.each.output.failed, 'states': nodes.each.output.items.map(c, c.state)}"}
    output_schema: {type: object}
`;

const files = new Map([
  ['scripts/list.py', Buffer.from(LIST)],
  ['scripts/after.py', Buffer.from(AFTER)],
]);
const compileText = (text: string) => {
  const loaded = loadDefinitionText(text);
  if (!loaded.definition) return { ok: false, plan: undefined, diagnostics: loaded.diagnostics };
  const all = new Map(files);
  all.set('workflow.yaml', Buffer.from(text));
  return compile(loaded.definition, { pkg: packageFromFiles('workflow.yaml', all) });
};
const errors = (r: { diagnostics: Array<{ severity: string; code: string; node?: string; message: string }> }) => r.diagnostics.filter((d) => d.severity === 'error');

describe('compiling a parallel step of child runs', () => {
  it('is one step in the plan, whose items have the shape of a subworkflow output and are untrusted', () => {
    const r = compileText(fan('f'));
    expect(errors(r)).toEqual([]);
    expect(r.plan!.nodes.map((n) => n.id)).toEqual(['list', 'each', 'after']);
    const each = r.plan!.nodes.find((n) => n.id === 'each')!;
    expect(each.type).toBe('parallel');
    expect((each.outputSchema as any).properties.items.items.properties).toHaveProperty('run_id');
    expect(r.plan!.taint.untrusted.each).toMatch(/subworkflow/);
    expect(r.plan!.taint.untrusted.after).toBeTruthy();
  });

  it('takes the timeout of the step for each child', () => {
    const r = compileText(fan('f').replace('    max_items: 5', '    max_items: 5\n    timeout: 96h'));
    expect(errors(r)).toEqual([]);
    expect(r.plan!.nodes.find((n) => n.id === 'each')!.timeoutMs).toBe(96 * 3_600_000);
  });

  it('checks item refs in the child input, and refuses item outside the body', () => {
    expect(errors(compileText(fan('f').replace('item.x', 'item.nope'))).map((d) => d.code)).toContain('ref_type');
    expect(errors(compileText(fan('f').replace(/input: \{map: "\{'completed'.*\n/, 'input: {ref: item.x}\n'))).map((d) => d.code)).toContain('invalid_ref');
  });

  it('refuses a body without a workflow, with an unknown field, or of another step type', () => {
    expect(errors(compileText(fan('f').replace('      workflow: stepper\n', ''))).length).toBeGreaterThan(0);
    expect(errors(compileText(fan('f', 'on_failure: continue\n      guard: "true"'))).length).toBeGreaterThan(0);
    expect(errors(compileText(fan('f').replace('type: subworkflow', 'type: approval'))).length).toBeGreaterThan(0);
  });
});

function pkg(workflow: string) {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-parallel-children-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'workflow.yaml'), workflow);
  writeFileSync(join(dir, 'scripts/step.py'), STEP);
  writeFileSync(join(dir, 'scripts/list.py'), LIST);
  writeFileSync(join(dir, 'scripts/after.py'), AFTER);
  return dir;
}

const SLOW = 240_000;
const up = await temporalAvailable();
let seq = 0;

describe.skipIf(!up)('a parallel step of child runs at run time', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    const v = await uploadDir(h.api, pkg(stepper));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    await h.api.post(`/v1/versions/${v.version.id}/publish`, {});
  }, 120_000);
  afterAll(async () => h?.stop());

  const start = async (workflow: string, inputs: Record<string, unknown>) => {
    const v = await uploadDir(h.api, pkg(workflow));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    return (await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs })).run_id;
  };
  const ok = (d: any, id: string) => d.attempts.find((a: any) => a.node_id === id && a.state === 'succeeded');

  it('starts one child run per item and returns them in input order', async () => {
    const d = await waitForRun(h.api, await start(fan(`fan-${++seq}`), { xs: [3, 1, 2], fail_at: -1 }), SLOW);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    const out = ok(d, 'each').output;
    expect(out.items.map((c: any) => c.nodes.step.value)).toEqual([13, 11, 12]);
    expect(out).toMatchObject({ completed: 3, failed: 0 });
    expect(new Set(out.items.map((c: any) => c.run_id)).size).toBe(3);
    // Every child is a run of its own under the one parallel step.
    expect(d.children.map((c: any) => [c.workflow, c.state, c.parent_node_id])).toEqual([1, 2, 3].map(() => ['stepper', 'succeeded', 'each']));
  }, SLOW);

  it('keeps going past a child that failed under on_failure: continue, and counts it', async () => {
    const d = await waitForRun(h.api, await start(fan(`fan-${++seq}`), { xs: [1, 2, 3], fail_at: 2 }), SLOW);
    expect(d.run.state).toBe('succeeded');
    const out = ok(d, 'each').output;
    expect(out).toMatchObject({ completed: 2, failed: 1 });
    expect(out.items[1]).toMatchObject({ state: 'failed', error: { class: expect.any(String) }, nodes: {} });
    expect(ok(d, 'after').output.seen).toEqual({ completed: 2, failed: 1, states: ['succeeded', 'failed', 'succeeded'] });
  }, SLOW);

  it('runs children side by side when max_concurrency allows, and no child for an empty list', async () => {
    const d = await waitForRun(h.api, await start(fan(`fan-${++seq}`, 'on_failure: continue', 3), { xs: [1, 2, 3], fail_at: -1 }), SLOW);
    expect(ok(d, 'each').output.items.map((c: any) => c.nodes.step.value)).toEqual([11, 12, 13]);
    const none = await waitForRun(h.api, await start(fan(`fan-${++seq}`), { xs: [], fail_at: -1 }), SLOW);
    expect(ok(none, 'each').output).toEqual({ items: [], completed: 0, failed: 0 });
    expect(none.children).toEqual([]);
  }, SLOW);

  it('fails the step when a child fails and the body does not say continue', async () => {
    const d = await waitForRun(h.api, await start(fan(`fan-${++seq}`, 'on_failure: fail'), { xs: [1, 2, 3], fail_at: 1 }), SLOW);
    expect(d.run.state).toBe('failed');
  }, SLOW);
});
