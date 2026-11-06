import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';
import { PYTHON } from './helpers/python.js';

/**
 * SDLC lean (examples/sdlc-lean): sdlc-universal without the ready check, the test-strategy ladder, the untested and
 * static build variants and the criteria audits. A real run of it is in docs/runbooks/ai-sdlc-factory-live-smoke.md.
 */
const PKG = 'examples/sdlc-lean';
const pkg = packageFromDirectory(PKG);
const config = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8'));
const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;
const nodes = Object.fromEntries((def.nodes as any[]).map((n) => [n.id, n]));
const script = (name: string, input: unknown) =>
  JSON.parse(
    execFileSync(PYTHON[0]!, [...PYTHON.slice(1), join(PKG, 'scripts', name)], {
      input: JSON.stringify(input),
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }).toString(),
  );

describe('SDLC lean: definition', () => {
  it('compiles, and every write is behind a gate', () => {
    const r = compile(def, { pkg, catalog: staticCatalog(config.tools as never) });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    const writes = new Set(r.plan!.taint.paths.map((p) => p.write));
    for (const write of ['push_branch', 'open_pr']) expect(writes.has(write), write).toBe(true);
    expect(r.plan!.taint.paths.filter((p) => p.gate === null)).toEqual([]);
  });

  it('has none of the steps that were taken out, and no profile or file for them', () => {
    for (const id of ['dor_check', 'test_strategist', 'preflight_b', 'gate_scope', 'preflight_decision', 'mode', 'build_untested', 'build_static', 'lite_fix_untested', 'lite_fix_static', 'lite_audit_1', 'lite_audit_2'])
      expect(nodes[id], id).toBeUndefined();
    const agents = (def.nodes as any[]).filter((n) => n.type === 'agent').map((n) => n.id);
    expect(agents.sort()).toEqual(['build', 'lite_fix', 'lite_review_1', 'lite_review_2', 'lite_verify_1', 'lite_verify_2', 'plan', 'preflight']);
    const text = pkg.readText(pkg.manifest.workflow)!;
    for (const word of ['test_strategist', 'gate_scope', 'lite_audit', 'dor_check', 'nodes.mode.']) expect(text).not.toContain(word);
  });

  it('stops, and says so, when the base branch fails its own tests: nothing is planned or built', () => {
    expect(nodes.preflight_gate.routes).toEqual({ ok: ['preflight_ok'], blocked: ['preflight_notify'] });
    expect(nodes.plan.depends_on).toEqual(['preflight_ok']);
    expect(nodes.preflight.depends_on).toEqual(['intake']);
  });

  it('asks a person twice, and writes only after the release approval', () => {
    expect(nodes.design_review.type).toBe('approval');
    expect(nodes.release_approval.decision_schema.required).toEqual(['acknowledged']);
    expect(nodes.push_branch.depends_on).toEqual(['release_approval']);
    for (const id of ['push_branch', 'open_pr']) expect(nodes[id].guard, id).toContain('nodes.finalize.output.ship');
  });

  it('runs the verifier only when the review reported a critical or major finding, and the gate reads its checks either way', () => {
    expect(nodes.lite_severe_1.routes).toEqual({ verify: ['lite_verify_1'], none: [] });
    expect(nodes.lite_severe_2.routes).toEqual({ verify: ['lite_verify_2'], none: [] });
    expect(nodes.lite_checks).toMatchObject({ merge: 'any', depends_on: ['lite_review_1', 'lite_verify_1'] });
    for (const id of ['lite_gate_1', 'lite_fix']) {
      expect(JSON.stringify(nodes[id]), id).toContain('nodes.lite_checks.output.checks');
      expect(JSON.stringify(nodes[id]), id).not.toContain('nodes.lite_verify_1');
    }
  });

  it('writes the retro once the pull request exists, so a failed Slack post does not lose it', () => {
    expect(nodes.retro.depends_on).toEqual(['open_pr']);
  });

  it('shows the branch that is pushed: the approval, the push and the guard use the same git-safe name', () => {
    for (const id of ['release_approval', 'push_branch']) expect(JSON.stringify(nodes[id]), id).toContain("'azhi/' + nodes.intake.output.branch_key");
    expect(JSON.stringify(nodes)).not.toContain("'azhi/' + nodes.intake.output.key");
  });
});

describe('SDLC lean: scripts', () => {
  const ticket = (key: string) => ({ ticket: { source: 'github', key, title: 't', description: 'd', labels: [] }, page: null });

  it('turns a ticket key into a branch name the push tool would not change', () => {
    expect(script('merge_context.py', ticket('surr-jc/azhi-smoke#1')).branch_key).toBe('surr-jc/azhi-smoke-1');
    expect(script('merge_context.py', ticket('PAY-142')).branch_key).toBe('pay-142');
    expect(script('merge_context.py', ticket('???')).branch_key).toBe('ticket');
  });

  it('passes the verifier checks on, or none when the verifier was skipped', () => {
    expect(script('pick_checks.py', { verify: { checks: [{ id: 'F1', verdict: 'confirmed' }] } })).toEqual({ checks: [{ id: 'F1', verdict: 'confirmed' }] });
    expect(script('pick_checks.py', { verify: null })).toEqual({ checks: [] });
  });
});
