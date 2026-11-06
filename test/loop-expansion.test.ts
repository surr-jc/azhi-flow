import { describe, expect, it } from 'vitest';
import { expandLoops, rewriteCel, type LoopBlockNode } from '../src/compiler/loops.js';
import type { NodeDef, WorkflowDefinition } from '../src/definition/types.js';

/**
 * Multi-step loops, as the compiler expands them: every round becomes ordinary numbered steps and a gate, and the loop
 * itself becomes the join. The shape checked here ran on the real interpreter in the spike (all paths, resume, large outputs).
 */
const script = (id: string, input: string, extra: Record<string, unknown> = {}) => ({ id, type: 'script', runtime: 'python', entrypoint: `scripts/${id}.py`, input: { map: input }, ...extra }) as unknown as NodeDef;

const loop = (over: Partial<LoopBlockNode> = {}): LoopBlockNode => ({
  id: 'attempt',
  type: 'loop',
  max_iterations: 2,
  on_max: 'continue',
  initial: { feedback: null, prev_diff: null },
  next: { feedback: { cel: 'nodes.review.output.notes' }, prev_diff: { ref: 'nodes.resolve.output.diff' } },
  body: [
    script('resolve', "{'round': iteration + 1, 'feedback': state.feedback}"),
    script('probe', "{'scenario': inputs.scenario}"),
    { id: 'changed', type: 'condition', expression: "nodes.resolve.output.diff != state.prev_diff ? 'changed' : 'same'", routes: { changed: ['review'], same: [] }, default: 'changed' },
    script('review', "{'summary': nodes.resolve.output.summary}"),
  ],
  exit: [
    { when: "nodes.changed.output.route == 'same'", outcome: 'no_progress', reason: 'The change did not move' },
    { when: 'nodes.review.output.injection', outcome: 'stop', reason: 'Prompt injection reported' },
    { when: 'nodes.review.output.ok', outcome: 'done', reason: 'Checks passed' },
  ],
  ...over,
});

const outer = { id: 'outer', type: 'condition', expression: "'yes'", routes: { yes: ['attempt'], no: [] }, default: 'no' } as NodeDef;
const after = script('after', "{'summary': nodes.attempt.output.last.resolve.summary}");
const wf = (...nodes: unknown[]) => ({ schema_version: '2.0', id: 't', nodes }) as WorkflowDefinition;
const byId = (d: WorkflowDefinition) => new Map(d.nodes.map((n) => [n.id, n as any]));
const codes = (r: ReturnType<typeof expandLoops>) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

describe('rewriting CEL for one round', () => {
  const scope = { ids: new Map([['review', 'attempt_2_review']]), state: { feedback: { ref: 'nodes.attempt_1_review.output.notes' }, count: { cel: 'size(inputs.x) + 1' }, none: null, label: "it's" }, iteration: 1 };
  const r = (s: string) => rewriteCel(s, scope);

  it('renames the steps of the body and leaves the others', () => {
    expect(r('nodes.review.output.ok && nodes.other.output.ok')).toBe('nodes.attempt_2_review.output.ok && nodes.other.output.ok');
    expect(r("nodes['review'].output.ok")).toBe("nodes['attempt_2_review'].output.ok");
    expect(r('has(nodes.review)')).toBe('has(nodes.attempt_2_review)');
  });
  it('never touches a string literal', () => {
    expect(r("'nodes.review.output' + \"state.feedback\"")).toBe("'nodes.review.output' + \"state.feedback\"");
    expect(r("'it\\'s nodes.review' + nodes.review.output.x")).toBe("'it\\'s nodes.review' + nodes.attempt_2_review.output.x");
    expect(r("'''nodes.review''' + r'\\' + nodes.review.output.x")).toBe("'''nodes.review''' + r'\\' + nodes.attempt_2_review.output.x");
  });
  it('never touches a field or a longer name', () => {
    expect(r('x.nodes.review + my_nodes.review + inputs.state.feedback + x.iteration + iteration_count')).toBe('x.nodes.review + my_nodes.review + inputs.state.feedback + x.iteration + iteration_count');
  });
  it('replaces state with its value for this round', () => {
    expect(r('state.feedback')).toBe('nodes.attempt_1_review.output.notes');
    expect(r('state.feedback.deep')).toBe('nodes.attempt_1_review.output.notes.deep');
    expect(r('state.count * 2')).toBe('(size(inputs.x) + 1) * 2');
    expect(r('state.none == null')).toBe('null == null');
    expect(r('state.label')).toBe("'it\\'s'");
    expect(r("state['feedback']")).toBe('nodes.attempt_1_review.output.notes');
  });
  it('replaces iteration with its number', () => {
    expect(r('iteration + 1')).toBe('1 + 1');
  });
  it('reports a state key the loop does not define', () => {
    const problems: string[] = [];
    rewriteCel('state.nope', { ...scope, problem: (m) => problems.push(m) });
    expect(problems.join()).toContain('nope');
  });
});

