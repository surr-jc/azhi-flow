import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluateCel } from '../src/cel/evaluator.js';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';

/**
 * The AI-SDLC example (examples/ai-sdlc): definition checks, the CEL that routes it (definition of
 * ready, the lite/full weight, the reviewer verdict gate, the join over skipped fix rounds) and the
 * finalize script, none of which need Temporal or OpenCode. The agents are exercised by the
 * sdlc-implement end-to-end test, which runs the same node types.
 */
const PKG = 'examples/ai-sdlc';
const pkg = packageFromDirectory(PKG);
const tools = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools;
const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;
const node = (id: string) => def.nodes.find((n) => n.id === id) as any;
const config = { lite_max_files: 5, lite_min_confidence: 6, min_confidence: 80 };
const hasPython = (() => {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

const design = (over: Record<string, unknown> = {}) => ({ risk: 'low', touches_sensitive: false, has_migration: false, files: [{}, {}], confidence: 8, ...over });
const verdict = (over: Record<string, unknown> = {}) => ({ approved: true, summary: 'ok', findings: [], prompt_injection_detected: false, ...over });
let seq = 0;
const finding = (severity: string, id = `C${++seq}`) => ({ id, severity, message: 'm' });
const check = (id: string, verdict: string, confidence = 90) => ({ id, verdict, confidence, evidence: 'e' });
const gate = (id: string, nodes: Record<string, unknown>) => evaluateCel(node(id).expression, { config, nodes: Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, { output: v }])) });

describe('AI-SDLC example: definition', () => {
  it('compiles, with every agent tainted and every write gated', () => {
    const r = compile(def, { pkg, catalog: staticCatalog(tools) });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    for (const id of ['dor_check', 'requirements', 'design', 'build', 'lite_review_1', 'code_1', 'security_3', 'fix_2']) expect(r.plan!.taint.tainted[id]).toBeTruthy();
    for (const write of ['push_branch', 'open_pr', 'release', 'send_back', 'dor_send_back']) {
      const paths = r.plan!.taint.paths.filter((p) => p.write === write);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((p) => p.gate !== null)).toBe(true);
    }
  });

  it('routes through the definition-of-ready gate, the weight, and the fix gates', () => {
    expect(node('dor_gate').routes).toEqual({ ready: ['requirements'], refine: ['dor_message'] });
    expect(node('weight').routes).toEqual({ lite: ['lite_review_1'], full: ['code_1', 'test_1', 'security_1'] });
    expect(node('gate_1').routes.fix).toEqual(['fix_1']);
    expect(node('gate_2').routes.fix).toEqual(['fix_2']);
    expect(node('lite_gate_1').routes.fix).toEqual(['lite_fix']);
    expect(node('finalize').merge).toBe('any');
    expect(node('ship_gate').routes).toEqual({ ship: ['release_approval'], fix: ['send_back'] });
    // The full path caps at two fix rounds: nothing follows the third review round's gate.
    expect(def.nodes.find((n) => n.id === 'gate_3')).toBeUndefined();
  });

  it('the join runs only when a build ran: it depends on nothing that runs before the definition-of-ready gate', () => {
    // finalize merges alternative branches (merge: any), so it runs when any dependency got through.
    // A dependency on intake would make it run, and fail, after a ticket was sent back as not ready.
    const r = compile(def, { pkg, catalog: staticCatalog(tools) });
    const finalize = r.plan!.nodes.find((n) => n.id === 'finalize')!;
    for (const early of ['source', 'jira_issue', 'github_issue', 'intake', 'dor_check', 'dor_gate', 'dor_message', 'dor_send_back']) expect(finalize.deps, early).not.toContain(early);
  });

  it('gives the three full reviewers different models and builds only after the design review', () => {
    const model = (p: string) => parse(readFileSync(`${PKG}/profiles/${p}@1.yaml`, 'utf8')).model.name;
    expect(new Set(['code-reviewer', 'test-reviewer', 'security-reviewer'].map(model)).size).toBe(3);
    expect(node('build').depends_on).toEqual(['design_review']);
    expect(node('build').workspace.mode).toBe('write');
    expect(node('push_branch').depends_on).toEqual(['release_approval']);
  });

  it('refers only to skills, agents, commands and profiles that exist, each skill with its licence and source', () => {
    const profiles = readdirSync(join(PKG, 'profiles')).map((f) => parse(readFileSync(join(PKG, 'profiles', f), 'utf8')));
    for (const p of profiles) {
      const o = p.harness.opencode;
      for (const file of [o.agent, o.command, ...(o.skills ?? []).map((s: string) => `${s}/SKILL.md`)]) expect(existsSync(join(PKG, file)), file).toBe(true);
    }
    for (const dir of readdirSync(join(PKG, 'harness/skills'))) {
      for (const f of ['SKILL.md', 'LICENSE', 'SOURCE.md']) expect(existsSync(join(PKG, 'harness/skills', dir, f)), `${dir}/${f}`).toBe(true);
      expect(readFileSync(join(PKG, 'harness/skills', dir, 'SKILL.md'), 'utf8')).toMatch(new RegExp(`^---\\nname: ${dir}\\ndescription: .+\\n---`));
    }
    const used = new Set(profiles.flatMap((p) => p.harness.opencode.skills.map((s: string) => s.split('/').pop())));
    for (const dir of readdirSync(join(PKG, 'harness/skills'))) expect(used.has(dir), `${dir} is unused`).toBe(true);
  });
});

