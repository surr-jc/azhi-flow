import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionFile } from '../src/definition/load.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { resolveValue } from '../src/runtime/values.js';

/**
 * ai-sdlc-v2 writes the engineer's brief and each review round's change once, as contexts. Moving inputs into
 * contexts must change nothing the interpreter does: the same order, the same data edges, the same taint, the same
 * diagnostics, and the same input value for every step, down to the key order the model reads.
 */
const before = JSON.parse(readFileSync('test/fixtures/ai-sdlc-v2-before-contexts.json', 'utf8')) as {
  diagnostics: unknown[];
  taint: unknown;
  nodes: Record<string, { deps: string[]; dataDeps: string[] }>;
  inputs: Record<string, never>;
};
const loaded = loadDefinitionFile('examples/ai-sdlc-v2/workflow.yaml');
const bare = compile(loaded.definition!);
const withPackage = compile(loaded.definition!, { pkg: packageFromDirectory('examples/ai-sdlc-v2') });

describe('ai-sdlc-v2 with shared contexts', () => {
  it('loads and compiles, with the same diagnostics as before', () => {
    expect(loaded.diagnostics).toEqual([]);
    expect(bare.ok).toBe(true);
    expect(bare.diagnostics).toEqual(before.diagnostics);
    // With the package: no error, and no warning about a context.
    expect(withPackage.ok).toBe(true);
    expect(withPackage.diagnostics.filter((d) => /context/.test(d.code))).toEqual([]);
  });

  it('keeps every step\'s dependencies, data dependencies and the taint report exactly as before', () => {
    const after = Object.fromEntries(bare.plan!.nodes.map((n) => [n.id, { deps: n.deps, dataDeps: n.dataDeps }]));
    expect(after).toEqual(before.nodes);
    expect(bare.plan!.taint).toEqual(before.taint);
  });

  it('uses the contexts in the steps it meant to, and nowhere else', () => {
    const used = Object.fromEntries(bare.plan!.nodes.filter((n) => n.inputParts).map((n) => [n.id, [...new Set(n.inputParts!.map((p) => p.source))]]));
    expect(used).toEqual({
      build: ['context:delivery_brief'],
      build_static: ['context:delivery_brief'],
      build_untested: ['context:delivery_brief'],
      lite_review_1: ['context:round_1'],
      lite_verify_1: ['context:round_1', 'input'],
      lite_review_2: ['context:round_2'],
      lite_verify_2: ['context:round_2', 'input'],
    });
  });

  const change = (n: number) => ({
    summary: `change ${n}`,
    deviations: ['d'],
    tests_added: ['t'],
    workspace: { stats: { files: n }, diff: `diff ${n}`, diff_truncated: false, tests: { status: 'passed' } },
  });
  const finding = (severity: string) => ({ id: severity, severity, summary: severity });
  const scope = (mode: string) => ({
    inputs: { repo: 'acme/shop' },
    config: { min_confidence: 70 },
    nodes: {
      mode: { output: { mode } },
      intake: { output: { key: 'T-1', title: 'ticket' } },
      plan: { output: { requirements: { ac: ['AC-1'] }, design: { summary: 's', files: ['a'] } } },
      design_review: { output: { data: { answers: ['yes'] } } },
      change_1: { output: change(1) },
      change_2: { output: change(2) },
      lite_review_1: { output: { findings: [finding('critical'), finding('minor'), finding('major')] } },
      lite_review_2: { output: { findings: [finding('minor')] } },
    },
  });
  const rewritten = ['build', 'build_static', 'build_untested', 'lite_review_1', 'lite_verify_1', 'lite_review_2', 'lite_verify_2'];

  it.each(['tested', 'static', 'none'])('gives each rewritten step the very same input value, key order included (mode %s)', (mode) => {
    for (const id of rewritten) {
      const old = resolveValue(before.inputs[id], scope(mode) as never);
      const now = resolveValue((bare.plan!.nodes.find((n) => n.id === id)!.def as unknown as { input: never }).input, scope(mode) as never);
      expect(old, `${id} resolved to nothing before`).toBeTruthy();
      expect(JSON.stringify(now), id).toBe(JSON.stringify(old));
    }
  });

  it('really resolves the values (the comparison above is not between two empty objects)', () => {
    const verify = resolveValue((bare.plan!.nodes.find((n) => n.id === 'lite_verify_1')!.def as unknown as { input: never }).input, scope('tested') as never) as { change: { summary: string }; findings: Array<{ findings: unknown[] }> };
    expect(verify.change.summary).toBe('change 1');
    expect(verify.findings[0]!.findings).toHaveLength(2); // critical and major only
    const build = resolveValue((bare.plan!.nodes.find((n) => n.id === 'build')!.def as unknown as { input: never }).input, scope('static') as never) as { environment: { verification: string; tests_unavailable: boolean } };
    expect(build.environment).toEqual({ tests_unavailable: true, verification: 'static' });
  });
});
