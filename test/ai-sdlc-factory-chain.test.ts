import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PYTHON } from './helpers/python.js';

/**
 * The AI SDLC Factory as one chain, on the real decision scripts of all four packages and no model:
 * the approved release plan becomes epics, a lap picks a slice, the delivery's outcome is read, and the
 * verification of staging turns a failed journey into a ticket that the next lap picks first.
 * This checks that each stage's output is what the next stage reads. It is not a run on the engine
 * (that needs Temporal and a model); the runbook in docs/runbooks covers the live path.
 */
// The worker runs scripts with UTF-8 forced, so the same is done here.
const run = (pkg: string, script: string, input: unknown) =>
  JSON.parse(
    execFileSync(PYTHON[0]!, [...PYTHON.slice(1), join('examples', pkg, 'scripts', script)], {
      input: JSON.stringify(input),
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }).toString(),
  );

const prd = {
  title: 'Pay by card',
  summary: 'Customers can pay.',
  invariants: ['An order is never charged twice'],
  non_goals: ['Refunds'],
  journeys: [
    { name: 'Checkout', steps: ['Add to cart', 'Pay', 'See receipt'] },
    { name: 'Login', steps: ['Open the page', 'Sign in'] },
  ],
  walking_skeleton: 'cart -> pay -> receipt',
  epics: [{ title: 'Pay', goal: 'Take a card payment', scope: ['src/pay'], acceptance_criteria: ['A card payment succeeds'], depends_on_note: '' }],
};

const config = { claim_label: 'factory-in-progress', owner_label: 'factory-needs-owner', priority_label: 'priority' };
const slice = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Slice ${number}`,
  labels: ['ready', 'azhi-split'],
  parent: 5,
  slice: number,
  depends: [],
  blocked: false,
  reason: '',
  in_flight: false,
  created_at: `2026-10-0${number % 9}T00:00:00Z`,
  ...extra,
});
const lap = (items: unknown[]) => run('ai-sdlc-factory', 'pick.py', { source: 'github', repo: 'acme/shop', config, github: { queues: [{ items }] } });

describe('the factory chain: plan, lap, outcome, verify, and back into the next lap', () => {
  it('carries the plan to the splitter, the lap to a pull request, and a failed journey to the next lap', () => {
    // 1. The approved plan becomes the text each splitter receives, with the journeys and invariants in front.
    const epics = run('ai-sdlc-factory-plan', 'epics.py', { prd, drop: '' });
    expect(epics.count).toBe(1);
    expect(epics.epics[0].text).toContain('An order is never charged twice');
    expect(epics.epics[0].text).toContain('A card payment succeeds');

    // 2. A lap takes the first workable slice and labels it for the claim.
    const first = lap([slice(1), slice(2, { depends: [1], blocked: true, reason: 'waiting for #1' })]);
    expect(first).toMatchObject({ route: 'work', ticket: { number: 1 }, claim_labels: ['factory-in-progress'] });

    // 3. The delivery opened a pull request: shipped. Without one, the ticket is sent back to its owner.
    const shipped = run('ai-sdlc-factory', 'outcome.py', {
      child: { nodes: { open_pr: { url: 'https://github.com/acme/shop/pull/7', number: 7 }, finalize: { change: { summary: 'Added', tests: { status: 'passed' } } } } },
    });
    expect(shipped).toMatchObject({ status: 'shipped', pr_number: 7 });
    expect(run('ai-sdlc-factory', 'outcome.py', { child: { nodes: { finalize: { change: { tests: { status: 'failed' } } } } } })).toMatchObject({ status: 'sent_back' });

    // 4. After the merge, staging is verified against the plan's own journeys. One fails, CI is green.
    const journeys = prd.journeys.map((j) => ({
      name: j.name,
      status: j.name === 'Checkout' ? 'fail' : 'pass',
      evidence: j.name === 'Checkout' ? [] : ['src/auth.ts'],
      gap: j.name === 'Checkout' ? 'No receipt page' : '',
    }));
    const verdict = run('ai-sdlc-factory-verify', 'verdict.py', {
      repo: 'acme/shop',
      staging_branch: 'dev',
      labels: ['ready', 'priority', 'release-verify'],
      verify: { method: 'read the code', journeys, invariants: [] },
      runs: [{ id: '9', status: 'success', branch: 'dev' }],
    });
    expect(verdict).toMatchObject({ overall: 'failed', propose_fix: true });

    // 5. The fix ticket the verifier proposes carries the labels the lap reads, so the next lap takes it first.
    const fix = slice(30, { labels: verdict.ticket.labels, parent: 0, slice: 0, created_at: '2026-10-09T00:00:00Z' });
    const next = lap([slice(3), fix]);
    expect(next).toMatchObject({ route: 'work', ticket: { number: 30 }, reason: 'high priority' });
  });

  it('does less rather than guess: an empty queue is idle and an unverified journey is not a pass', () => {
    expect(lap([]).route).toBe('idle');
    const v = run('ai-sdlc-factory-verify', 'verdict.py', {
      repo: 'a/b',
      staging_branch: 'dev',
      labels: [],
      verify: { method: 'read', journeys: [{ name: 'Checkout', status: 'pass', evidence: [], gap: '' }], invariants: [] },
      runs: [],
    });
    expect(v.overall).toBe('unavailable');
  });
});
