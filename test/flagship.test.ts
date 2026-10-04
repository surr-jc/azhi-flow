import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * Alpha check 3 (first proof): the quality report runs from its schedule with no client attached,
 * and the Slack message carries the script's figures, numbered citations to immutable excerpts,
 * and per-source as-of times. The analyst uses the scripted provider so the test needs no model.
 */
const up = await temporalAvailable();
const PKG = 'examples/quality-report';

function scriptedPackage(output: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-flagship-'));
  cpSync(PKG, dir, { recursive: true });
  writeFileSync(
    join(dir, 'profiles/quality-analyst@1.yaml'),
    JSON.stringify({ ...parse(readFileSync(`${PKG}/profiles/quality-analyst@1.yaml`, 'utf8')), model: { provider: 'scripted' }, script: [{ output }] }),
  );
  return dir;
}

describe.skipIf(!up)('flagship: weekly quality report', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    for (const t of parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools) await h.api.post('/v1/tools', t);
    await h.api.post('/v1/datasets', { name: 'quality-guidelines' });
    await h.api.post('/v1/datasets/quality-guidelines/documents', { documents: [{ path: 'quality-guidelines.md', content: readFileSync(`${PKG}/knowledge/quality-guidelines.md`, 'utf8') }] });
    await h.api.post('/v1/datasets/quality-guidelines/publish', { tag: 'approved' });
  });
  afterAll(async () => h?.stop());

  it('runs from the schedule and posts figures, citations and as-of times to Slack', async () => {
    const dir = scriptedPackage({
      headline: 'Pass rate fell 10 points to 85.0%; most failures were the flaky checkout test.',
      points: [
        { text: 'Two of three failures were test_checkout_timeout, which is flaky and not quarantined yet.', citations: ['{{chunk:0}}'] },
        { text: 'Mean time to green rose by 4.0 h.', citations: ['{{chunk:1}}'] },
      ],
      insufficient_evidence: false,
    });
    const v = await uploadDir(h.api, dir);
    await h.api.post(`/v1/versions/${v.version.id}/publish`, {});
    const sched = (await h.server.ctx.pool.query(`SELECT s.id FROM schedules s JOIN workflows w ON w.id = s.workflow_id WHERE w.slug='quality-report'`)).rows[0];
    expect(sched).toBeTruthy();
    await h.server.ctx.pool.query(`UPDATE schedules SET next_occurrence_at = date_trunc('second', now()), inputs='{"team":"payments"}' WHERE id=$1`, [sched.id]);
    await h.server.scheduler!.tick();
    const runId = (await h.server.ctx.pool.query(`SELECT id FROM runs WHERE trigger='schedule' ORDER BY created_at DESC LIMIT 1`)).rows[0].id;

    const d = await waitForRun(h.api, runId, 90_000);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    expect(h.slack.messages).toHaveLength(1);
    const text = h.slack.messages[0]!.text;
    expect(text).toContain('Pass rate 85% (-10 pts week over week), 17 of 20 main runs');
    expect(text).toContain('Mean time to green 12 h (4 h)');
    expect(text).toMatch(/flaky and not quarantined yet\. \[1\]/);
    expect(text).toMatch(/\[1\] quality-guidelines\.md › Quality guidelines.* \(quality-guidelines@1\)/);
    for (const source of ['ci', 'flaky-tests', 'incidents']) expect(text).toMatch(new RegExp(`_${source} data as of \\d{4}-\\d\\d-\\d\\dT`));

    const report = d.attempts.find((a: any) => a.node_id === 'report').output;
    expect(report.citations[0]).toMatchObject({ n: 1, dataset: 'quality-guidelines', revision: 1, document: 'quality-guidelines.md' });
    expect(report.citations[0].id).toMatch(/^c_/);
    expect(d.actions).toHaveLength(1);
    expect(d.actions[0].state).toBe('confirmed');
  });

  it('refuses agent output that cites excerpts it was not shown', async () => {
    const dir = scriptedPackage({ headline: 'x', points: [{ text: 'made up', citations: ['c_0123456789abcdef0123'] }], insufficient_evidence: false });
    const v = (await uploadDir(h.api, dir)).version.id;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v, inputs: { team: 'payments' } });
    const d = await waitForRun(h.api, run_id, 90_000);
    expect(d.run.state).toBe('failed');
    expect(d.run.error.class).toBe('contract_violation');
    expect(d.run.error.message).toMatch(/cites excerpts it was not given/);
  });
});