describe('AI-SDLC example: routing expressions', () => {
  const dor = (gates: any[], dispatchable = true) => gate('dor_gate', { dor_check: { gates, dispatchable } });
  const pass = { status: 'pass', confidence: 'high' };

  it('definition of ready: ready only when every gate passes with confidence and the work is dispatchable', () => {
    expect(dor([pass, pass, pass])).toBe('ready');
    expect(dor([pass, { status: 'fail', confidence: 'high' }])).toBe('refine');
    expect(dor([pass, { status: 'pass', confidence: 'low' }])).toBe('refine');
    expect(dor([pass], false)).toBe('refine');
  });

  it('weight: lite unless the risk, a sensitive area, a migration, the width or the confidence says full', () => {
    const w = (over: Record<string, unknown>) => evaluateCel(node('weight_proposal').expression, { config, nodes: { design: { output: design(over) } } });
    expect(w({})).toBe('lite');
    expect(w({ risk: 'medium' })).toBe('lite');
    expect(w({ risk: 'high' })).toBe('full');
    expect(w({ touches_sensitive: true })).toBe('full');
    expect(w({ has_migration: true })).toBe('full');
    expect(w({ files: [1, 2, 3, 4, 5, 6] })).toBe('full');
    expect(w({ files: [1, 2, 3, 4, 5] })).toBe('lite');
    expect(w({ confidence: 5 })).toBe('full');
  });

  it('weight: the approver can force either path, and auto keeps the proposal', () => {
    const w = (data: Record<string, unknown>, proposed: string) =>
      evaluateCel(node('weight').expression, { nodes: { design_review: { output: { data } }, weight_proposal: { output: { route: proposed } } } });
    expect(w({ answers: 'x' }, 'full')).toBe('full');
    expect(w({ answers: 'x', weight: 'auto' }, 'lite')).toBe('lite');
    expect(w({ answers: 'x', weight: 'lite' }, 'full')).toBe('lite');
    expect(w({ answers: 'x', weight: 'full' }, 'lite')).toBe('full');
  });

  it('review gate: a fix round only for findings the verifier confirmed, and for no-injection approval', () => {
    const g = (a: any, b: any, c: any, checks: any[] = []) => gate('gate_1', { code_1: a, test_1: b, security_1: c, verify_1: { checks } });
    expect(g(verdict(), verdict(), verdict())).toBe('ok');
    expect(g(verdict({ findings: [finding('minor'), finding('suggestion')] }), verdict(), verdict())).toBe('ok');
    // A reviewer who asks for changes without a critical or major finding still sends it back.
    expect(g(verdict(), verdict({ approved: false }), verdict())).toBe('fix');
    expect(g(verdict(), verdict(), verdict({ prompt_injection_detected: true }))).toBe('fix');
    // Critical and major findings count only when confirmed with enough confidence.
    const major = (id: string) => verdict({ approved: false, findings: [finding('major', id)] });
    expect(g(verdict(), verdict(), major('S1'), [check('S1', 'confirmed', 92)])).toBe('fix');
    expect(g(major('C1'), verdict(), verdict(), [check('C1', 'confirmed', 80)])).toBe('fix');
    expect(g(major('C1'), verdict(), verdict(), [check('C1', 'confirmed', 79)])).toBe('ok');
    expect(g(major('C1'), verdict(), verdict(), [check('C1', 'refuted', 95)])).toBe('ok');
    expect(g(major('C1'), verdict(), verdict(), [check('C1', 'unverifiable', 40)])).toBe('ok');
    expect(g(major('C1'), verdict(), verdict(), [])).toBe('ok');
    expect(g(verdict({ approved: false, findings: [finding('critical', 'C1')] }), verdict(), verdict(), [check('C1', 'confirmed', 90)])).toBe('fix');
    const lite = (checks: any[]) => gate('lite_gate_1', { lite_review_1: verdict({ approved: false, findings: [finding('major', 'L1')] }), lite_verify_1: { checks } });
    expect(lite([check('L1', 'confirmed')])).toBe('fix');
    expect(lite([check('L1', 'refuted')])).toBe('ok');
    expect(gate('lite_gate_1', { lite_review_1: verdict(), lite_verify_1: { checks: [] } })).toBe('ok');
  });

  it('the fix round gets only the findings that survived verification', () => {
    const inp = (verdicts: any[], checks: any[]) =>
      evaluateCel(node('fix_1').input.map, { config, inputs: {}, nodes: Object.fromEntries(Object.entries({ intake: {}, requirements: {}, design: {}, design_review: { data: {} }, build: { summary: 's', workspace: { diff: 'd' } }, code_1: verdicts[0], test_1: verdicts[1], security_1: verdicts[2], verify_1: { checks } }).map(([k, v]) => [k, { output: v }])) }) as any;
    const bad = verdict({ approved: false, findings: [finding('major', 'C1'), finding('major', 'C2'), finding('minor', 'C3')] });
    const o = inp([bad, verdict(), verdict()], [check('C1', 'confirmed', 90), check('C2', 'refuted', 90)]);
    expect(o.feedback.verdicts[0].findings.map((f: any) => f.id)).toEqual(['C1', 'C3']);
  });
});

