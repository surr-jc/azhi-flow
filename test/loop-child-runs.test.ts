import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromFiles } from '../src/definition/package.js';
import { staticCatalog, type ToolSpec } from '../src/gateway/types.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * What a workflow that delivers a list of tickets one child run at a time relies on (.claude/plans/sdd-factory.md,
 * Phase 0): a loop body that holds a subworkflow step and hands each round's result to the next through a script, a
 * child run that may take longer than the one hour a subworkflow step gets by default, and a write that stays gated
 * when a condition routes around the approval in front of it.
 */
const STEP = `import json, sys
d = json.load(sys.stdin)
if d["x"] == d["fail_at"]:
    raise SystemExit("this step fails")
print(json.dumps({"value": d["x"] + 10}))
`;
// The parent trusts nothing about the child: anything but a succeeded run with a number is 'failed'.
const OUTCOME = `import json, sys
child = json.load(sys.stdin)["child"]
value = ((child.get("nodes") or {}).get("step") or {}).get("value")
ok = child.get("state") == "succeeded" and isinstance(value, int)
print(json.dumps({"status": "ok" if ok else "failed", "value": value if ok else -1}))
`;
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

const chain = (id: string) => `schema_version: "2.0"
id: ${id}
inputs: {type: object, properties: {fail_at: {type: integer}}, required: [fail_at]}
nodes:
  - id: stories
    type: loop
    max_iterations: 4
    on_max: fail
    initial: {prev: 0}
    body:
      - id: child
        type: subworkflow
        workflow: stepper
        on_failure: continue
        input: {x: {cel: state.prev}, fail_at: {ref: inputs.fail_at}}
      - id: outcome
        type: script
        runtime: python
        entrypoint: scripts/outcome.py
        input: {map: "{'child': nodes.child.output}"}
        output_schema: {type: object, properties: {status: {type: string}, value: {type: integer}}, required: [status, value]}
    exit:
      - {when: "nodes.outcome.output.status != 'ok'", outcome: stop, reason: A step failed}
      - {when: "iteration >= 3", outcome: done, reason: Every step ran}
    next:
      prev: {cel: nodes.outcome.output.value}
  - id: after
    type: script
    runtime: python
    entrypoint: scripts/after.py
    input: {map: "{'outcome': nodes.stories.output.outcome, 'count': nodes.stories.output.count, 'last': nodes.stories.output.last.outcome.value}"}
    output_schema: {type: object}
`;

const gated = `schema_version: "2.0"
id: gated
nodes:
  - id: ask
    type: approval
    message: Continue?
  - id: done
    type: script
    runtime: python
    entrypoint: scripts/after.py
    depends_on: [ask]
    input: {map: "{'by': nodes.ask.output.decision}"}
    output_schema: {type: object}
`;

const waiter = (id: string, timeout: string) => `schema_version: "2.0"
id: ${id}
nodes:
  - id: child
    type: subworkflow
    workflow: gated
    on_failure: continue${timeout}
  - id: after
    type: script
    runtime: python
    entrypoint: scripts/after.py
    input: {map: "{'state': nodes.child.output.state}"}
    output_schema: {type: object}
`;

