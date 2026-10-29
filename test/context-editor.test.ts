import { describe, expect, it } from 'vitest';
import { contextsUsed, graphOf, renameStep } from '../web/src/graph.js';

/** What the editor does with shared contexts: draws the edges the compiler will order by, shows the merged input, keeps names in step. */
const def = () => ({
  id: 'w',
  contexts: { brief: { title: { ref: 'nodes.intake.output.title' }, items: { cel: 'nodes.intake.output.items + nodes.extra.output.more' } }, fixed: { note: 'hello' } },
  nodes: [
    { id: 'intake', type: 'tool', tool: 'docs.lookup@1' },
    { id: 'extra', type: 'tool', tool: 'docs.lookup@1' },
    { id: 'a1', type: 'agent', profile: 'a@1', context: ['brief', 'fixed'], input: { mine: 1 } },
    { id: 'a2', type: 'agent', profile: 'a@1', context: ['brief'] },
    { id: 'a3', type: 'agent', profile: 'a@1', input: { ref: 'nodes.intake.output' } },
  ],
});

describe('graphOf with contexts', () => {
  it('draws an edge for every step a used context reads, as the compiler orders them', () => {
    const g = graphOf(def());
    expect(g.find((n) => n.id === 'a1')!.deps.sort()).toEqual(['extra', 'intake']);
    expect(g.find((n) => n.id === 'a2')!.deps.sort()).toEqual(['extra', 'intake']);
    expect(g.find((n) => n.id === 'a3')!.deps).toEqual(['intake']);
  });

  it('gives the card and the drawer the step as it compiles: bundle keys first, then its own', () => {
    const a1 = graphOf(def()).find((n) => n.id === 'a1')!;
    expect(Object.keys(a1.def!.input)).toEqual(['title', 'items', 'note', 'mine']);
    expect(a1.bundles).toEqual([
      { name: 'brief', from: ['intake', 'extra'] },
      { name: 'fixed', from: [] },
    ]);
    // The authored step is not touched.
    expect(def().nodes[2]!.input).toEqual({ mine: 1 });
  });

  it('shows no merged input when the step\'s input is an expression, as the compiler rejects that', () => {
    const d = def();
    d.nodes[3] = { id: 'a2', type: 'agent', profile: 'a@1', context: ['brief'], input: { map: "{'a': 1}" } } as never;
    const a2 = graphOf(d).find((n) => n.id === 'a2')!;
    expect(a2.def!.input).toEqual({ map: "{'a': 1}" });
    expect(a2.deps.sort()).toEqual(['extra', 'intake']); // the edges are still drawn
  });

  it('ignores a context that does not exist, and does not draw a step\'s edge to itself', () => {
    const d = def();
    d.nodes[2] = { id: 'a1', type: 'agent', profile: 'a@1', context: ['nope'] } as never;
    expect(graphOf(d).find((n) => n.id === 'a1')!.deps).toEqual([]);
    const self = { id: 'w', contexts: { c: { v: { ref: 'nodes.a1.output.x' } } }, nodes: [{ id: 'a1', type: 'agent', profile: 'a@1', context: ['c'] }] };
    expect(graphOf(self).find((n) => n.id === 'a1')!.deps).toEqual([]);
  });

  it('is unchanged for a workflow without contexts', () => {
    const plain = { nodes: [{ id: 'a', type: 'tool' }, { id: 'b', type: 'agent', input: { ref: 'nodes.a.output' } }] };
    const g = graphOf(plain);
    expect(g[1]!.deps).toEqual(['a']);
    expect(g[1]!.def).toBe(plain.nodes[1]);
    expect(g[1]!.bundles).toBeUndefined();
  });
});

describe('renaming a step with contexts', () => {
  it('rewrites the refs and CEL inside contexts, and the steps that use them', () => {
    const r = renameStep(def() as never, 'intake', 'fetch') as ReturnType<typeof def>;
    expect(r.contexts.brief.title).toEqual({ ref: 'nodes.fetch.output.title' });
    expect(r.contexts.brief.items).toEqual({ cel: 'nodes.fetch.output.items + nodes.extra.output.more' });
    expect(r.nodes.find((n) => n.id === 'fetch')).toBeTruthy();
    expect(graphOf(r).find((n) => n.id === 'a1')!.deps.sort()).toEqual(['extra', 'fetch']);
  });

  it('does not add a contexts key to a workflow that has none', () => {
    const plain = { id: 'w', nodes: [{ id: 'a', type: 'tool' }, { id: 'b', type: 'agent', input: { ref: 'nodes.a.output' } }] };
    const r = renameStep(plain as never, 'a', 'z');
    expect('contexts' in r).toBe(false);
  });

  it('leaves a step whose name only starts with the old one alone', () => {
    const d = def();
    d.contexts.brief.title = { ref: 'nodes.intake_two.output.title' } as never;
    const r = renameStep(d as never, 'intake', 'fetch') as ReturnType<typeof def>;
    expect(r.contexts.brief.title).toEqual({ ref: 'nodes.intake_two.output.title' });
  });
});

describe('contextsUsed', () => {
  it('lists each context with the steps that use it, so an unused one can be flagged', () => {
    const d = def();
    const nodes = graphOf(d);
    expect(contextsUsed({ def: d, nodes })).toEqual([
      { name: 'brief', values: d.contexts.brief, steps: ['a1', 'a2'] },
      { name: 'fixed', values: d.contexts.fixed, steps: ['a1'] },
    ]);
    d.nodes = d.nodes.filter((n) => n.id !== 'a1');
    expect(contextsUsed({ def: d, nodes: graphOf(d) }).find((c) => c.name === 'fixed')!.steps).toEqual([]);
  });

  it('is empty for a workflow without contexts', () => {
    expect(contextsUsed({ def: { id: 'w' }, nodes: [] })).toEqual([]);
  });
});
