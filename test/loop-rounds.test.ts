import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromFiles } from '../src/definition/package.js';
import { staticCatalog, type ToolSpec } from '../src/gateway/types.js';
import { contentHash } from '../src/lib/hash.js';
import { loopRounds } from '../src/plan/loop-rounds.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * Multi-step loops from the definition to a finished run. The compile checks need nothing running. The run-time paths
 * are the ones a loop must get right: which rounds run, how they end, large outputs, and what a resume keeps.
 */
const RESOLVE = `import json, os, sys
d = json.load(sys.stdin)
if d.get("block") and d["round"] == 2 and os.path.exists(d["block"]):
    sys.exit("blocked")
same = d["scenario"] == "no_progress"
print(json.dumps({"summary": f"round {d['round']}", "diff": "same" if same else f"diff {d['round']}", "feedback_seen": d.get("feedback"), "big": "x" * d["big"]}))
`;
const REVIEW = `import json, sys
d = json.load(sys.stdin)
s, r = d["scenario"], d["round"]
print(json.dumps({"ok": s == "accept" or (s == "retry" and r == 2), "injection": s == "stop", "notes": f"notes from round {r}"}))
`;
const PROBE = 'import json\nprint(json.dumps({"ran": True}))\n';
const AFTER = 'import json, sys\nd = json.load(sys.stdin)\nby_ref = d.pop("by_ref", None) or {}\nprint(json.dumps({"seen": d, "big_len": len(by_ref.get("big", ""))}))\n';

const workflow = (id: string, onMax: 'fail' | 'continue' = 'continue') => `schema_version: "2.0"
id: ${id}
inputs:
  type: object
  properties: {scenario: {type: string}, enter: {type: boolean}, big: {type: integer}, block: {type: string}}
nodes:
  - id: outer
    type: condition
    expression: "inputs.enter ? 'yes' : 'no'"
    routes: {yes: [attempt], no: []}
    default: 'no'
  - id: attempt
    type: loop
    description: Resolve and review, again if the review rejects it.
    max_iterations: 2
    on_max: ${onMax}
    initial: {feedback: null, prev_diff: null}
    next:
      feedback: {cel: nodes.review.output.notes}
      prev_diff: {ref: nodes.resolve.output.diff}
    body:
      - id: resolve
        type: script
        runtime: python
        entrypoint: scripts/resolve.py
        retry: {max_attempts: 1}
        input: {map: "{'round': iteration + 1, 'scenario': inputs.scenario, 'big': inputs.big, 'block': has(inputs.block) ? inputs.block : '', 'feedback': state.feedback}"}
      - id: probe
        type: script
        runtime: python
        entrypoint: scripts/probe.py
        retry: {max_attempts: 1}
        input: {map: "{'scenario': inputs.scenario}"}
      - id: changed
        type: condition
        expression: "state.prev_diff == null || nodes.resolve.output.diff != state.prev_diff ? 'changed' : 'same'"
        depends_on: [resolve]
        routes: {changed: [review], same: []}
        default: changed
      - id: review
        type: script
        runtime: python
        entrypoint: scripts/review.py
        retry: {max_attempts: 1}
        input: {map: "{'round': iteration + 1, 'scenario': inputs.scenario, 'summary': nodes.resolve.output.summary}"}
    exit:
      - {when: "nodes.changed.output.route == 'same'", outcome: no_progress, reason: The change did not move}
      - {when: nodes.review.output.injection, outcome: stop, reason: Prompt injection reported}
      - {when: nodes.review.output.ok, outcome: done, reason: Checks passed}
  - id: after
    type: script
    runtime: python
    entrypoint: scripts/after.py
    retry: {max_attempts: 1}
    input: {map: "{'outcome': nodes.attempt.output.outcome, 'count': nodes.attempt.output.count, 'summary': nodes.attempt.output.last.resolve.summary, 'feedback_seen': nodes.attempt.output.last.resolve.feedback_seen, 'rounds': size(nodes.attempt.output.rounds), 'by_ref': nodes.attempt.output.last.resolve}"}
`;

