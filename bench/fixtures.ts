import type { FakeStep } from '../src/testing/fake-anthropic.js';

/**
 * The executor comparison fixtures (implementation plan, Phase 3): 30 scripted scenarios that
 * both executors play against the same Anthropic-compatible stand-in. They measure the adapter
 * contract (does the run end as the platform promises, what does it cost, how long does it take,
 * what tools does the model see), never model quality: the "model" is a script.
 */
export interface Fixture {
  id: string;
  kind: string;
  script: FakeStep[];
  expect: { state: 'succeeded' | 'failed'; error_class?: string; output?: Record<string, unknown> };
}

const CASES = [
  { summary: '1 of 4 runs failed (r3).', failed: 1 },
  { summary: 'One failure in four runs, on r3.', failed: 1 },
  { summary: 'r3 failed; the other three passed.', failed: 1 },
  { summary: 'Three green runs and one red (r3).', failed: 1 },
  { summary: 'A single failed run this week: r3.', failed: 1 },
];

const tool = (n = 1): FakeStep[] => Array.from({ length: n }, () => ({ tool: 'ci_list-runs_1', input: { team: 'payments' } }));
const submit = (o: Record<string, unknown>): FakeStep => ({ tool: 'submit_output', input: o });
const done: FakeStep = { text: 'done' };

export const FIXTURES: Fixture[] = CASES.flatMap((out, i) => [
  { id: `direct-${i + 1}`, kind: 'submit directly', script: [submit(out), done], expect: { state: 'succeeded', output: out } },
  { id: `tool-${i + 1}`, kind: 'tool call, then submit', script: [...tool(1 + (i % 2)), submit(out), done], expect: { state: 'succeeded', output: out } },
  { id: `repair-${i + 1}`, kind: 'one invalid output, repaired', script: [submit({ summary: out.summary }), submit(out), done], expect: { state: 'succeeded', output: out } },
  { id: `exhausted-${i + 1}`, kind: 'invalid output, repairs exhausted', script: [submit({ wrong: i })], expect: { state: 'failed', error_class: 'contract_violation' } },
  { id: `denied-${i + 1}`, kind: 'disallowed tool, then submit', script: [{ tool: 'deploy_service', input: { service: 'payments' } }, submit(out), done], expect: { state: 'succeeded', output: out } },
  { id: `budget-${i + 1}`, kind: 'tool-call budget exceeded', script: [...tool(4 + i), submit(out), done], expect: { state: 'failed', error_class: 'budget_exceeded' } },
]);
