import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifyAlerts } from '../src/server/alerts.js';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * Mission control operations (docs/mission-control-plan.md): spend limits refuse new runs of
 * workflows with agent steps on every trigger, and alerts are recorded, resolved and sent to the
 * workspace's Slack channel once each.
 */
const up = await temporalAvailable();

describe.skipIf(!up)('operations', () => {
  let h: Harness;
  let agent: string;
  let approval: string;

  beforeAll(async () => {
    h = await startHarness({ worker: false });
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    agent = (await uploadDir(h.api, 'test/fixtures/agent')).version.id;
    await h.api.post(`/v1/versions/${agent}/publish`, {});
    approval = (await uploadDir(h.api, 'test/fixtures/approval')).version.id;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: agent, inputs: {} });
    expect((await waitForRun(h.api, run_id)).run.state).toBe('succeeded');
  });
  afterAll(async () => h?.stop());

  it('refuses new runs once a spend limit is used up, on every trigger but test runs', async () => {
    const [spent] = (await h.api.get<any>('/v1/usage/summary?days=1')).by_workflow;
    expect(spent).toMatchObject({ workflow: 'agent-check', runs: 1 });
    expect(spent.cost).toBeGreaterThan(0);

    const u = await h.api.post<{ token: string }>('/v1/users', { display_name: 'op', role: 'operator' });
    await expect(new ApiClient(h.server.url, u.token).put('/v1/budgets', { workflow: 'agent-check', period: 'day', limit: 1 })).rejects.toThrow(/admin/);

    const b = await h.api.put<any>('/v1/budgets', { workflow: 'agent-check', period: 'day', limit: spent.cost / 2 });
    expect(b).toMatchObject({ workflow: 'agent-check', period: 'day', exceeded: true });
    expect(b.used_pct).toBeGreaterThanOrEqual(200);

    const plan = await h.api.get<any>(`/v1/versions/${agent}/plan`);
    expect(plan.blockers).toEqual([expect.objectContaining({ code: 'budget_exceeded' })]);
    await expect(h.api.post('/v1/runs', { version: agent, inputs: {} })).rejects.toThrow(/agent-check daily limit .* is used up/);
    const test = await h.api.post<{ run_id: string }>('/v1/runs', { version: agent, inputs: {}, test: true });
    expect(test.run_id).toMatch(/^run_/);
    // A workflow without agent steps spends nothing and is not held back.
    expect((await h.api.get<any>(`/v1/versions/${approval}/plan`)).blockers).toEqual([]);

    // A scheduled occurrence is skipped and audited, not retried, and the schedule moves on.
    const s = await h.api.post<any>('/v1/schedules', { workflow: 'agent-check', cron: '* * * * *', timezone: 'UTC' });
    await h.server.ctx.pool.query(`UPDATE schedules SET next_occurrence_at = now() - interval '1 minute' WHERE id=$1`, [s.id]);
    await h.server.scheduler!.tick();
    const audit = await h.api.get<any[]>('/v1/audit');
    expect(audit.find((e) => e.kind === 'schedule.occurrence_refused')).toMatchObject({ data: { workflow: 'agent-check', reason: expect.stringMatching(/used up/) } });
    const next = (await h.server.ctx.pool.query(`SELECT next_occurrence_at FROM schedules WHERE id=$1`, [s.id])).rows[0].next_occurrence_at;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    await h.api.post('/v1/schedules', { workflow: 'agent-check', cron: '* * * * *', timezone: 'UTC', enabled: false });

    const alerts = await h.api.get<any[]>('/v1/alerts');
    expect(alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(['budget.exceeded', 'schedule.occurrence_refused']));

    await h.api.put('/v1/budgets', { workflow: 'agent-check', period: 'day', limit: spent.cost * 100 });
    expect((await h.api.get<any>(`/v1/versions/${agent}/plan`)).ok).toBe(true);
    await h.api.del(`/v1/budgets/${b.id}`);
    expect(await h.api.get('/v1/budgets')).toEqual([]);
  });

  it('records alerts, sends each new one to Slack once, and resolves cleared ones', async () => {
    const settings = await h.api.get<any>('/v1/settings/alerts');
    expect(settings).toMatchObject({ slack_channel: null, min_level: 'warning', enabled: true, slack_token_set: true });

    await h.api.put('/v1/settings/alerts', { slack_channel: 'C-ALERTS', min_level: 'warning', enabled: true });
    const before = h.slack.messages.length;
    await h.api.post('/v1/settings/alerts/test', {});
    expect(h.slack.messages.at(-1)).toMatchObject({ channel: 'C-ALERTS', text: expect.stringContaining('will be posted in this channel') });

    // A workspace-wide limit that is already used up raises a critical alert.
    const b = await h.api.put<any>('/v1/budgets', { workflow: null, period: 'month', limit: 0.000001 });
    await notifyAlerts(h.server.ctx);
    await notifyAlerts(h.server.ctx);
    const posted = h.slack.messages.slice(before + 1).filter((m) => m.channel === 'C-ALERTS');
    const budget = posted.filter((m) => m.text.includes('workspace monthly limit is used up'));
    expect(budget).toHaveLength(1);
    expect(budget[0]!.text).toMatch(/^:red_circle: \*Azhi Flow critical\*/);

    const history = await h.api.get<any[]>('/v1/alerts/history');
    const row = history.find((r) => r.key.startsWith(`budget:${b.id}:`));
    expect(row).toMatchObject({ level: 'critical', resolved_at: null, notify_error: null });
    expect(row.notified_at).not.toBeNull();

    await h.api.del(`/v1/budgets/${b.id}`);
    await notifyAlerts(h.server.ctx);
    expect((await h.api.get<any[]>('/v1/alerts/history')).find((r) => r.key.startsWith(`budget:${b.id}:`)).resolved_at).not.toBeNull();
    expect((await h.api.get<any[]>('/v1/audit')).some((e) => e.kind === 'settings.alerts_changed')).toBe(true);
  });
});