const tool = (id: string, effect: ToolSpec['effect']): ToolSpec => ({ id, version: 1, description: id, effect, transport: { kind: 'builtin', name: 'fixture' }, input_schema: { type: 'object' }, output_schema: { type: 'object' } });
const catalog = staticCatalog([tool('ci.list-runs', 'read')]);
const files = new Map([
  ['profiles/analyst@1.yaml', Buffer.from('instructions: analyse\n')],
  ['profiles/analyst@2.yaml', Buffer.from('instructions: analyse harder\n')],
  ['schemas/analysis.json', Buffer.from('{"type":"object","properties":{"summary":{"type":"string"},"ok":{"type":"boolean"}}}')],
]);
const compileText = (text: string) => {
  const loaded = loadDefinitionText(text);
  if (!loaded.definition) return { ok: false, plan: undefined, diagnostics: loaded.diagnostics };
  const all = new Map(files);
  all.set('workflow.yaml', Buffer.from(text));
  return compile(loaded.definition, { catalog, pkg: packageFromFiles('workflow.yaml', all) });
};
const errors = (r: { diagnostics: Array<{ severity: string; code: string; node?: string }> }) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}:${d.node ?? ''}`);

/** A tainted agent in the body: it reads untrusted tool output. */
const tainted = (after: string) => `schema_version: "2.0"
id: t
config: {channel: C1}
nodes:
  - id: analysis
    type: loop
    max_iterations: 2
    on_max: continue
    body:
      - {id: fetch, type: tool, tool: "ci.list-runs@1"}
      - id: analyse
        type: agent
        profile: analyst@1
        input: {ref: nodes.fetch.output}
        output_schema: schemas/analysis.json
    overrides: {2: {analyse: {profile: analyst@2}}}
    exit:
      - {when: nodes.analyse.output.ok, outcome: done}
${after}`;

describe('compiling a multi-step loop', () => {
  const noPkg = (text: string) => {
    const l = loadDefinitionText(text);
    return { l, r: l.definition ? compile(l.definition) : undefined };
  };

  it('compiles to ordinary steps, each saying where it came from, and hashes what the author wrote', () => {
    const { l, r } = noPkg(workflow('shape'));
    expect(l.diagnostics).toEqual([]);
    expect(errors(r!)).toEqual([]);
    const ids = r!.plan!.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['attempt_1_resolve', 'attempt_2_review', 'attempt_1_gate', 'attempt', 'after']));
    expect(ids).not.toContain('resolve');
    expect(r!.plan!.nodes.find((n) => n.id === 'attempt_2_review')!.loop).toEqual({ loop: 'attempt', round: 2, step: 'review' });
    expect(r!.plan!.nodes.find((n) => n.id === 'after')!.loop).toBeUndefined();
    expect(r!.plan!.definitionHash).toBe(contentHash(l.definition!));
  });

  it('orders the join after every gate, and a later step after the join', () => {
    const nodes = noPkg(workflow('order')).r!.plan!.nodes;
    const at = (id: string) => nodes.findIndex((n) => n.id === id);
    expect(at('attempt')).toBeGreaterThan(at('attempt_2_gate'));
    expect(at('after')).toBeGreaterThan(at('attempt'));
    expect(nodes.find((n) => n.id === 'after')!.deps).toEqual(['attempt']);
  });

  it('still refuses a merge on a condition a person wrote', () => {
    const { r } = noPkg(`schema_version: "2.0"
id: x
nodes:
  - {id: a, type: condition, expression: "'x'", routes: {x: []}, default: x}
  - {id: attempt_1_gate, type: condition, merge: any, depends_on: [a], expression: "'x'", routes: {x: []}, default: x}
`);
    expect(errors(r!)).toContain('invalid_merge:attempt_1_gate');
  });

  it('refuses what only the compiler may write, and shapes that mix the two kinds of loop', () => {
    const invalid = (extra: string) => loadDefinitionText(`schema_version: "2.0"
id: x
nodes:
  - id: l
    type: loop
    max_iterations: 2
