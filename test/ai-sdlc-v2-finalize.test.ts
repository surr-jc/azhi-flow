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
  criteria?: Array<{ criterion: string; status: string; evidence: string }>;
  reviewed?: boolean;
}

/** Runs finalize over several rounds; `requirements` is what the workflow passes from the plan. */
function finalizeRounds(rounds: Round[], requirements?: { acceptance_criteria: string[] }) {
  const lite = rounds.map((r) => {
    if (r.built === false) return { change: null, verdicts: { lite: null }, checks: [] };
    const ws = {
      base_sha: 'abc',
      diff: '+x\n',
      files: [{ path: 'a.ts', status: 'added', mode: '100644', content: 'x', additions: 1, deletions: 0 }],
      stats: { files: 1, additions: 1, deletions: 0 },
      tests: { status: 'passed', command: 'check', exit_code: 0, attempts: 1, output: '' },
      ...(r.stepLimit ? { step_limit_reached: true } : {}),
    };
    const change = { summary: 's', commit_message: 'm', pr_title: 't', pr_body: 'Body\n', deviations: [], tests_added: [], workspace: ws };
    const findings = r.findings ?? [];
    const verdict = r.reviewed === false ? null : { summary: 'ok', approved: findings.length === 0, findings, prompt_injection_detected: false, ...(r.criteria ? { criteria: r.criteria } : {}) };
    return { change, verdicts: { lite: verdict }, checks: r.checks ?? [] };
  });
  const input = {
    verification: 'full',
    min_confidence: 80,
    ticket: { title: 'T' },
    repo: 'acme/app',
    weight: { proposed: 'lite', final: 'lite', overridden_by: null },
    design_review: { by: 'u' },
    ...(requirements ? { requirements } : {}),
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
      expect(md).toContain('| B | partial | no mobile check |');
      expect(md.indexOf('### Review findings')).toBeLessThan(md.indexOf('<details>'));
    });
  });
});
