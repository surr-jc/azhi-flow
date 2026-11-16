import { describe, expect, it } from 'vitest';
import type { ExecutionPlan, PlanNode } from '../src/compiler/plan.js';
import type { PackageManifest } from '../src/definition/package.js';
import { checkResume } from '../src/plan/resume-check.js';

/** Whether a failed run can continue on another version: what is kept, what reruns, and when it is refused. */
const node = (id: string, deps: string[], entrypoint = `scripts/${id}.py`): PlanNode =>
  ({ id, type: 'script', deps, dataDeps: deps, def: { id, type: 'script', runtime: 'python', entrypoint }, timeoutMs: 1000, maxAttempts: 1 }) as unknown as PlanNode;
const plan = (...nodes: PlanNode[]): ExecutionPlan => ({ format: 'azhi-plan/1', compiler: 't', workflowId: 'w', definitionHash: 'h', config: {}, nodes, taint: {} as never });
const manifest = (files: Record<string, string>): PackageManifest => ({ format: 'azhi-package/1', workflow: 'workflow.yaml', files: Object.entries(files).map(([path, sha256]) => ({ path, sha256, size: 1 })) });
const set = (...ids: string[]) => new Set(ids);

const chain = plan(node('a', []), node('b', ['a']), node('c', ['b']));
const files = { 'workflow.yaml': 'w1', 'scripts/a.py': 'a1', 'scripts/b.py': 'b1', 'scripts/c.py': 'c1' };
const base = { oldPlan: chain, oldManifest: manifest(files), succeeded: set('a'), skipped: set(), failed: set('b') };

describe('checkResume', () => {
  it('keeps everything that succeeded when the version is the same', () => {
    const r = checkResume({ ...base, newPlan: chain, newManifest: manifest(files) });
    expect(r).toMatchObject({ possible: true, carried: ['a'], rerun: ['b', 'c'], deviation: 0 });
    expect(r.steps.map((s) => s.change)).toEqual(['same', 'same', 'same']);
  });

  it('reruns from a fixed script and keeps the steps before it', () => {
    const r = checkResume({ ...base, newPlan: chain, newManifest: manifest({ ...files, 'scripts/b.py': 'b2', 'workflow.yaml': 'w2' }) });
    expect(r).toMatchObject({ possible: true, carried: ['a'], rerun: ['b', 'c'], deviation: 0 });
    expect(r.steps.find((s) => s.id === 'b')).toMatchObject({ change: 'changed', action: 'rerun', was: 'failed' });
  });

  it('refuses when a step that succeeded changed and takes the rest with it', () => {
    const r = checkResume({
      ...base,
      succeeded: set('a', 'b'),
      failed: set('c'),
      newPlan: chain,
      newManifest: manifest({ ...files, 'scripts/a.py': 'a2' }),
    });
    expect(r.possible).toBe(false);
    expect(r.deviation).toBe(1);
    expect(r.reason).toMatch(/too different.*a, b/);
  });

  it('allows a small change among many finished steps', () => {
    const wide = plan(node('a', []), node('b', []), node('c', []), node('d', ['a', 'b', 'c']));
    const f = { 'workflow.yaml': 'w', 'scripts/a.py': '1', 'scripts/b.py': '1', 'scripts/c.py': '1', 'scripts/d.py': '1' };
    const r = checkResume({ oldPlan: wide, oldManifest: manifest(f), succeeded: set('a', 'b', 'c'), skipped: set(), failed: set('d'), newPlan: wide, newManifest: manifest({ ...f, 'scripts/c.py': '2' }) });
    expect(r).toMatchObject({ possible: true, carried: ['a', 'b'], rerun: ['c', 'd'] });
    expect(r.deviation).toBeCloseTo(1 / 3);
  });

  it('treats a step the author asked to rerun as no deviation', () => {
    const r = checkResume({ ...base, succeeded: set('a', 'b'), failed: set('c'), newPlan: chain, newManifest: manifest(files), fromNode: 'a' });
    expect(r).toMatchObject({ possible: true, carried: [], deviation: 0 });
  });

  it('marks added and removed steps and reruns what depends on an added step', () => {
    const next = plan(node('a', []), node('x', ['a']), node('c', ['x']));
    const r = checkResume({ ...base, newPlan: next, newManifest: manifest({ ...files, 'scripts/x.py': 'x1' }) });
    expect(r.steps.map((s) => `${s.id}:${s.change}:${s.action}`)).toEqual(['a:same:carry', 'x:added:rerun', 'c:changed:rerun', 'b:removed:drop']);
    expect(r.possible).toBe(true);
  });

  it('refuses inputs that do not fit the new version', () => {
    const r = checkResume({ ...base, newPlan: chain, newManifest: manifest(files), inputsProblem: 'must have required property x' });
    expect(r).toMatchObject({ possible: false });
    expect(r.reason).toMatch(/inputs/);
  });

  it('lists changed files no step names, and ignores the workflow file and notes', () => {
    const r = checkResume({ ...base, newPlan: chain, newManifest: manifest({ ...files, 'lib/util.py': 'u1', 'README.md': 'r', 'workflow.yaml': 'w2' }) });
    expect(r.other_files_changed).toEqual(['lib/util.py']);
    expect(r.warnings.join(' ')).toMatch(/lib\/util\.py/);
  });

  it('is not moved by a tool revision bump alone', () => {
    const tool = (revision: number) => ({ ...node('t', []), type: 'tool', tool: { ref: 'x@1', effect: 'read', revision, outputTrusted: true, safeForTainted: true } }) as unknown as PlanNode;
    const r = checkResume({ oldPlan: plan(tool(1)), oldManifest: manifest({}), succeeded: set('t'), skipped: set(), failed: set(), newPlan: plan(tool(2)), newManifest: manifest({}) });
    expect(r.steps[0]).toMatchObject({ change: 'same', action: 'carry' });
  });
});
