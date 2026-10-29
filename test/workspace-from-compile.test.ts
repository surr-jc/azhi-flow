import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';

const WS = `
      repo: acme/shop
      ref: HEAD
      credential: read`;

/** A write-mode `build` step and a `review` step that continues from it; `review` is the part under test. */
const wf = (review: string, extra = '') => `
schema_version: "2.0"
id: cont
nodes:
  - id: build
    type: agent
    executor: opencode
    profile: builder@1
    output_schema: {type: object, properties: {summary: {type: string}}, required: [summary]}
    workspace:${WS}
      mode: write
${extra}  - id: review
    type: agent
    executor: opencode
    profile: reviewer@1
    output_schema: {type: object, properties: {ok: {type: boolean}}}
    workspace:${WS}
${review}
`;

const codes = (text: string) => {
  const loaded = loadDefinitionText(text);
  expect(loaded.diagnostics).toEqual([]);
  const r = compile(loaded.definition!);
  return { ...r, codes: r.diagnostics.map((d) => `${d.severity}:${d.code}`) };
};

describe('workspace.from', () => {
  it('compiles a ref to the workspace change of a write-mode step, and orders the steps by it', () => {
    const r = codes(wf('      from: {ref: nodes.build.output.workspace}'));
    expect(r.ok).toBe(true);
    expect(r.codes.filter((c) => c.startsWith('error'))).toEqual([]);
    const review = r.plan!.nodes.find((n) => n.id === 'review')!;
    expect(review.deps).toContain('build');
    expect(review.dataDeps).toContain('build');
  });

  it('accepts a producer of another node type when its declared output has base_sha and files', () => {
    const select = `  - id: pick
    type: script
    runtime: python
    entrypoint: scripts/pick.py
    output_schema:
      type: object
      properties: {base_sha: {type: string}, files: {type: array}}
`;
    const r = codes(wf('      from: {ref: nodes.pick.output}', select));
    expect(r.codes.filter((c) => c.startsWith('error'))).toEqual([]);
  });

  it('rejects CEL, a map and a literal: the step it continues from must be a plain ref', () => {
    for (const v of ['{cel: "nodes.build.output.workspace"}', '{map: "nodes.build.output.workspace"}', 'abc123', '{ref: inputs.change}']) {
      expect(codes(wf(`      from: ${v}`)).codes, v).toContain('error:workspace_from_invalid');
    }
  });

  it('rejects base_ref together with from', () => {
    expect(codes(wf('      from: {ref: nodes.build.output.workspace}\n      base_ref: refs/heads/main')).codes).toContain('error:workspace_from_base_ref');
  });

  it('rejects a ref that is not a workspace change', () => {
    expect(codes(wf('      from: {ref: nodes.build.output.summary}')).codes).toContain('error:workspace_from_type');
    // The whole output of a write-mode step is an object, but the change is in its `workspace` field.
    expect(codes(wf('      from: {ref: nodes.build.output}')).codes).toContain('error:workspace_from_type');
  });

  it('warns, and checks at run time, when the producer declares no output type', () => {
    const untyped = `  - id: pick
    type: script
    runtime: python
    entrypoint: scripts/pick.py
`;
    const r = codes(wf('      from: {ref: nodes.pick.output}', untyped));
    expect(r.codes).toContain('warning:workspace_from_untyped');
    expect(r.codes.filter((c) => c.startsWith('error'))).toEqual([]);
  });

  it('names an unknown step and refuses a step that continues from itself', () => {
    expect(codes(wf('      from: {ref: nodes.nope.output.workspace}')).codes).toContain('error:unknown_ref_node');
    expect(codes(wf('      from: {ref: nodes.review.output.workspace}')).codes).toContain('error:self_reference');
  });

  it('keeps the existing rule that a workspace needs the OpenCode executor', () => {
    const text = wf('      from: {ref: nodes.build.output.workspace}').replace(/(id: review\n    type: agent\n)    executor: opencode\n/, '$1');
    expect(codes(text).codes).toContain('error:workspace_unsupported');
  });
});