describe.skipIf(!hasPython)('AI-SDLC example: the join and the evidence record', () => {
  const change = (n: number, tests = 'passed') => ({
    summary: `change ${n}`,
    commit_message: 'fix(cart): apply the discount',
    pr_title: 'fix(cart): apply the discount',
    pr_body: '## Summary\nx',
    tasks_done: [],
    tests_added: ['t'],
    deviations: [],
    risks: [],
    workspace: { repo: 'acme/shop', base_sha: 'abc123', diff: `diff ${n}`, stats: { files: 1, additions: 2, deletions: 1 }, tests: { status: tests, command: 'npm test', exit_code: tests === 'passed' ? 0 : 1, attempts: 1 }, files: [{ path: 'src/cart.js', status: 'modified', mode: '100644', content: `v${n}` }] },
  });
  const scope = (nodes: Record<string, unknown>, finalWeight = 'full') => ({
    inputs: { repo: 'acme/shop', ticket: 'acme/shop#12' },
    config,
    nodes: Object.fromEntries(Object.entries({ intake: { key: 'acme/shop#12' }, design_review: { by: 'ana', data: {} }, weight_proposal: { route: 'full' }, weight: { route: finalWeight }, ...nodes }).map(([k, v]) => [k, { output: v }])),
  });
  const run = (nodes: Record<string, unknown>, finalWeight = 'full') => {
    const input = evaluateCel(node('finalize').input.map, scope(nodes, finalWeight));
    return JSON.parse(execFileSync('python3', [join(PKG, 'scripts/finalize.py')], { input: JSON.stringify(input) }).toString());
  };

  it('verifier: refuted findings are dropped, confirmed ones flag the change, unverifiable ones flag it too', () => {
    const base = { build: change(1), test_1: verdict(), security_1: verdict() };
    const bad = (id: string) => verdict({ approved: false, findings: [finding('critical', id)] });
    const refuted = run({ ...base, code_1: bad('C1'), verify_1: { checks: [check('C1', 'refuted')] } });
    expect(refuted).toMatchObject({ ship: true, needs_human_attention: false, verdict: { approved: true, dropped: [expect.objectContaining({ id: 'C1', verdict: 'refuted' })] } });
    expect(refuted.verdict.counts.critical).toBe(0);
    expect(refuted.evidence_markdown).toContain('1 critical or major finding(s) refuted');
    const confirmed = run({ ...base, code_1: bad('C1'), verify_1: { checks: [check('C1', 'confirmed', 91)] } });
    expect(confirmed).toMatchObject({ needs_human_attention: true, verdict: { approved: false, counts: { critical: 1 } } });
    expect(confirmed.verdict.findings[0]).toMatchObject({ id: 'C1', confidence: 91 });
    const weak = run({ ...base, code_1: bad('C1'), verify_1: { checks: [check('C1', 'confirmed', 70)] } });
    expect(weak).toMatchObject({ needs_human_attention: false, verdict: { dropped: [expect.objectContaining({ id: 'C1' })] } });
    const unsure = run({ ...base, code_1: bad('C1'), verify_1: { checks: [check('C1', 'unverifiable', 30)] } });
    expect(unsure).toMatchObject({ needs_human_attention: true, verdict: { approved: false, unverified: [expect.objectContaining({ id: 'C1' })] } });
    expect(run({ ...base, code_1: bad('C1'), verify_1: { checks: [] } }).needs_human_attention).toBe(true);
  });

  it('full path approved in round 1: the first build ships, with no fix rounds used', () => {
    const o = run({ build: change(1), code_1: verdict(), test_1: verdict(), security_1: verdict() });
    expect(o).toMatchObject({ ship: true, needs_human_attention: false, round: 0, change: { summary: 'change 1', base_sha: 'abc123' } });
    expect(o.verdict.reviewers.map((r: any) => r.reviewer)).toEqual(['code', 'test', 'security']);
    expect(o.evidence.weight).toMatchObject({ proposed: 'full', final: 'full', overridden_by: null });
    expect(o.evidence_markdown).toContain('Record SHA-256');
    expect(o.evidence.files).toEqual([expect.objectContaining({ path: 'src/cart.js', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
  });

  it('full path: the last round that ran wins over the skipped ones', () => {
    const o = run({ build: change(1), code_1: verdict(), test_1: verdict({ approved: false, findings: [finding('major', 'T1')] }), security_1: verdict(), verify_1: { checks: [check('T1', 'confirmed')] }, fix_1: change(2), code_2: verdict(), test_2: verdict(), security_2: verdict() });
    expect(o).toMatchObject({ ship: true, needs_human_attention: false, round: 1, change: { summary: 'change 2' } });
    expect(o.change.files[0].content).toBe('v2');
  });

  it('full path: findings left after the second fix round flag the pull request instead of dropping it', () => {
    const bad = verdict({ approved: false, findings: [finding('critical', 'C1')] });
    const ok = { verify_1: { checks: [check('C1', 'confirmed')] }, verify_2: { checks: [check('C1', 'confirmed')] }, verify_3: { checks: [check('C1', 'confirmed')] } };
    const o = run({ build: change(1), code_1: bad, test_1: verdict(), security_1: verdict(), fix_1: change(2), code_2: bad, test_2: verdict(), security_2: verdict(), fix_2: change(3), code_3: bad, test_3: verdict(), security_3: verdict(), ...ok });
    expect(o).toMatchObject({ ship: true, needs_human_attention: true, round: 2 });
    expect(o.change.pr_title).toContain('[needs-human-attention]');
    expect(o.evidence_markdown).toContain('Needs human attention');
    expect(o.verdict.counts.critical).toBe(1);
  });

  it('lite path: one reviewer, and a failed test run never ships', () => {
    const ok = run({ build: change(1), lite_review_1: verdict() }, 'lite');
    expect(ok).toMatchObject({ ship: true, round: 0 });
    expect(ok.verdict.reviewers.map((r: any) => r.reviewer)).toEqual(['lite']);
    const failed = run({ build: change(1, 'failed'), lite_review_1: verdict(), lite_fix: change(2, 'failed'), lite_review_2: verdict() }, 'lite');
    expect(failed).toMatchObject({ ship: false, round: 1 });
  });

  it('records an override of the proposed weight, and its approver', () => {
    const o = run({ build: change(1), lite_review_1: verdict() }, 'lite');
    expect(o.evidence.weight).toEqual({ proposed: 'full', final: 'lite', overridden_by: 'ana' });
  });

  it('a prompt injection report blocks approval even when the reviewer approves', () => {
    const o = run({ build: change(1), lite_review_1: verdict({ prompt_injection_detected: true }) }, 'lite');
    expect(o.verdict).toMatchObject({ approved: false, prompt_injection_detected: true });
    expect(o.needs_human_attention).toBe(true);
  });
});