${extra}`).diagnostics.some((d) => d.severity === 'error');
    const body = '    body: [{id: a, type: script, runtime: python, entrypoint: a.py}]\n';
    const node = '    node: {type: script, runtime: python, entrypoint: a.py}\n';
    const rules = '    exit: [{when: "true", outcome: done}]\n';
    expect(invalid(body + rules)).toBe(false);
    expect(invalid(`${node}    exit: "true"\n`)).toBe(false);
    expect(invalid(`${body}${rules}    rounds: []\n`)).toBe(true);
    expect(invalid(`${body}${rules}    reasons: {done: x}\n`)).toBe(true);
    expect(invalid(body + node + rules)).toBe(true);
    expect(invalid(`${body}    exit: "true"\n`)).toBe(true);
    expect(invalid(node + rules)).toBe(true);
    expect(invalid(`${body}    exit: [{when: "true", outcome: retry}]\n`)).toBe(true);
    expect(invalid(`    body: [{id: a, type: script, runtime: python, entrypoint: a.py, nope: 1}]\n${rules}`)).toBe(true);
  });

  it('reports a loop that is wrong, without crashing on the unexpanded node', () => {
    const { r } = noPkg(`schema_version: "2.0"
id: x
nodes:
  - id: l
    type: loop
    max_iterations: 2
    body: [{id: a, type: script, runtime: python, entrypoint: a.py, input: {map: "{'x': state.nope}"}}]
    exit: [{when: "true", outcome: done}]
`);
    expect(r!.ok).toBe(false);
    expect(errors(r!)).toContain('loop_unknown_state:l');
  });

  it('applies an override, so a stronger profile is pinned and checked for its round', () => {
    const r = compileText(tainted(''));
    expect(errors(r)).toEqual([]);
    const profile = (id: string) => (r.plan!.nodes.find((n) => n.id === id)!.def as { profile: string }).profile;
    expect(profile('analysis_1_analyse')).toBe('analyst@1');
    expect(profile('analysis_2_analyse')).toBe('analyst@2');
  });

  it('carries taint through the join: an unguarded write after the loop is refused, a guarded one accepted', () => {
    const post = (guard: string) => `  - id: post
    type: notify
    channel: slack
    destination: {ref: config.channel}
    message: {ref: nodes.analysis.output.last.analyse.summary}
${guard}`;
    // Reported for each round's tainted agent, since either could reach it.
    expect(new Set(errors(compileText(tainted(post('')))))).toEqual(new Set(['tainted_write_ungated:post']));
    const ok = compileText(tainted(post('    guard: "args.channel == config.channel"\n')));
    expect(errors(ok)).toEqual([]);
    expect(ok.plan!.taint.tainted.analysis_2_analyse).toBeTruthy();
    expect(ok.plan!.taint.paths.find((p) => p.write === 'post')?.gate).toBe('guard');
  });

  it('type-checks a ref through the join against the step that produced it', () => {
    const read = (ref: string) => `  - id: post
    type: notify
    channel: slack
    destination: {ref: config.channel}
    message: {ref: ${ref}}
    guard: "args.channel == config.channel"
`;
    expect(errors(compileText(tainted(read('nodes.analysis.output.last.analyse.summary'))))).toEqual([]);
    expect(errors(compileText(tainted(read('nodes.analysis.output.last.nope.summary'))))).toEqual(['ref_type:post']);
    expect(errors(compileText(tainted(read('nodes.analysis.output.last.analyse.nope'))))).toEqual(['ref_type:post']);
  });

  it('merges a per-round context into the input, and does not report it unused', () => {
    const r = noPkg(`schema_version: "2.0"
id: x
contexts:
  round: {change: {ref: nodes.resolve.output.diff}}
nodes:
  - id: l
    type: loop
    max_iterations: 2
    on_max: continue
    body:
      - {id: resolve, type: script, runtime: python, entrypoint: r.py}
      - {id: review, type: script, runtime: python, entrypoint: v.py, context: [round]}
    exit: [{when: nodes.review.output.ok, outcome: done}]
