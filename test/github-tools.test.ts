import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executorFor } from '../src/gateway/executors.js';
import type { ToolSpec } from '../src/gateway/types.js';
import { startFakeGithub } from '../src/testing/fake-github.js';

/**
 * The GitHub tools for the flagship return the shapes of the fixture tools from real API
 * responses, here a local stand-in for GitHub: Actions runs with failed job names, flaky-test
 * issues and open incidents, with pull requests left out and bad credentials refused.
 */
describe('github tools', () => {
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  const runs = Array.from({ length: 130 }, (_, i) => ({
    id: 1000 + i,
    conclusion: i === 5 ? 'failure' : i === 6 ? 'cancelled' : 'success',
    head_branch: 'main',
    run_started_at: new Date(Date.UTC(2026, 8, 20, 0, i)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 8, 20, 0, i, 30)).toISOString(),
    jobs: i === 5 ? [{ name: 'unit', conclusion: 'success' }, { name: 'e2e checkout', conclusion: 'failure' }] : [],
  }));
  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    gh = await startFakeGithub(
      {
        runs,
        issues: [
          { number: 7, title: 'test_checkout_timeout', labels: ['flaky-test'], comments: 4 },
          { number: 8, title: 'test_payment_retry', labels: ['flaky-test', 'quarantined'], comments: 1 },
          { number: 9, title: 'a pull request', labels: ['flaky-test'], pull_request: true },
          { number: 12, title: 'CI runners out of disk', labels: ['incident', 'sev3'] },
        ],
      },
      { token: 'ghp_test' },
    );
  });
  afterAll(async () => {
    delete process.env.AZHI_EGRESS_ALLOW;
    await gh.stop();
  });

  const spec = (name: string, config: Record<string, unknown> = {}): ToolSpec => ({
    id: name,
    version: 1,
    description: '',
    effect: 'read',
    input_schema: { type: 'object' },
    output_schema: {},
    transport: { kind: 'builtin', name, config: { repos: ['acme/payments'], api_url: gh.url, ...config } },
  });
  const call = (name: string, args: Record<string, unknown> = {}, token: string | null = 'ghp_test', config?: Record<string, unknown>) =>
    executorFor(spec(name, config)).call(spec(name, config), args, { credential: token ?? undefined, timeoutMs: 10_000 });

  it('lists completed runs across pages, with failed job names', async () => {
    const { value } = (await call('github.ci-runs', {})) as { value: any[] };
    expect(value).toHaveLength(130);
    expect(value[5]).toMatchObject({ id: 'acme/payments#1005', status: 'failure', branch: 'main', failed_tests: ['e2e checkout'] });
    expect(value[6].status).toBe('cancelled');
    expect(value[0]).toMatchObject({ status: 'success', failed_tests: [] });
  });

  it('honours since', async () => {
    const { value } = (await call('github.ci-runs', { since: '2026-09-20T01:00:00Z' })) as { value: any[] };
    expect(value.length).toBe(130 - 60);
  });

  it('lists flaky tests from labelled issues and leaves pull requests out', async () => {
    const { value } = await call('github.flaky-tests');
    expect(value).toEqual([
      { test: 'test_checkout_timeout', failures: 5, quarantined: false },
      { test: 'test_payment_retry', failures: 2, quarantined: true },
    ]);
  });

  it('lists open incidents with their severity', async () => {
    expect((await call('github.incidents')).value).toEqual([{ id: 'acme/payments#12', title: 'CI runners out of disk', severity: 'sev3', opened_at: '2026-09-25T04:10:00Z' }]);
  });

  it('refuses a bad token as an authorization error and a missing config as invalid input', async () => {
    await expect(call('github.incidents', {}, 'wrong')).rejects.toMatchObject({ definite: true, errorClass: 'authorization' });
    await expect(call('github.incidents', {}, null)).rejects.toThrow(/token/);
    await expect(call('github.incidents', {}, 'ghp_test', { repos: [] })).rejects.toThrow(/repos/);
  });
});
