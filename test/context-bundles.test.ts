import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromFiles } from '../src/definition/package.js';
import { staticCatalog, type ToolSpec } from '../src/gateway/types.js';
import { contentHash } from '../src/lib/hash.js';

const tool = (id: string, effect: ToolSpec['effect'], extra: Partial<ToolSpec> = {}): ToolSpec => ({
  id,
  version: 1,
  description: id,
  effect,
  transport: { kind: 'builtin', name: 'fixture' },
  input_schema: { type: 'object' },
  output_schema: { type: 'object', properties: { items: { type: 'array' }, title: { type: 'string' } } },
  ...extra,
});
const catalog = staticCatalog([tool('docs.lookup', 'read', { output_trusted: true }), tool('ci.list-runs', 'read'), tool('jira.create', 'write-dedupable')]);

const files = new Map([
  ['profiles/a@1.yaml', Buffer.from('instructions: x\n')],
  ['schemas/o.json', Buffer.from('{"type":"object","properties":{"ok":{"type":"boolean"}}}')],
  ['scripts/s.py', Buffer.from('print(1)')],
  ['t.md', Buffer.from('{{x}}')],
]);

/** A workflow with a trusted `intake`, a condition with one branch step, an approval, and the nodes under test. */
const wf = (contexts: string, nodes: string) => `
schema_version: "2.0"
id: ctx
config: {channel: C1}
${contexts}
nodes:
  - id: intake
    type: tool
    tool: docs.lookup@1
  - id: gate
    type: condition
    expression: "'a'"
    routes: {a: [branch], b: []}
    default: a
  - id: branch
    type: script
    runtime: python
    entrypoint: scripts/s.py
    output_schema: {type: object, properties: {v: {type: string}}}
  - id: appr
    type: approval
    message: ok?
    role: author
    expires_in: 1d
${nodes}`;

const build = (contexts: string, nodes: string, catalogToUse = catalog) => {
  const text = wf(contexts, nodes);
  const loaded = loadDefinitionText(text);
  if (!loaded.definition) throw new Error(JSON.stringify(loaded.diagnostics));
  const r = compile(loaded.definition, { catalog: catalogToUse, pkg: packageFromFiles('workflow.yaml', new Map([...files, ['workflow.yaml', Buffer.from(text)]])) });
  return { ...r, loaded: loaded.definition, codes: r.diagnostics.map((d) => `${d.severity}:${d.code}${d.node ? `@${d.node}` : ''}`) };
};
const agent = (id: string, extra: string) => `  - id: ${id}
    type: agent
    profile: a@1
    output_schema: schemas/o.json
${extra}`;

