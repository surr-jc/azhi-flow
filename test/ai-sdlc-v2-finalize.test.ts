import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** The AI-SDLC v2 workflow's finalize step, run the way the worker runs a script: JSON in on stdin, JSON out. */
const SCRIPT = 'examples/ai-sdlc-v2/scripts/finalize.py';
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');

interface Options {
  verification?: 'full' | 'static' | 'none';
  criteria?: Array<{ criterion: string; status: string; evidence: string }>;
  approved?: boolean;
  prBody?: string;
  testOutput?: string;
  diff?: string;
}

function finalize(o: Options = {}) {
  const ws = {
    base_sha: 'abc',
    diff: o.diff ?? '+x\n',
    files: [{ path: 'a.ts', status: 'added', mode: '100644', content: 'x', additions: 1, deletions: 0 }],
    stats: { files: 1, additions: 1, deletions: 0 },
    tests: { status: 'passed', command: 'check', exit_code: 0, attempts: 1, output: o.testOutput ?? '' },
  };
  const change = { summary: 's', commit_message: 'm', pr_title: 't', pr_body: o.prBody ?? 'Does a thing.\n\nCloses acme/app#28\n', deviations: [], tests_added: [], workspace: ws };
  const verdict = { summary: 'ok', approved: o.approved ?? true, findings: [], prompt_injection_detected: false, ...(o.criteria ? { criteria: o.criteria } : {}) };
  const input = {
    verification: o.verification ?? 'full',
    min_confidence: 80,
    ticket: { title: 'T' },
    repo: 'acme/app',
    weight: { proposed: 'lite', final: 'lite', overridden_by: null },
    design_review: { by: 'u' },
    lite: [{ change, verdicts: { lite: verdict }, checks: [] }],
    full: [],
  };
  // Windows' default Python reads piped text in a legacy code page, so the test leaves its UTF-8 settings unset.
  const env = { ...process.env, PYTHONUTF8: '', PYTHONIOENCODING: '' };
  const out = execFileSync(python!, [SCRIPT], { input: Buffer.from(JSON.stringify(input), 'utf8'), env, maxBuffer: 1 << 24 });
  return JSON.parse(out.toString('utf8'));
}

const met = { criterion: 'A', status: 'met', evidence: 'a.ts:1' };

interface Round {
  built?: boolean;
  stepLimit?: boolean;
  findings?: Array<Record<string, unknown>>;
  checks?: Array<Record<string, unknown>>;
  criteria?: Array<{ criterion: string; status: string; evidence: string; evidence_kind?: string }>;
  reviewed?: boolean;
  testsAdded?: string[];
  deviations?: string[];
  paths?: string[];
  audit?: Array<Record<string, unknown>>;
}

interface Extra {
  verification?: 'full' | 'static' | 'none';
  plan?: { files: Array<{ path: string; action: string }>; ac_verification: Array<{ criterion: number; how: string; where: string }> };
}

/** Runs finalize over several rounds; `requirements` is what the workflow passes from the plan. */
function finalizeRounds(rounds: Round[], requirements?: { acceptance_criteria: string[] }, extra: Extra = {}) {
  const lite = rounds.map((r) => {
    if (r.built === false) return { change: null, verdicts: { lite: null }, checks: [] };
    const ws = {
      base_sha: 'abc',
      diff: '+x\n',
      files: (r.paths ?? ['a.ts']).map((path) => ({ path, status: 'added', mode: '100644', content: 'x', additions: 1, deletions: 0 })),
      stats: { files: (r.paths ?? ['a.ts']).length, additions: 1, deletions: 0 },
      tests: { status: extra.verification === 'none' ? 'not_run' : 'passed', command: 'check', exit_code: 0, attempts: 1, output: '' },
      ...(r.stepLimit ? { step_limit_reached: true } : {}),
    };
    const change = { summary: 's', commit_message: 'm', pr_title: 't', pr_body: 'Body\n', deviations: r.deviations ?? [], tests_added: r.testsAdded ?? [], workspace: ws };
    const findings = r.findings ?? [];
    const verdict = r.reviewed === false ? null : { summary: 'ok', approved: findings.length === 0, findings, prompt_injection_detected: false, ...(r.criteria ? { criteria: r.criteria } : {}) };
    return { change, verdicts: { lite: verdict }, checks: r.checks ?? [], ...(r.audit ? { audit: r.audit } : {}) };
  });
  const input = {
    verification: extra.verification ?? 'full',
    min_confidence: 80,
    ticket: { title: 'T' },
    repo: 'acme/app',
    weight: { proposed: 'lite', final: 'lite', overridden_by: null },
    design_review: { by: 'u' },
    ...(requirements ? { requirements } : {}),
    ...(extra.plan ? { plan: extra.plan } : {}),
    lite,
    full: [],
  };
  const out = execFileSync(python!, [SCRIPT], { input: Buffer.from(JSON.stringify(input), 'utf8'), env: { ...process.env, PYTHONUTF8: '', PYTHONIOENCODING: '' }, maxBuffer: 1 << 24 });
  return JSON.parse(out.toString('utf8'));
}