const tool = (id: string, effect: ToolSpec['effect']): ToolSpec => ({ id, version: 1, description: id, effect, transport: { kind: 'builtin', name: 'fixture' }, input_schema: { type: 'object' }, output_schema: { type: 'object' } });
const catalog = staticCatalog([tool('ci.list-runs', 'read'), tool('jira.create', 'write-dedupable')]);
const files = new Map([
  ['profiles/analyst@1.yaml', Buffer.from('instructions: analyse\n')],
  ['schemas/analysis.json', Buffer.from('{"type":"object","properties":{"summary":{"type":"string"}}}')],
  ['g.py', Buffer.from('')],
  ['scripts/outcome.py', Buffer.from(OUTCOME)],
  ['scripts/after.py', Buffer.from(AFTER)],
]);
const compileText = (text: string) => {
  const loaded = loadDefinitionText(text);
  if (!loaded.definition) return { ok: false, plan: undefined, diagnostics: loaded.diagnostics };
  const all = new Map(files);
  all.set('workflow.yaml', Buffer.from(text));
  return compile(loaded.definition, { catalog, pkg: packageFromFiles('workflow.yaml', all) });
};
const errorCodes = (r: { diagnostics: Array<{ severity: string; code: string; node?: string }> }) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}:${d.node ?? ''}`);

/** A tainted agent, then a person or a script decides, then a write. `guard` is the write's own gate, or nothing. */
const eitherWay = (guard: string) => `schema_version: "2.0"
id: either
inputs: {type: object, properties: {mode: {type: string, enum: [supervised, auto]}}, required: [mode]}
nodes:
  - {id: fetch, type: tool, tool: "ci.list-runs@1"}
  - id: analyse
    type: agent
    profile: analyst@1
    input: {ref: nodes.fetch.output}
    output_schema: schemas/analysis.json
  - id: mode_gate
    type: condition
    expression: inputs.mode
    depends_on: [analyse]
    routes: {supervised: [review], auto: [decide]}
    default: supervised
  - id: review
    type: approval
    payload: {ref: nodes.analyse.output}
  - id: decide
    type: script
    runtime: python
    entrypoint: g.py
    input: {ref: nodes.analyse.output}
    output_schema: {type: object, properties: {summary: {type: string}}, required: [summary]}
  - id: decision
    type: script
    runtime: python
    entrypoint: g.py
    merge: any
    depends_on: [review, decide]
    input: {map: "{'person': has(nodes.review) ? nodes.review.output.decision : '', 'rule': has(nodes.decide) ? nodes.decide.output.summary : ''}"}
    output_schema: {type: object, properties: {summary: {type: string}}, required: [summary]}
  - id: post
    type: tool
    tool: jira.create@1
    arguments: {summary: {ref: nodes.decision.output.summary}}${guard}