`).r!;
    expect(errors(r)).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('unused_context');
    const review = r.plan!.nodes.find((n) => n.id === 'l_2_review')!;
    expect((review.def as { input: unknown }).input).toEqual({ change: { ref: 'nodes.l_2_resolve.output.diff' } });
    expect(review.inputParts).toEqual([{ key: 'change', source: 'context:l_2_round' }]);
  });
});

describe('what each round did', () => {
  const plan = noPlan();
  function noPlan() {
    return compile(loadDefinitionText(workflow('rounds')).definition!).plan!;
  }
  const a = (node_id: string, output: unknown = {}, state = 'succeeded', attempt = 1) => ({ node_id, attempt, state, output });
  const u = (node_id: string, input_tokens: number | null, cost: number | null = 1, currency: string | null = 'USD') => ({ node_id, input_tokens, output_tokens: 5, cost, currency });

  it('lists only the rounds that started, with their outcome, fixed reason and steps', () => {
    const [l] = loopRounds(plan, [a('attempt_1_resolve'), a('attempt_1_probe'), a('attempt_1_changed', { route: 'changed' }), a('attempt_1_review'), a('attempt_1_gate', { route: 'done' })], []);
    expect(l).toMatchObject({ id: 'attempt', max_rounds: 2, outcome: 'done' });
    expect(l!.rounds).toHaveLength(1);
    expect(l!.rounds[0]).toMatchObject({ round: 1, outcome: 'done', reason: 'Checks passed' });
    expect(l!.rounds[0]!.steps.find((s) => s.step === 'review')).toEqual({ step: 'review', node_id: 'attempt_1_review', state: 'succeeded' });
    expect(l!.rounds[0]!.steps.map((s) => s.step)).not.toContain('gate');
  });

  it('does not count a round whose steps were all skipped as started', () => {
    const [l] = loopRounds(plan, [a('attempt_1_gate', { route: 'done' }), a('attempt_2_resolve', null, 'skipped'), a('attempt_2_gate', null, 'skipped')], []);
    expect(l!.rounds.map((r) => r.round)).toEqual([1]);
    expect(l!.outcome).toBe('done');
  });

  it('shows a failed run: the round that failed has no outcome, and a skipped step says so', () => {
    const [l] = loopRounds(plan, [a('attempt_1_gate', { route: 'retry' }), a('attempt_2_resolve', null, 'failed')], []);
    expect(l!.outcome).toBeNull();
    expect(l!.rounds[0]!.outcome).toBe('retry');
    expect(l!.rounds[0]!.reason).toBeNull();
    expect(l!.rounds[1]!.outcome).toBeNull();
    expect(l!.rounds[1]!.steps.find((s) => s.step === 'resolve')!.state).toBe('failed');
    expect(l!.rounds[1]!.steps.find((s) => s.step === 'review')!.state).toBe('not_run');
  });

  it('uses the latest attempt of a step', () => {
    const [l] = loopRounds(plan, [a('attempt_1_resolve', null, 'failed', 1), a('attempt_1_resolve', {}, 'succeeded', 2)], []);
    expect(l!.rounds[0]!.steps.find((s) => s.step === 'resolve')!.state).toBe('succeeded');
  });

  it('adds usage per round, and says unknown rather than guessing', () => {
    const attempts = [a('attempt_1_resolve'), a('attempt_2_resolve')];
    const [known] = loopRounds(plan, attempts, [u('attempt_1_resolve', 10), u('attempt_1_review', 20), u('attempt_2_resolve', 7)]);
    expect(known!.rounds[0]!.usage).toEqual({ input_tokens: 30, output_tokens: 10, cost: 2, currency: 'USD' });
    expect(known!.rounds[1]!.usage.input_tokens).toBe(7);
    const [none] = loopRounds(plan, attempts, []);
    expect(none!.rounds[0]!.usage).toEqual({ input_tokens: null, output_tokens: null, cost: null, currency: null });
    const [partial] = loopRounds(plan, attempts, [u('attempt_1_resolve', 10), u('attempt_1_review', null, null)]);
    expect(partial!.rounds[0]!.usage).toMatchObject({ input_tokens: null, output_tokens: 10, cost: null });
    const [mixed] = loopRounds(plan, attempts, [u('attempt_1_resolve', 10, 1, 'USD'), u('attempt_1_review', 10, 1, 'EUR')]);
    expect(mixed!.rounds[0]!.usage).toMatchObject({ cost: null, currency: null, input_tokens: 20 });
  });

  it('has nothing to say about a plan with no nodes, rather than failing to read the run', () => {
    expect(loopRounds({} as never, [a('a')], [])).toEqual([]);
  });

  it('has nothing to say about a workflow with no multi-step loop', () => {
    const none = compile(loadDefinitionText('schema_version: "2.0"\nid: x\nnodes:\n  - {id: a, type: script, runtime: python, entrypoint: a.py}\n').definition!).plan!;
    expect(loopRounds(none, [a('a')], [])).toEqual([]);
  });
});

function pkg(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-rounds-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'workflow.yaml'), text);
  writeFileSync(join(dir, 'scripts/resolve.py'), RESOLVE);
  writeFileSync(join(dir, 'scripts/review.py'), REVIEW);
  writeFileSync(join(dir, 'scripts/probe.py'), PROBE);
  writeFileSync(join(dir, 'scripts/after.py'), AFTER);
  return dir;
}

const SLOW = 240_000;
const up = await temporalAvailable();
let seq = 0;

describe.skipIf(!up)('multi-step loops at run time', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  }, 120_000);
  afterAll(async () => h?.stop());

  const start = async (inputs: Record<string, unknown>, onMax: 'fail' | 'continue' = 'continue') => {
    const v = await uploadDir(h.api, pkg(workflow(`rounds-${++seq}`, onMax)));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    return h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs: { enter: true, big: 0, ...inputs } });
  };
  const run = async (inputs: Record<string, unknown>, onMax: 'fail' | 'continue' = 'continue') => {
    const { run_id } = await start(inputs, onMax);
    const d = await waitForRun(h.api, run_id, SLOW);
    const ok = (id: string) => d.attempts.find((a: any) => a.node_id === id && a.state === 'succeeded');
    return { d, ok, run_id };
  };

  it('accepted in round 1: round 2 does not run, not even the step that reads only inputs', async () => {
    const { d, ok } = await run({ scenario: 'accept' });
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    for (const id of ['attempt_2_resolve', 'attempt_2_probe', 'attempt_2_gate']) expect(ok(id)).toBeUndefined();
    expect(ok('attempt').output).toMatchObject({ outcome: 'done', reason: 'Checks passed', count: 1, exited: true });
    expect(ok('after').output.seen).toMatchObject({ outcome: 'done', count: 1, summary: 'round 1', rounds: 1 });
    expect(d.loops).toHaveLength(1);
    expect(d.loops[0]).toMatchObject({ id: 'attempt', outcome: 'done', max_rounds: 2 });
    expect(d.loops[0].rounds).toHaveLength(1);
  }, SLOW);

  it('rejected then accepted: round 2 runs and receives round 1 feedback', async () => {
    const { d, ok } = await run({ scenario: 'retry' });
    expect(d.run.state).toBe('succeeded');
    expect(ok('attempt').output).toMatchObject({ outcome: 'done', count: 2 });
    expect(ok('after').output.seen).toMatchObject({ summary: 'round 2', feedback_seen: 'notes from round 1', rounds: 2 });
    expect(d.loops[0].rounds.map((r: any) => r.outcome)).toEqual(['retry', 'done']);
  }, SLOW);

  it('stopped in round 1: no second round, later steps still run, and the run succeeds', async () => {
    const { d, ok } = await run({ scenario: 'stop' });
    expect(d.run.state).toBe('succeeded');
    expect(ok('attempt_2_resolve')).toBeUndefined();
    expect(ok('attempt').output).toMatchObject({ outcome: 'stop', reason: 'Prompt injection reported', count: 1 });
    expect(ok('after').output.seen.outcome).toBe('stop');
  }, SLOW);

  it('out of rounds with on_max continue: reports it and goes on', async () => {
    const { d, ok } = await run({ scenario: 'exhaust' });
    expect(d.run.state).toBe('succeeded');
    expect(ok('attempt').output).toMatchObject({ outcome: 'exhausted', exited: false, count: 2 });
    expect(ok('after').output.seen.summary).toBe('round 2');
  }, SLOW);

  it('out of rounds with on_max fail: the run fails, later steps do not run, and the rounds are still reported', async () => {
    const { d, ok } = await run({ scenario: 'exhaust' }, 'fail');
    expect(d.run.state).toBe('failed');
    expect(d.run.error.class).toBe('contract_violation');
    expect(ok('after')).toBeUndefined();
    expect(d.loops[0].outcome).toBe('exhausted');
    expect(d.loops[0].rounds).toHaveLength(2);
  }, SLOW);

  it('no progress: the inner route skips the review, yet the gate still decides', async () => {
    const { d, ok } = await run({ scenario: 'no_progress' });
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    expect(ok('attempt_2_review')).toBeUndefined();
    expect(ok('attempt_2_gate').output).toMatchObject({ route: 'no_progress' });
    expect(ok('attempt').output).toMatchObject({ outcome: 'no_progress', count: 2 });
    // A step its round skipped is null, not missing, in what later steps read.
    expect(ok('attempt').output.last.review).toBeNull();
    expect(d.loops[0].rounds[1].steps.find((s: any) => s.step === 'review').state).not.toBe('succeeded');
  }, SLOW);

  it('the route into the loop not taken: everything is skipped and the run succeeds', async () => {
    const { d, ok } = await run({ scenario: 'accept', enter: false });
    expect(d.run.state).toBe('succeeded');
    for (const id of ['attempt_1_resolve', 'attempt_1_probe', 'attempt_1_gate', 'attempt', 'after']) expect(ok(id)).toBeUndefined();
  }, SLOW);

  it('a step output over 256 KB stays readable through the join, by CEL and by ref, and out of its stored row', async () => {
    const big = 400 * 1024;
    const { d, ok } = await run({ scenario: 'retry', big });
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    const joined = JSON.stringify(ok('attempt').output);
    expect(joined.length).toBeLessThan(2000);
    expect(joined).toContain('$artifact');
    expect(ok('after').output.seen).toMatchObject({ summary: 'round 2', feedback_seen: 'notes from round 1', count: 2, rounds: 2 });
    expect(ok('after').output.big_len).toBe(big);
  }, SLOW);

  it('failed in round 2: a resume keeps round 1 and does not repeat it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-rounds-'));
    const block = join(dir, 'block');
    writeFileSync(block, '');
    const { d, run_id } = await run({ scenario: 'retry', block });
    expect(d.run.state).toBe('failed');
    expect(d.loops[0].outcome).toBeNull();
    expect(d.loops[0].rounds.map((r: any) => r.outcome)).toEqual(['retry', null]);
    rmSync(block);
    const r = await h.api.post<{ run_id: string; carried: string[]; rerun: string[] }>(`/v1/runs/${run_id}/resume`, {});
    expect(r.carried).toEqual(expect.arrayContaining(['attempt_1_resolve', 'attempt_1_probe', 'attempt_1_changed', 'attempt_1_review', 'attempt_1_gate']));
    expect(r.rerun).toEqual(expect.arrayContaining(['attempt_2_resolve', 'attempt', 'after']));
    const done = await waitForRun(h.api, r.run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    const ok = (id: string) => done.attempts.find((a: any) => a.node_id === id && a.state === 'succeeded');
    expect(ok('attempt_1_resolve')).toMatchObject({ worker_id: null });
    expect(ok('attempt').output).toMatchObject({ outcome: 'done', count: 2 });
    expect(ok('after').output.seen).toMatchObject({ summary: 'round 2', feedback_seen: 'notes from round 1' });
    expect(done.loops[0].rounds.map((x: any) => x.outcome)).toEqual(['retry', 'done']);
  }, 600_000);
});