const critical = { id: 'L1', severity: 'critical', path: 'src/a.ts', line: 7, message: 'nextPhase is never set | breaks the flow' };
const confirm = (id: string, confidence = 99) => ({ id, verdict: 'confirmed', confidence, evidence: 'reproduced' });

describe.skipIf(!python)('the AI-SDLC v2 finalize step', () => {
  it('survives non-ASCII text in the diff and the files (smart quotes, dashes, emoji)', () => {
    const text = '+ say “hello” — done \u{1F49D}\n';
    const r = finalize({ diff: text });
    expect(r.ship).toBe(true);
    expect(r.change.diff).toBe(text);
  });

  it('keeps "Closes" only when the change is verified, approved and every criterion is met', () => {
    const clean = finalize({ criteria: [met, { ...met, criterion: 'B' }] });
    expect(clean.needs_human_attention).toBe(false);
    expect(clean.closes_removed).toBe(false);
    expect(clean.change.pr_body).toContain('Closes acme/app#28');
    expect(clean.criteria_counts).toMatchObject({ met: 2, partial: 0, unmet: 0 });
  });

  it('turns "Closes #N" into "Refs #N" for a draft, so merging it cannot close the ticket', () => {
    const r = finalize({ verification: 'static', criteria: [met] });
    expect(r.needs_human_attention).toBe(true);
    expect(r.closes_removed).toBe(true);
    expect(r.change.pr_body).toContain('Refs acme/app#28');
    expect(r.change.pr_body).not.toMatch(/closes/i);
    expect(r.evidence_markdown).toContain('Closing keyword replaced');
  });

  it('flags a partial or unmet criterion even when the reviewer approved', () => {
    const r = finalize({ criteria: [met, { criterion: 'B', status: 'partial', evidence: 'server default bypasses the filter' }, { criterion: 'C', status: 'unmet', evidence: 'no test' }] });
    expect(r.needs_human_attention).toBe(true);
    expect(r.criteria_counts).toMatchObject({ met: 1, partial: 1, unmet: 1 });
    expect(r.change.pr_body).toContain('Refs acme/app#28');
    expect(r.evidence_markdown).toContain('Acceptance criteria: 1 of 3 met, 1 partial, 1 unmet');
  });

  it('handles other closing keywords and leaves unrelated text alone', () => {
    const r = finalize({ verification: 'none', prBody: 'Fixes #28\nresolved: other/repo#9\nA line that closes the loop.\n' });
    expect(r.change.pr_body).toBe('Refs #28\nRefs other/repo#9\nA line that closes the loop.\n');
  });

  it('records whether the new or changed test files were run', () => {
    const ran = finalize({ verification: 'static', testOutput: 'ok\nAZHI_TARGETED_TESTS passed 3 file(s)\n' });
    expect(ran.targeted_tests).toEqual({ result: 'passed', files: 3 });
    expect(ran.evidence_markdown).toContain('New or changed test files run: passed (3 file(s))');
    expect(ran.evidence_markdown).toContain('also run and passed');
    const none = finalize({ verification: 'static' });
    expect(none.targeted_tests).toBeNull();
    expect(none.evidence_markdown).toContain('No test was run.');
  });

  describe('blockers', () => {
    const reqs = { acceptance_criteria: ['A', 'B'] };
    const both = [met, { ...met, criterion: 'B' }];

    it('ships a clean change and reports no blockers', () => {
      const r = finalizeRounds([{ criteria: both }], reqs);
      expect(r.ship).toBe(true);
      expect(r.blocked).toBe(false);
      expect(r.blockers).toEqual([]);
    });

    it('blocks on a confirmed critical finding', () => {
      const r = finalizeRounds([{ findings: [critical], checks: [confirm('L1')], criteria: both }], reqs);
      expect(r.ship).toBe(false);
      expect(r.blocked).toBe(true);
      expect(r.blockers_text).toContain('1 confirmed critical finding(s): L1');
    });

    it('does not block on a critical finding the verifier refuted or could not settle', () => {
      const refuted = finalizeRounds([{ findings: [critical], checks: [{ id: 'L1', verdict: 'refuted', confidence: 95, evidence: 'no' }], criteria: both }], reqs);
      expect(refuted.ship).toBe(true);
      const unsettled = finalizeRounds([{ findings: [critical], checks: [{ id: 'L1', verdict: 'unverifiable', confidence: 0, evidence: '' }], criteria: both }], reqs);
      expect(unsettled.ship).toBe(true);
      expect(unsettled.needs_human_attention).toBe(true);
    });

    it('flags but does not block a confirmed major finding', () => {
      const major = { ...critical, id: 'L2', severity: 'major' };
      const r = finalizeRounds([{ findings: [major], checks: [confirm('L2')], criteria: both }], reqs);
      expect(r.ship).toBe(true);
      expect(r.needs_human_attention).toBe(true);
    });

    it('blocks on an unmet criterion but only flags a partial one', () => {
      const unmet = finalizeRounds([{ criteria: [met, { criterion: 'B', status: 'unmet', evidence: 'no test' }] }], reqs);
      expect(unmet.ship).toBe(false);
      expect(unmet.blockers_text).toContain('1 acceptance criterion(s) unmet');
      const partial = finalizeRounds([{ criteria: [met, { criterion: 'B', status: 'partial', evidence: 'half' }] }], reqs);
      expect(partial.ship).toBe(true);
      expect(partial.needs_human_attention).toBe(true);
    });

    it('fails closed when the reviewer judged fewer criteria than the requirements list', () => {
      const none = finalizeRounds([{}], reqs);
      expect(none.ship).toBe(false);
      expect(none.blockers_text).toContain('judged 0 of 2 acceptance criteria');
      const short = finalizeRounds([{ criteria: [met] }], reqs);
      expect(short.ship).toBe(false);
      expect(short.criteria_missing).toBe(1);
      expect(short.evidence_markdown).toContain('1 criterion(s) the reviewer did not judge');
    });

    it('blocks a build that ran out of steps', () => {
      const r = finalizeRounds([{ stepLimit: true, criteria: both }], reqs);
      expect(r.ship).toBe(false);
      expect(r.blockers_text).toContain('ran out of steps');
      expect(r.evidence).toMatchObject({ step_limit_reached: true });
    });
  });

  describe('findings carried and reported', () => {
    it('keeps round one findings when round two was not reviewed', () => {
      const r = finalizeRounds([{ findings: [critical], checks: [confirm('L1')], criteria: [met] }, { reviewed: false }]);
      expect(r.round).toBe(1);
      expect(r.verdict.findings.map((f: { id: string }) => f.id)).toEqual(['L1']);
      expect(r.ship).toBe(false);
      expect(r.evidence).toMatchObject({ reviewed_round: 0 });
    });

    it('uses the later review when the fix was reviewed', () => {
      const r = finalizeRounds([{ findings: [critical], checks: [confirm('L1')], criteria: [met] }, { criteria: [met] }]);
      expect(r.verdict.findings).toEqual([]);
      expect(r.ship).toBe(true);
    });

    it('puts the findings, the unverified and dropped ones and the open criteria in the pull request text', () => {
      const major = { id: 'L2', severity: 'major', path: 'b.ts', message: 'swallows errors' };
      const dropped = { id: 'L3', severity: 'major', path: 'c.ts', message: 'maybe' };
      const r = finalizeRounds(
        [{ findings: [critical, major, dropped], checks: [confirm('L1', 92), { id: 'L3', verdict: 'refuted', confidence: 90, evidence: 'guarded' }], criteria: [met, { criterion: 'B', status: 'partial', evidence: 'no mobile check' }] }],
        { acceptance_criteria: ['A', 'B'] },
      );
      const md: string = r.evidence_markdown;
      expect(md).toContain('### Review findings');
      expect(md).toContain('| L1 | critical | src/a.ts:7 | nextPhase is never set \\| breaks the flow | 92 |');
      expect(md).toContain('### Findings the verifier could not settle');
      expect(md).toContain('L2 (major, b.ts): swallows errors - no check was returned');
      expect(md).toContain('### Findings dropped by the verifier');
      expect(md).toContain('L3 (major): refuted at 90/100');
      expect(md).toContain('| B | partial | test_passed | no mobile check |');
      expect(md.indexOf('### Review findings')).toBeLessThan(md.indexOf('<details>'));
    });
  });

  describe('evidence that ran, and the plan against the diff', () => {
    const reqs = { acceptance_criteria: ['A', 'B'] };
    const plan = (how: string[] = ['automated_test', 'automated_test'], files = ['src/a.ts', 'test/a.test.ts']) => ({
      files: files.map((path) => ({ path, action: 'create' })),
      ac_verification: how.map((h, i) => ({ criterion: i + 1, how: h, where: 'x' })),
    });
    const both = (kind?: string) => [met, { ...met, criterion: 'B' }].map((c) => ({ ...c, ...(kind ? { evidence_kind: kind } : {}) }));

    it('caps a "met" that rests on reading the code in an untested run at partial', () => {
      const r = finalizeRounds([{ criteria: both('code_read'), paths: ['src/a.ts', 'test/a.test.ts'], testsAdded: ['t::a - covers AC1', 't::b - covers AC2'] }], reqs, { verification: 'none', plan: plan() });
      expect(r.criteria_counts).toMatchObject({ met: 0, partial: 2 });
      expect(r.criteria_capped).toEqual([1, 2]);
      expect(r.needs_human_attention).toBe(true);
      expect(r.criteria[0].evidence).toContain('capped to partial');
      expect(r.evidence_markdown).toContain('| A | partial | code_read |');
    });

    it('does not let a reviewer claim test_passed when no test ran', () => {
      const r = finalizeRounds([{ criteria: both('test_passed'), paths: ['src/a.ts', 'test/a.test.ts'], testsAdded: ['t::a - covers AC1, AC2'] }], reqs, { verification: 'none', plan: plan() });
      expect(r.criteria_counts.met).toBe(0);
      expect(r.criteria[0].evidence_kind).toBe('test_written_not_run');
    });

    it('keeps "met" when the tests ran and passed, and when no kind is given in a full run', () => {
      const withKind = finalizeRounds([{ criteria: both('test_passed'), paths: ['src/a.ts', 'test/a.test.ts'], testsAdded: ['t::a - covers AC1, AC2'] }], reqs, { plan: plan() });
      expect(withKind.criteria_counts.met).toBe(2);
      expect(withKind.ship).toBe(true);
      expect(withKind.needs_human_attention).toBe(false);
      const noKind = finalizeRounds([{ criteria: both() }], reqs);
      expect(noKind.criteria_counts.met).toBe(2);
    });

    it('caps a full-run "met" that rests on reading the code, unless the plan verifies it by a compile check', () => {
      const read = finalizeRounds([{ criteria: both('code_read'), paths: ['src/a.ts', 'test/a.test.ts'], testsAdded: ['t - covers AC1, AC2'] }], reqs, { plan: plan() });
      expect(read.criteria_counts).toMatchObject({ met: 0, partial: 2 });
      const compiled = finalizeRounds([{ criteria: both('code_read'), paths: ['src/a.ts', 'test/a.test.ts'], testsAdded: ['t - covers AC2'] }], reqs, { plan: plan(['static_check', 'automated_test']) });
      expect(compiled.criteria_counts).toMatchObject({ met: 1, partial: 1 });
    });

    it('blocks a planned file that was not changed and not explained, and only flags an explained one', () => {
      const missing = finalizeRounds([{ criteria: both('test_passed'), paths: ['src/a.ts'], testsAdded: ['t - covers AC1, AC2'] }], reqs, { plan: plan() });
      expect(missing.ship).toBe(false);
      expect(missing.blockers_text).toContain('1 planned file(s) not changed and not explained in the deviations: test/a.test.ts');
      expect(missing.evidence_markdown).toContain('### Planned files that were not changed');
      const explained = finalizeRounds([{ criteria: both('test_passed'), paths: ['src/a.ts'], testsAdded: ['t - covers AC1, AC2'], deviations: ['NOT DONE: test/a.test.ts - covered by an existing suite'] }], reqs, { plan: plan() });
      expect(explained.ship).toBe(true);
      expect(explained.needs_human_attention).toBe(true);
      expect(explained.plan_files_missing).toEqual(['test/a.test.ts']);
    });

    it('blocks a criterion that needs an automated test and has none, unless it is waived or not automatable', () => {
      const none = finalizeRounds([{ criteria: both('test_passed'), paths: ['src/a.ts', 'test/a.test.ts'], testsAdded: ['t - covers AC1'] }], reqs, { plan: plan() });
      expect(none.ship).toBe(false);
      expect(none.blockers_text).toContain('no test covers AC2');
      const waived = finalizeRounds([{ criteria: both('test_passed'), paths: ['src/a.ts', 'test/a.test.ts'], testsAdded: ['t - covers AC1'], deviations: ['AC2: no automated test, a rendering check'] }], reqs, { plan: plan() });
      expect(waived.ship).toBe(true);
      const manual = finalizeRounds([{ criteria: both('test_passed'), paths: ['src/a.ts', 'test/a.test.ts'], testsAdded: ['t - covers AC1'] }], reqs, { plan: plan(['automated_test', 'manual']) });
      expect(manual.ship).toBe(true);
    });

    it('does nothing about the plan when the workflow does not pass one', () => {
      const r = finalizeRounds([{ criteria: both('test_passed') }], reqs);
      expect(r.ship).toBe(true);
      expect(r.plan_files_missing).toEqual([]);
    });
  });

  // Reconstructed from the description of the two DCURE-2182 runs (the real attempt outputs are not on this server).
  describe('the two DCURE-2182 runs, as reconstructed', () => {
    const six = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const reqs = { acceptance_criteria: six };
    const plan6 = {
      files: ['src/s.java', 'src/n.java', 'src/m.java', 'src/t.java', 'src/u.java', 'src/v.java'].map((path) => ({ path, action: 'update' })),
      ac_verification: six.map((_, i) => ({ criterion: i + 1, how: 'automated_test', where: 'x' })),
    };

    it('run 1 (ran out of steps, 2 of 6 planned files, confirmed criticals, an unmet criterion) is sent back', () => {
      const status = ['met', 'met', 'met', 'met', 'met', 'partial', 'partial', 'partial', 'unmet', 'unverifiable'];
      const criteria = six.map((c, i) => ({ criterion: c, status: status[i]!, evidence: 'x', evidence_kind: 'code_read' }));
      const findings = [{ ...critical, id: 'L1' }, { ...critical, id: 'L2', message: 'no tests' }, { ...critical, id: 'L3', message: 'compile error' }];
      const r = finalizeRounds(
        [{ stepLimit: true, paths: ['src/s.java', 'src/n.java'], findings, checks: findings.map((f) => confirm(f.id)), criteria }],
        reqs,
        { verification: 'none', plan: plan6 },
      );
      expect(r.ship).toBe(false);
      expect(r.blocked).toBe(true);
      for (const part of ['3 confirmed critical', '1 acceptance criterion(s) unmet', 'ran out of steps', '4 planned file(s) not changed', 'no test covers AC1']) expect(r.blockers_text).toContain(part);
    });

    it('run 2 (no findings, every criterion "met" from reading the code, nothing run) can no longer show a bare "met"', () => {
      const criteria = six.map((c) => ({ criterion: c, status: 'met', evidence: 'enum is set in the three senders', evidence_kind: 'test_written_not_run' }));
      const r = finalizeRounds(
        [{ paths: plan6.files.map((f) => f.path), criteria, testsAdded: six.map((_, i) => `T::t${i} - covers AC${i + 1}`), findings: [{ id: 'L1', severity: 'minor', message: 'wording' }] }],
        reqs,
        { verification: 'none', plan: plan6 },
      );
      expect(r.criteria_counts).toMatchObject({ met: 0, partial: 10 });
      expect(r.needs_human_attention).toBe(true);
      expect(r.evidence_markdown).toContain('not proven by a test that ran');
      // Nothing here blocks: catching a criterion that reading cannot refute (STARTED can never be produced) is the audit step's job.
      expect(r.blocked).toBe(false);
    });
  });

  describe('the criteria audit', () => {
    const reqs = { acceptance_criteria: ['A', 'B'] };
    const crit = ['A', 'B'].map((criterion) => ({ criterion, status: 'met', evidence: 'x', evidence_kind: 'test_passed' }));
    const holds = (criterion: number, confidence = 95) => ({ criterion, verdict: 'holds', confidence, outcomes: [{ outcome: 'o', input: 'i', trace: 'a.ts:1' }], evidence: 'traced' });
    const counter = (criterion: number, confidence = 95) => ({ criterion, verdict: 'counterexample', confidence, outcomes: [{ outcome: 'Started', input: '', trace: 'a.ts:9' }], counterexample: 'Started can never be produced: the rule is success == 0 ? BLOCKED : NOT_STARTED', evidence: 'x' });

    it('keeps a criterion met when the audit traced an input to every outcome', () => {
      const r = finalizeRounds([{ criteria: crit, audit: [holds(1), holds(2)] }], reqs);
      expect(r.criteria_counts.met).toBe(2);
      expect(r.ship).toBe(true);
      expect(r.criteria_audit).toEqual({ enabled: true, refuted: [], unconfirmed: [] });
    });

    it('turns a confirmed counterexample into an unmet criterion and blocks (the never-STARTED case)', () => {
      const r = finalizeRounds([{ criteria: crit, audit: [holds(1), counter(2)] }], reqs);
      expect(r.criteria[1].status).toBe('unmet');
      expect(r.criteria[1].evidence).toContain('Started can never be produced');
      expect(r.ship).toBe(false);
      expect(r.blockers_text).toContain('AC2');
      expect(r.criteria_audit.refuted).toEqual([2]);
    });

    it('caps at partial, without blocking, a counterexample below the confidence bar, an unverifiable audit, a holds with no traced input and a missing audit', () => {
      const cases: Array<[string, Array<Record<string, unknown>>]> = [
        ['low confidence counterexample', [holds(1), counter(2, 60)]],
        ['unverifiable', [holds(1), { criterion: 2, verdict: 'unverifiable', confidence: 90, outcomes: [], evidence: 'needs the device' }]],
        ['holds with nothing traced', [holds(1), { criterion: 2, verdict: 'holds', confidence: 95, outcomes: [], evidence: 'looks fine' }]],
        ['holds below the bar', [holds(1), holds(2, 50)]],
        ['no result for the criterion', [holds(1)]],
      ];
      for (const [name, audit] of cases) {
        const r = finalizeRounds([{ criteria: crit, audit }], reqs);
        expect(r.criteria[1].status, name).toBe('partial');
        expect(r.criteria_audit.unconfirmed, name).toEqual([2]);
        expect(r.ship, name).toBe(true);
        expect(r.needs_human_attention, name).toBe(true);
      }
    });

    it('fails closed when the audit step returned nothing at all', () => {
      const r = finalizeRounds([{ criteria: crit, audit: [] }], reqs);
      expect(r.criteria_counts).toMatchObject({ met: 0, partial: 2 });
    });

    it('audits only the criteria the reviewer rated met, and is off when the workflow passes no audit', () => {
      const mixed = [crit[0]!, { criterion: 'B', status: 'partial', evidence: 'half', evidence_kind: 'code_read' }];
      const r = finalizeRounds([{ criteria: mixed, audit: [holds(1)] }], reqs);
      expect(r.criteria_audit.unconfirmed).toEqual([]);
      const off = finalizeRounds([{ criteria: crit }], reqs);
      expect(off.criteria_audit.enabled).toBe(false);
      expect(off.criteria_counts.met).toBe(2);
    });

    it('uses the audit of the round that was reviewed when the fix was not reviewed again', () => {
      const r = finalizeRounds([{ criteria: crit, audit: [holds(1), counter(2)] }, { reviewed: false }], reqs);
      expect(r.criteria_audit.refuted).toEqual([2]);
      expect(r.ship).toBe(false);
    });
  });
});