describe('expanding a loop', () => {
  it('leaves a workflow with no multi-step loop as it is, the same object', () => {
    const d = wf(outer, { id: 'old', type: 'loop', max_iterations: 2, exit: 'true', node: { type: 'script', runtime: 'python', entrypoint: 'a.py' } });
    const r = expandLoops(d);
    expect(r.def).toBe(d);
    expect(r.origins.size).toBe(0);
    expect(r.diagnostics).toEqual([]);
  });

  it('writes out each round, in order, then the join under the loop id', () => {
    const r = expandLoops(wf(outer, loop(), after));
    expect(codes(r)).toEqual([]);
    expect(r.def.nodes.map((n) => n.id)).toEqual([
      'outer',
      'attempt_1_resolve', 'attempt_1_probe', 'attempt_1_changed', 'attempt_1_review', 'attempt_1_gate',
      'attempt_2_resolve', 'attempt_2_probe', 'attempt_2_changed', 'attempt_2_review', 'attempt_2_gate',
      'attempt',
      'after',
    ]);
  });

  it('puts every first step of a round on the route into it, even one that reads only inputs', () => {
    const n = byId(expandLoops(wf(outer, loop(), after)).def);
    expect(n.get('outer').routes.yes).toEqual(['attempt_1_resolve', 'attempt_1_probe']);
    expect(n.get('attempt_1_gate').routes.retry).toEqual(['attempt_2_resolve', 'attempt_2_probe']);
  });

  it('never puts a step on an inner route on the route into a round too, whichever order the body lists them', () => {
    const routed = script('routed', '{}');
    const choose = { id: 'choose', type: 'condition', expression: "'a'", routes: { a: ['routed'], b: [] }, default: 'b' } as NodeDef;
    for (const body of [[choose, routed], [routed, choose]]) {
      const n = byId(expandLoops(wf(loop({ body, exit: [{ when: 'true', outcome: 'done' }] }))).def);
      expect(n.get('attempt_1_gate').routes.retry).toEqual(['attempt_2_choose']);
      expect(n.get('attempt_2_choose').routes.a).toEqual(['attempt_2_routed']);
    }
  });

  it('makes each gate a merge that waits for its whole round, and ends the last round as exhausted', () => {
    const n = byId(expandLoops(wf(outer, loop(), after)).def);
    const g1 = n.get('attempt_1_gate');
    expect(g1).toMatchObject({ type: 'condition', merge: 'any', default: 'stop', depends_on: ['attempt_1_resolve', 'attempt_1_probe', 'attempt_1_changed', 'attempt_1_review'] });
    expect(Object.keys(g1.routes).sort()).toEqual(['done', 'no_progress', 'retry', 'stop']);
    expect(g1.expression).toBe("(nodes.attempt_1_changed.output.route == 'same') ? 'no_progress' : ((nodes.attempt_1_review.output.injection) ? 'stop' : ((nodes.attempt_1_review.output.ok) ? 'done' : 'retry'))");
    const g2 = n.get('attempt_2_gate');
    expect(Object.keys(g2.routes).sort()).toEqual(['done', 'exhausted', 'no_progress', 'stop']);
    expect(g2.routes.exhausted).toEqual([]);
    expect(g2.expression).toContain("'exhausted'");
  });

  it('makes the join wait for every gate and name every step output, so later steps depend on it alone', () => {
    const join = byId(expandLoops(wf(outer, loop(), after)).def).get('attempt');
    expect(join).toMatchObject({ type: 'loop', merge: 'any', max_iterations: 2, on_max: 'continue', depends_on: ['attempt_1_gate', 'attempt_2_gate'] });
    expect(join.reasons).toEqual({ no_progress: 'The change did not move', stop: 'Prompt injection reported', done: 'Checks passed' });
    expect(join.rounds[1]).toEqual({ gate: 'attempt_2_gate', steps: { resolve: { ref: 'nodes.attempt_2_resolve.output' }, probe: { ref: 'nodes.attempt_2_probe.output' }, review: { ref: 'nodes.attempt_2_review.output' } } });
    expect(join.body).toBeUndefined();
    expect(join.exit).toBeUndefined();
  });

  it('gives round 1 the initial state and later rounds the previous round next', () => {
    const n = byId(expandLoops(wf(outer, loop(), after)).def);
    expect(n.get('attempt_1_resolve').input.map).toBe("{'round': 0 + 1, 'feedback': null}");
    expect(n.get('attempt_2_resolve').input.map).toBe("{'round': 1 + 1, 'feedback': (nodes.attempt_1_review.output.notes)}");
    expect(n.get('attempt_2_changed').expression).toBe("nodes.attempt_2_resolve.output.diff != nodes.attempt_1_resolve.output.diff ? 'changed' : 'same'");
    expect(n.get('attempt_2_changed').routes).toEqual({ changed: ['attempt_2_review'], same: [] });
  });

  it('carries a state key the next map leaves out, and lets next read the state it replaces', () => {
    const r = expandLoops(wf(loop({ max_iterations: 3, initial: { base: { ref: 'inputs.base' }, hops: 0 }, next: { hops: { cel: 'state.hops + 1' } }, body: [script('resolve', "{'b': state.base, 'h': state.hops}")], exit: [{ when: 'nodes.resolve.output.ok', outcome: 'done' }] })));
    expect(codes(r)).toEqual([]);
    const n = byId(r.def);
    expect(n.get('attempt_3_resolve').input.map).toBe("{'b': inputs.base, 'h': ((0 + 1) + 1)}");
  });

  it('keeps a plain ref plain, so workspace.from stays valid across rounds', () => {
    const agent = { id: 'fix', type: 'agent', profile: 'p@1', output_schema: {}, input: { c: { ref: 'state.change.summary' } }, workspace: { repo: { ref: 'inputs.repo' }, ref: { cel: "state.ref + '/x'" }, from: { ref: 'state.change' }, mode: 'write' } };
    const r = expandLoops(wf(loop({ max_iterations: 2, initial: { change: { ref: 'nodes.triage.output.change' }, ref: 'refs/heads/main' }, next: { change: { ref: 'nodes.fix.output.workspace' } }, body: [agent as unknown as NodeDef], exit: [{ when: 'nodes.fix.output.ok', outcome: 'done' }] })));
    expect(codes(r)).toEqual([]);
    const n = byId(r.def);
    expect(n.get('attempt_1_fix').workspace.from).toEqual({ ref: 'nodes.triage.output.change' });
    expect(n.get('attempt_2_fix').workspace.from).toEqual({ ref: 'nodes.attempt_1_fix.output.workspace' });
    expect(n.get('attempt_2_fix').input.c).toEqual({ ref: 'nodes.attempt_1_fix.output.workspace.summary' });
    expect(n.get('attempt_1_fix').workspace.ref).toEqual({ cel: "'refs/heads/main' + '/x'" });
    expect(n.get('attempt_1_fix').workspace.repo).toEqual({ ref: 'inputs.repo' });
  });

  it('rewrites a tool step, its arguments and its guard', () => {
    const tool = { id: 'read', type: 'tool', tool: 'a.b@1', arguments: { n: { ref: 'nodes.resolve.output.n' } }, guard: 'args.n == nodes.resolve.output.n' };
    const n = byId(expandLoops(wf(loop({ body: [script('resolve', '{}'), tool as unknown as NodeDef], exit: [{ when: 'nodes.read.output.ok', outcome: 'done' }] }))).def);
    expect(n.get('attempt_2_read').arguments.n).toEqual({ ref: 'nodes.attempt_2_resolve.output.n' });
    expect(n.get('attempt_2_read').guard).toBe('args.n == nodes.attempt_2_resolve.output.n');
  });

  it('applies an override to its round only', () => {
    const agent = { id: 'fix', type: 'agent', profile: 'p@1', output_schema: {} };
    const n = byId(expandLoops(wf(loop({ body: [agent as unknown as NodeDef], overrides: { 2: { fix: { profile: 'p@2' } } }, exit: [{ when: 'nodes.fix.output.ok', outcome: 'done' }] }))).def);
    expect(n.get('attempt_1_fix').profile).toBe('p@1');
    expect(n.get('attempt_2_fix').profile).toBe('p@2');
  });

  it('applies what the loop waits on to the first steps of round 1 only', () => {
    const n = byId(expandLoops(wf(script('before', '{}'), loop({ depends_on: ['before'] }))).def);
    expect(n.get('attempt_1_resolve').depends_on).toEqual(['before']);
    expect(n.get('attempt_1_review').depends_on).toBeUndefined();
    expect(n.get('attempt_2_resolve').depends_on).toBeUndefined();
  });

  it('gives each round its own copy of a context, and drops one only rounds use', () => {
    const d = { ...wf(loop({ initial: { hint: 'h' }, next: undefined, body: [script('resolve', "{'n': 1}"), script('review', '', { input: {}, context: ['round', 'shared'] })], exit: [{ when: 'nodes.review.output.ok', outcome: 'done' }] }), script('outside', '', { input: {}, context: ['shared'] })), contexts: { round: { change: { ref: 'nodes.resolve.output.diff' }, hint: { cel: "state.hint + '!'" } }, shared: { base: { ref: 'inputs.base' } }, unused: { x: 1 } } } as WorkflowDefinition;
    const r = expandLoops(d);
    expect(codes(r)).toEqual([]);
    const n = byId(r.def);
    expect(n.get('attempt_2_review').context).toEqual(['attempt_2_round', 'attempt_2_shared']);
    expect(r.def.contexts!.attempt_2_round).toEqual({ change: { ref: 'nodes.attempt_2_resolve.output.diff' }, hint: { cel: "'h' + '!'" } });
    expect(r.def.contexts!.round).toBeUndefined();
    expect(r.def.contexts!.shared).toBeDefined();
    expect(r.def.contexts!.unused).toBeDefined();
    // A step that reads the round only through a bundle still waits inside the round.
    expect(n.get('attempt_1_gate').routes.retry).toEqual(['attempt_2_resolve']);
  });

  it('records where each generated step came from', () => {
    const { origins } = expandLoops(wf(loop()));
    expect(origins.get('attempt_2_review')).toEqual({ loop: 'attempt', round: 2, step: 'review' });
    expect(origins.get('attempt_1_gate')).toEqual({ loop: 'attempt', round: 1, step: 'gate' });
    expect(origins.has('attempt')).toBe(false);
  });

  it('does not change the definition it was given', () => {
    const d = wf(outer, loop(), after);
    const before = JSON.stringify(d);
    expandLoops(d);
    expect(JSON.stringify(d)).toBe(before);
  });

  it('expands two loops, the second reading the first through its join', () => {
    const second = loop({ id: 'second', initial: { from_first: { ref: 'nodes.attempt.output.outcome' }, feedback: null, prev_diff: null } });
    const r = expandLoops(wf(loop(), second));
    expect(codes(r)).toEqual([]);
    expect(byId(r.def).get('second_1_resolve')).toBeDefined();
  });
});