`;

describe('compiling a loop of child runs and a routed-around approval', () => {
  it('gives a subworkflow step one hour unless it sets a timeout, in a loop body too', () => {
    const plain = compileText(waiter('w', ''));
    expect(errorCodes(plain)).toEqual([]);
    expect(plain.plan!.nodes.find((n) => n.id === 'child')!.timeoutMs).toBe(3_600_000);
    const long = compileText(waiter('w', '\n    timeout: 96h'));
    expect(long.plan!.nodes.find((n) => n.id === 'child')!.timeoutMs).toBe(96 * 3_600_000);

    const looped = compileText(chain('c').replace('on_failure: continue', 'on_failure: continue\n        timeout: 96h'));
    expect(errorCodes(looped)).toEqual([]);
    for (const round of [1, 2, 3, 4]) expect(looped.plan!.nodes.find((n) => n.id === `stories_${round}_child`)!.timeoutMs).toBe(96 * 3_600_000);
  });

  it('accepts a subworkflow in a loop body whose next round reads a script over its output', () => {
    const r = compileText(chain('c'));
    expect(errorCodes(r)).toEqual([]);
    // What comes back from a child is untrusted, and so is everything derived from it, through the join.
    expect(r.plan!.taint.untrusted.stories_1_child).toMatch(/subworkflow/);
    expect(r.plan!.taint.untrusted.stories_2_child).toBeTruthy();
    expect(r.plan!.taint.untrusted.after).toBeTruthy();
  });

  it('keeps a write gated by its guard when a condition routes around the approval, and refuses it without one', () => {
    const guarded = compileText(eitherWay("\n    guard: \"args.summary != ''\""));
    expect(errorCodes(guarded)).toEqual([]);
    const toPost = guarded.plan!.taint.paths.filter((p) => p.write === 'post');
    expect(toPost.length).toBeGreaterThan(0);
    // The route through the script reaches the write with no approval on it, and the guard is what gates it.
    expect(toPost.some((p) => p.gate === 'guard' && p.path.includes('decide'))).toBe(true);
    expect(toPost.every((p) => p.gate !== null)).toBe(true);

    const bare = compileText(eitherWay(''));
    expect(errorCodes(bare)).toContain('tainted_write_ungated:post');
  });
});

function pkg(workflow: string) {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-child-runs-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'workflow.yaml'), workflow);
  writeFileSync(join(dir, 'scripts/step.py'), STEP);
  writeFileSync(join(dir, 'scripts/outcome.py'), OUTCOME);
  writeFileSync(join(dir, 'scripts/after.py'), AFTER);
  return dir;
}

const SLOW = 240_000;
const up = await temporalAvailable();
let seq = 0;

describe.skipIf(!up)('a loop of child runs at run time', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    for (const child of [stepper, gated]) {
      const v = await uploadDir(h.api, pkg(child));
      expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
      await h.api.post(`/v1/versions/${v.version.id}/publish`, {});
    }
  }, 120_000);
  afterAll(async () => h?.stop());

  const start = async (workflow: string, inputs: Record<string, unknown> = {}) => {
    const v = await uploadDir(h.api, pkg(workflow));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    return (await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs })).run_id;
  };
  const ok = (d: any, id: string) => d.attempts.find((a: any) => a.node_id === id && a.state === 'succeeded');

  it('runs one child per round, in order, each given what the round before produced', async () => {
    const d = await waitForRun(h.api, await start(chain(`chain-${++seq}`), { fail_at: -1 }), SLOW);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    expect([1, 2, 3].map((r) => ok(d, `stories_${r}_child`).output.nodes.step.value)).toEqual([10, 20, 30]);
    expect(ok(d, 'stories_4_child')).toBeUndefined();
    expect(ok(d, 'stories').output).toMatchObject({ outcome: 'done', reason: 'Every step ran', count: 3, exited: true });
    expect(ok(d, 'after').output.seen).toEqual({ outcome: 'done', count: 3, last: 30 });
    // Each round's child is a run of its own, started in order.
    expect(d.children.map((c: any) => [c.workflow, c.state, c.parent_node_id])).toEqual([1, 2, 3].map((r) => ['stepper', 'succeeded', `stories_${r}_child`]));
  }, SLOW);

  it('stops at the round whose child failed: the loop says so, no later child starts, and the run goes on', async () => {
    const d = await waitForRun(h.api, await start(chain(`chain-${++seq}`), { fail_at: 10 }), SLOW);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    expect(ok(d, 'stories_1_child').output.nodes.step.value).toBe(10);
    expect(ok(d, 'stories_2_child').output).toMatchObject({ state: 'failed', error: { class: expect.any(String) }, nodes: {} });
    expect(ok(d, 'stories_3_child')).toBeUndefined();
    expect(ok(d, 'stories').output).toMatchObject({ outcome: 'stop', reason: 'A step failed', count: 2 });
    expect(ok(d, 'after').output.seen).toEqual({ outcome: 'stop', count: 2, last: -1 });
    expect(d.children.map((c: any) => c.state)).toEqual(['succeeded', 'failed']);
  }, SLOW);

  const waitingChild = async (runId: string) => {
    for (let i = 0; i < 400; i++) {
      const d = await h.api.get<any>(`/v1/runs/${runId}`);
      const child = d.children[0];
      if (child) {
        const c = await h.api.get<any>(`/v1/runs/${child.id}`);
        if (c.run.flags?.waiting_reason?.node === 'ask') return child.id as string;
      }
      if (['succeeded', 'failed', 'cancelled'].includes(d.run.state)) throw new Error(`run ended ${d.run.state} before its child asked: ${JSON.stringify(d.run.error)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('the child never asked for approval');
  };

  it('waits for a child that is waiting on a person, and finishes once they answer', async () => {
    const runId = await start(waiter(`waiter-${++seq}`, '\n    timeout: 96h'));
    const childId = await waitingChild(runId);
    await h.api.post(`/v1/runs/${childId}/approvals`, { node: 'ask', decision: 'approved' });
    const d = await waitForRun(h.api, runId, SLOW);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    expect(ok(d, 'child').output).toMatchObject({ workflow: 'gated', state: 'succeeded' });
    expect(ok(d, 'after').output.seen).toEqual({ state: 'succeeded' });
  }, SLOW);

  // The child gets the step's timeout plus a minute as its whole lifetime, so this takes a little over a minute.
  it('ends a child that outlives the step timeout while it waits on a person, and reports it as not succeeded', async () => {
    const runId = await start(waiter(`waiter-${++seq}`, '\n    timeout: 5s'));
    await waitingChild(runId);
    const d = await waitForRun(h.api, runId, SLOW);
    expect(d.run.state).toBe('succeeded');
    const out = ok(d, 'child').output;
    expect(out.state).not.toBe('succeeded');
    expect(out.error).toMatchObject({ class: expect.any(String) });
    expect(ok(d, 'after').output.seen.state).toBe(out.state);
  }, SLOW);
});
