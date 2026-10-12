import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangeReview, isChangeReview } from '../web/src/components/ChangeReview.js';

const diff = 'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n';
const payload = {
  repository: 'acme/app',
  branch: 'azhi/acme-app-28',
  pr_title: 'feat: a thing [static-checks-only]',
  stats: { files: 1, additions: 1, deletions: 0 },
  diff,
  tests: { status: 'passed', command: 'check', exit_code: 0, attempts: 1 },
  fix_rounds_used: 1,
  needs_human_attention: true,
  closes_removed: true,
  targeted_tests: { result: 'passed', files: 2 },
  criteria: [
    { criterion: 'A provider can be disabled', status: 'met', evidence: 'src/a.ts:2; test/a.test.ts:5' },
    { criterion: 'The picker never offers a filtered model', status: 'partial', evidence: 'the server default option bypasses the filter' },
    { criterion: 'Roles are enforced', status: 'unmet', evidence: 'no test for a viewer write' },
  ],
  criteria_counts: { met: 1, partial: 1, unmet: 1, unverifiable: 0 },
  verdict: { approved: false, findings: [{ id: 'L1', severity: 'major', path: 'src/a.ts', line: 2, message: '**Server default bypasses the filter.** Details here.', confidence: 99, reviewer: 'lite' }], reviewers: [{ reviewer: 'lite', approved: false, major: 1 }] },
  evidence: { verification: 'static', coverage: null },
};

describe('the release review', () => {
  it('recognises a change review payload', () => {
    expect(isChangeReview(payload)).toBe(true);
    expect(isChangeReview({ diff: 'not a diff', verdict: { findings: [] } })).toBe(false);
    expect(isChangeReview(null)).toBe(false);
  });

  it('shows each acceptance criterion with its status and evidence, and says why it is a draft', () => {
    const html = renderToStaticMarkup(createElement(ChangeReview, { payload: payload as never }));
    expect(html).toContain('Acceptance criteria (1 of 3 met)');
    expect(html).toContain('A provider can be disabled');
    expect(html).toContain('partly met');
    expect(html).toContain('not met');
    expect(html).toContain('the server default option bypasses the filter');
    expect(html).toContain('2 of 3 acceptance criteria are not fully met');
    expect(html).toContain('merging it will not close the ticket');
    expect(html).toContain('Opens as a draft pull request');
    expect(html).toContain('New or changed test files run');
  });

  it('omits the criteria section when the reviewers returned none', () => {
    const { criteria: _c, criteria_counts: _n, ...rest } = payload;
    const html = renderToStaticMarkup(createElement(ChangeReview, { payload: rest as never }));
    expect(html).not.toContain('Acceptance criteria');
  });
});
