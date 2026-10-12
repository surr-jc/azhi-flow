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
});