describe('context bundles: expansion', () => {
  const CTX = `contexts:
  brief:
    title: {ref: nodes.intake.output.title}
    items: {ref: nodes.intake.output.items}
  extra:
    note: hello
`;

  it('merges bundle keys, in declaration order, before the step\'s own keys, into an ordinary input', () => {
    const r = build(CTX, agent('a1', '    context: [brief, extra]\n    input:\n      mine: {cel: "1 + 1"}\n'));
    expect(r.ok).toBe(true);
    const node = r.plan!.nodes.find((n) => n.id === 'a1')!;
    expect((node.def as { input: object }).input).toEqual({ title: { ref: 'nodes.intake.output.title' }, items: { ref: 'nodes.intake.output.items' }, note: 'hello', mine: { cel: '1 + 1' } });
    expect(Object.keys((node.def as { input: object }).input)).toEqual(['title', 'items', 'note', 'mine']);
    expect(node.inputParts).toEqual([
      { key: 'title', source: 'context:brief' },
      { key: 'items', source: 'context:brief' },
      { key: 'note', source: 'context:extra' },
      { key: 'mine', source: 'input' },
    ]);
  });

  it('works with a bundle and no input of the step\'s own, and on script and report steps', () => {
    const script = `  - id: s1
    type: script
    runtime: python
    entrypoint: scripts/s.py
    context: [brief]
  - id: r1
    type: report
    template: t.md
    context: [brief]
`;
    const r = build(CTX, agent('a1', '    context: [brief]\n') + script);
    expect(r.ok).toBe(true);
    for (const id of ['a1', 's1', 'r1']) expect((r.plan!.nodes.find((n) => n.id === id)!.def as { input: object }).input).toMatchObject({ title: { ref: 'nodes.intake.output.title' } });
  });

  it('leaves the authored definition and its hash alone: only the plan\'s copy has the merged input', () => {
    const r = build(CTX, agent('a1', '    context: [brief]\n'));
    const authoredNode = r.loaded.nodes.find((n) => n.id === 'a1') as { input?: unknown; context?: string[] };
    expect(authoredNode.input).toBeUndefined();
    expect(authoredNode.context).toEqual(['brief']);
    expect(r.plan!.definitionHash).toBe(contentHash(r.loaded));
  });

  it('makes the bundle\'s refs ordinary dependencies and data dependencies, type-checked', () => {
    const r = build(CTX, agent('a1', '    context: [brief]\n'));
    const a1 = r.plan!.nodes.find((n) => n.id === 'a1')!;
    expect(a1.deps).toContain('intake');
    expect(a1.dataDeps).toContain('intake');
    // A ref to a field the producer does not have is an error that names the step and the key.
    const bad = build(`contexts:\n  brief:\n    title: {ref: nodes.intake.output.nope}\n`, agent('a1', '    context: [brief]\n'));
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.find((d) => d.code === 'ref_type')).toMatchObject({ node: 'a1', path: expect.stringContaining('input.title') });
    const unknown = build(`contexts:\n  brief:\n    title: {ref: nodes.ghost.output.x}\n`, agent('a1', '    context: [brief]\n'));
    expect(unknown.codes).toContain('error:unknown_ref_node@a1');
  });

  it('rejects an unknown context, naming what exists', () => {
    const r = build(CTX, agent('a1', '    context: [brief, nope]\n'));
    expect(r.codes).toContain('error:unknown_context@a1');
    expect(r.diagnostics.find((d) => d.code === 'unknown_context')!.message).toContain('brief, extra');
  });

  it('rejects every kind of collision', () => {
    const twice = build(`contexts:\n  one: {k: 1}\n  two: {k: 2}\n`, agent('a1', '    context: [one, two]\n'));
    expect(twice.diagnostics.find((d) => d.code === 'context_collision')!.message).toMatch(/context 'one' and from context 'two'/);
    const own = build(CTX, agent('a1', '    context: [brief]\n    input:\n      title: mine\n'));
    expect(own.diagnostics.find((d) => d.code === 'context_collision')!.message).toMatch(/context 'brief' and from the step's own input/);
  });

  it('needs an object input, and says how to turn a map into one', () => {
    for (const input of ['    input: {map: "{\'a\': 1}"}\n', '    input: {ref: nodes.intake.output}\n', '    input: [1, 2]\n', '    input: 5\n']) {
      const r = build(CTX, agent('a1', `    context: [brief]\n${input}`));
      expect(r.codes, input).toContain('error:context_input_shape@a1');
    }
    const msg = build(CTX, agent('a1', '    context: [brief]\n    input: {map: "{}"}\n')).diagnostics.find((d) => d.code === 'context_input_shape')!.message;
    expect(msg).toContain('{cel:');
  });

  it('is refused on a merge step, whose dependencies decide whether it runs', () => {
    const r = build(CTX, agent('a1', '    context: [brief]\n    merge: any\n    depends_on: [branch]\n'));
    expect(r.codes).toContain('error:context_on_merge@a1');
    expect(r.diagnostics.find((d) => d.code === 'context_on_merge')!.message).toContain('has() guards');
  });

  it('is refused where a node type cannot take it', () => {
    // The schema rejects it on a subworkflow...
    const text = wf('contexts:\n  c:\n    v: 1\n', '  - id: sub\n    type: subworkflow\n    workflow: other\n    context: [c]\n');
    expect(loadDefinitionText(text).diagnostics[0]).toMatchObject({ code: 'schema', node: 'sub', message: expect.stringContaining('context') });
    // ...and so does the compiler, for a definition that did not come through the schema.
    const def = { schema_version: '2.0', id: 'x', contexts: { c: { v: 1 } }, nodes: [{ id: 'sub', type: 'subworkflow', workflow: 'other', context: ['c'] }] };
    expect(compile(def as never).diagnostics.map((d) => d.code)).toContain('context_unsupported_node');
  });

  it('warns about a bundle nothing uses', () => {
    const r = build(CTX, agent('a1', '    context: [brief]\n'));
    expect(r.diagnostics.find((d) => d.code === 'unused_context')).toMatchObject({ severity: 'warning', message: expect.stringContaining("'extra'") });
    expect(build(CTX, agent('a1', '    context: [brief, extra]\n')).codes.filter((c) => c.includes('unused_context'))).toEqual([]);
  });

  it('names the bundle when it causes a cycle', () => {
    const r = build(`contexts:\n  loopy:\n    v: {ref: nodes.later.output.ok}\n`, agent('first', '    context: [loopy]\n') + agent('later', '    input: {ref: nodes.first.output}\n'));
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'cycle')!.message).toContain("step 'first' takes 'later' through context 'loopy' (key 'v')");
  });
});