describe('what a loop cannot be', () => {
  const bad = (over: Partial<LoopBlockNode>, ...rest: unknown[]) => codes(expandLoops(wf(loop(over), ...rest)));

  it('refuses approvals, notifications, parallel and nested loops in the body', () => {
    for (const type of ['approval', 'notify', 'parallel', 'loop']) {
      expect(bad({ body: [{ id: 'x', type } as unknown as NodeDef] })).toContain('loop_body_unsupported');
    }
  });
  it('refuses an empty body, no exit and fields that would be ignored', () => {
    expect(bad({ body: [] })).toContain('loop_invalid');
    expect(bad({ exit: [] })).toContain('loop_invalid');
    expect(bad({ merge: 'any' } as never)).toContain('loop_invalid');
    expect(bad({ timeout: '1m' } as never)).toContain('loop_invalid');
  });
  it('refuses an outcome it does not know, and two reasons for one outcome', () => {
    expect(bad({ exit: [{ when: 'true', outcome: 'retry' as never }] })).toContain('loop_invalid');
    expect(bad({ exit: [{ when: 'a', outcome: 'done', reason: 'x' }, { when: 'b', outcome: 'done', reason: 'y' }] })).toContain('loop_reason_conflict');
  });
  it('refuses duplicate steps, and a step called gate', () => {
    expect(bad({ body: [script('x', '{}'), script('x', '{}')] })).toContain('loop_step_invalid');
    expect(bad({ body: [script('gate', '{}')] })).toContain('loop_step_invalid');
  });
  it('refuses a step that hides a step outside the loop', () => {
    expect(bad({}, script('review', '{}'))).toContain('loop_step_shadows');
  });
  it('refuses a generated id that is already taken', () => {
    expect(bad({}, script('attempt_1_review', '{}'))).toContain('loop_step_shadows');
  });
  it('refuses a step outside that reads inside a round', () => {
    expect(bad({}, script('peek', '{"a": nodes.attempt_1_review.output.x}'))).toContain('loop_internal_ref');
    expect(bad({}, { ...(script('peek', '{}') as object), depends_on: ['attempt_2_review'] })).toContain('loop_internal_ref');
  });
  it('refuses a body with a step that reads the loop itself', () => {
    expect(bad({ body: [script('x', '{"a": nodes.attempt.output.count}')], exit: [{ when: 'true', outcome: 'done' }] })).toContain('loop_self_reference');
  });
  it('refuses a state key that was never set, and a next key with no initial value', () => {
    expect(bad({ body: [script('x', '{"a": state.nope}')], exit: [{ when: 'true', outcome: 'done' }] })).toContain('loop_unknown_state');
    expect(bad({ next: { nope: 1 } })).toContain('loop_unknown_state');
  });
  it('refuses an override for a round or a step that does not exist, or one that changes identity', () => {
    expect(bad({ overrides: { 3: { resolve: { timeout: '1m' } } } })).toContain('loop_invalid');
    expect(bad({ overrides: { 2: { nope: { timeout: '1m' } } } })).toContain('loop_invalid');
    expect(bad({ overrides: { 2: { resolve: { id: 'x' } } } })).toContain('loop_invalid');
    expect(bad({ overrides: { 2: { resolve: { type: 'tool' } } } })).toContain('loop_invalid');
  });
  it('refuses a body where every step waits on another', () => {
    const a = { ...(script('a', '{"x": nodes.b.output.x}') as object) };
    const b = { ...(script('b', '{"x": nodes.a.output.x}') as object) };
    expect(bad({ body: [a as NodeDef, b as NodeDef], exit: [{ when: 'true', outcome: 'done' }] })).toContain('loop_invalid');
  });
  it('returns the definition unexpanded when anything is wrong', () => {
    const d = wf(loop({ body: [] }));
    expect(expandLoops(d).def).toBe(d);
  });
});
