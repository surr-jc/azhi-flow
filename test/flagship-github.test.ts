import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGithub } from '../src/testing/fake-github.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * The flagship with real data sources: the same workflow, with its three tools registered from
 * examples/quality-report/azhi.config.github.yaml against a stand-in for GitHub instead of the
 * fixtures. The figures in the Slack message come from the GitHub responses.
 */
const up = await temporalAvailable();
const PKG = 'examples/quality-report';

describe.skipIf(!up)('flagship on GitHub data', () => {
  let h: Harness;
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    // 10 completed runs a day apart over the last week: 8 pass, 2 fail on the same job.
    const day = 86_400_000;
    const runs = Array.from({ length: 10 }, (_, i) => {
      const at = Date.now() - (9 - i) * day * 0.5;
      return {
        id: 500 + i,
        conclusion: i === 3 || i === 7 ? 'failure' : 'success',
        head_branch: 'main',
        run_started_at: new Date(at).toISOString(),
        updated_at: new Date(at + 600_000).toISOString(),
        jobs: [{ name: 'checkout e2e', conclusion: 'failure' }],
      };
    });
    gh = await startFakeGithub({ runs, issues: [{ number: 3, title: 'test_checkout_timeout', labels: ['flaky-test'], comments: 2 }, { number: 4, title: 'Runners out of disk', labels: ['incident', 'sev2'] }] }, { token: 'ghp_test' });
    h = await startHarness();
    await h.api.put('/v1/secrets/github-token', { value: 'ghp_test' });
    const config = parse(readFileSync(`${PKG}/azhi.config.github.yaml`, 'utf8'));
    for (const t of config.tools) {
      t.transport.config.repos = ['acme/payments'];
      t.transport.config.api_url = gh.url;
      await h.api.post('/v1/tools', t);
    }
    await h.api.post('/v1/datasets', { name: 'quality-guidelines' });
    await h.api.post('/v1/datasets/quality-guidelines/documents', { documents: [{ path: 'quality-guidelines.md', content: readFileSync(`${PKG}/knowledge/quality-guidelines.md`, 'utf8') }] });
    await h.api.post('/v1/datasets/quality-guidelines/publish', { tag: 'approved' });
  });
  afterAll(async () => {
    delete process.env.AZHI_EGRESS_ALLOW;
    await h?.stop();
    await gh?.stop();
  });

  it('reports figures computed from GitHub Actions runs and issues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-flagship-gh-'));
    cpSync(PKG, dir, { recursive: true });
    const profile = parse(readFileSync(`${PKG}/profiles/quality-analyst@1.yaml`, 'utf8'));
    writeFileSync(join(dir, 'profiles/quality-analyst@1.yaml'), JSON.stringify({ ...profile, model: { provider: 'scripted' }, script: [{ output: { headline: 'Two main runs failed on the checkout job.', points: [{ text: 'The checkout e2e job failed twice.', citations: ['{{chunk:0}}'] }], insufficient_evidence: false } }] }));
    const v = await uploadDir(h.api, dir);
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs: { team: 'payments' } });
    const d = await waitForRun(h.api, run_id, 90_000);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    const text = h.slack.messages.at(-1)!.text;
    expect(text).toContain('8 of 10 main runs');
    expect(text).toContain('checkout');
    expect(text).toMatch(/_ci data as of|github-actions data as of/);
    expect(gh.requests.some((r) => r.includes('/actions/runs'))).toBe(true);
  });
});