describe('context bundles: coupling', () => {
  it('warns when a bundle makes a step wait on a step that can be skipped', () => {
    const r = build(`contexts:\n  c:\n    v: {ref: nodes.branch.output.v}\n`, agent('a1', '    context: [c]\n'));
    expect(r.codes).toContain('warning:context_may_skip@a1');
    expect(r.diagnostics.find((d) => d.code === 'context_may_skip')!.message).toContain("context 'c' key 'v' makes step 'a1' wait on 'branch'");
  });

  it('warns for a step below an approval, which a rejection skips', () => {
    const r = build(`contexts:\n  c:\n    v: {ref: nodes.appr.output.decision}\n`, agent('a1', '    context: [c]\n'));
    expect(r.codes).toContain('warning:context_may_skip@a1');
  });

  it('does not warn for a step that always runs, or one the step already waits on', () => {
    expect(build(`contexts:\n  c:\n    v: {ref: nodes.intake.output.title}\n`, agent('a1', '    context: [c]\n')).codes.filter((c) => c.includes('may_skip'))).toEqual([]);
    // Already depends on `branch` (depends_on), directly and through an earlier step that does.
    const direct = build(`contexts:\n  c:\n    v: {ref: nodes.branch.output.v}\n`, agent('a1', '    context: [c]\n    depends_on: [branch]\n'));
    expect(direct.codes.filter((c) => c.includes('may_skip'))).toEqual([]);
    const indirect = build(`contexts:\n  c:\n    v: {ref: nodes.branch.output.v}\n`, agent('mid', '    input: {ref: nodes.branch.output}\n') + agent('a1', '    context: [c]\n    input:\n      m: {ref: nodes.mid.output}\n'));
    expect(indirect.codes.filter((c) => c.includes('may_skip'))).toEqual([]);
    // Its own condition route is not new either.
    const gated = build(`contexts:\n  c:\n    v: {ref: nodes.gate.output.route}\n`, agent('a1', '    context: [c]\n'));
    expect(gated.codes.filter((c) => c.includes('may_skip'))).toEqual([]);
  });

  it('warns once per skippable step, not once per key', () => {
    const r = build(`contexts:\n  c:\n    one: {ref: nodes.branch.output.v}\n    two: {cel: "nodes.branch.output.v + 'x'"}\n`, agent('a1', '    context: [c]\n'));
    expect(r.diagnostics.filter((d) => d.code === 'context_may_skip')).toHaveLength(1);
  });

  it('names a bundle that taints every step using it, as the same untrusted data would inline', () => {
    const untrusted = `contexts:\n  c:\n    runs: {ref: nodes.fetch.output.items}\n`;
    const fetch = `  - id: fetch\n    type: tool\n    tool: ci.list-runs@1\n`;
    const r = build(untrusted, fetch + `  - id: s1\n    type: script\n    runtime: python\n    entrypoint: scripts/s.py\n    context: [c]\n`);
    expect(r.codes).toContain('warning:context_taints@s1');
    expect(r.diagnostics.find((d) => d.code === 'context_taints')!.message).toContain("context 'c' key 'runs' carries untrusted data from 'fetch'");
    // A step that already reads the untrusted step itself is not blamed on the bundle.
    const already = build(untrusted, fetch + `  - id: s1\n    type: script\n    runtime: python\n    entrypoint: scripts/s.py\n    context: [c]\n    input:\n      raw: {ref: nodes.fetch.output}\n`);
    expect(already.codes.filter((c) => c.includes('context_taints'))).toEqual([]);
  });

  it('keeps the taint rule: an ungated write after an agent that got untrusted data through a bundle is still an error', () => {
    const fetch = `  - id: fetch\n    type: tool\n    tool: ci.list-runs@1\n`;
    const write = `  - id: post\n    type: tool\n    tool: jira.create@1\n    arguments: {t: {ref: nodes.a1.output.ok}}\n`;
    const viaBundle = build(`contexts:\n  c:\n    runs: {ref: nodes.fetch.output.items}\n`, fetch + agent('a1', '    context: [c]\n') + write);
    const inline = build('', fetch + agent('a1', '    input:\n      runs: {ref: nodes.fetch.output.items}\n') + write);
    const errs = (r: typeof viaBundle) => r.codes.filter((c) => c.startsWith('error')).map((c) => c.replace(/@.*/, ''));
    expect(errs(inline)).toContain('error:tainted_write_ungated');
    expect(errs(viaBundle)).toEqual(errs(inline));
  });
});
