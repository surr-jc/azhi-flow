import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAllowed, parseRunCommand, resultText } from '../src/server/slack-runs.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

describe('parseRunCommand', () => {
  it('reads the workflow slug and key=value inputs, with quoted values', () => {
    expect(parseRunCommand('run quality-report team=payments topic="a b c"')).toEqual({ workflow: 'quality-report', inputs: { team: 'payments', topic: 'a b c' } });
    expect(parseRunCommand('  run pr-review  ')).toEqual({ workflow: 'pr-review', inputs: {} });
  });

  it('refuses anything that is not `run <slug> key=value`', () => {
    expect(() => parseRunCommand('')).toThrow(/Usage/);
    expect(() => parseRunCommand('status run_1')).toThrow(/Usage/);
    expect(() => parseRunCommand('run Not_A_Slug')).toThrow(/slug/);
    expect(() => parseRunCommand('run wf novalue')).toThrow(/key=value/);
    expect(() => parseRunCommand('run wf =x')).toThrow(/key=value/);
    expect(() => parseRunCommand('run wf bad-key=1')).toThrow(/key=value/);
    expect(() => parseRunCommand('run wf a=1 a=2')).toThrow(/twice/);
    expect(() => parseRunCommand(`run wf big=${'x'.repeat(1001)}`)).toThrow(/longer than/);
    expect(() => parseRunCommand(`run wf ${Array.from({ length: 21 }, (_, i) => `k${i}=1`).join(' ')}`)).toThrow(/At most/);
  });

  it('keeps hostile text as an inert string input, never as a command', () => {
    const r = parseRunCommand('run wf note="; rm -rf / $(whoami) <!channel>"');
    expect(r.workflow).toBe('wf');
    expect(r.inputs.note).toBe('; rm -rf / $(whoami) <!channel>');
    // The workflow is a slug, so it cannot carry a version, a path or a tool name.
    expect(() => parseRunCommand('run wf@latest')).toThrow(/slug/);
    expect(() => parseRunCommand('run ../etc')).toThrow(/slug/);
  });
});

describe('isAllowed', () => {
  it('denies by default and allows only listed slugs when enabled', () => {
    expect(isAllowed({}, 'wf')).toBe(false);
    expect(isAllowed({ enabled: true }, 'wf')).toBe(false);
    expect(isAllowed({ enabled: false, workflows: ['wf'] }, 'wf')).toBe(false);
    expect(isAllowed({ enabled: true, workflows: ['wf'] }, 'wf')).toBe(true);
    expect(isAllowed({ enabled: true, workflows: ['wf'] }, 'other')).toBe(false);
  });
});

describe('resultText', () => {
  const link = 'http://x/ui/runs/run_1';
  it('says "unavailable" when the duration is unknown', () => {
    expect(resultText({ workflow: 'wf', state: 'succeeded', started_at: null, ended_at: '2026-01-01T00:00:05Z' }, link)).toContain('duration: unavailable');
    expect(resultText({ workflow: 'wf', state: 'succeeded', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:05Z' }, link)).toContain('duration: 5s');
  });
  it('shows failures with an escaped, clipped error and always links to the run', () => {
    const t = resultText({ workflow: 'wf', state: 'failed', error: { message: `<!channel> ${'e'.repeat(800)}` } }, link);
    expect(t).toContain(':x:');
    expect(t).toContain('&lt;!channel&gt;');
    expect(t).not.toContain('<!channel>');
    expect(t.length).toBeLessThan(800);
    expect(t).toContain(`<${link}|Open in mission control>`);
  });
});

const up = await temporalAvailable();

describe.skipIf(!up)('/azhi run from Slack', () => {
  let h: Harness;
  const secret = 'shh-commands';
  const command = async (text: string, o: { user?: string; channel?: string; sign?: boolean; retry?: boolean } = {}) => {
    const body = new URLSearchParams({ command: '/azhi', text, user_id: o.user ?? 'U0OP', channel_id: o.channel ?? 'C-CMD', response_url: `${h.slack.url}/response/cmd` }).toString();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac('sha256', o.sign === false ? 'wrong' : secret).update(`v0:${ts}:${body}`).digest('hex')}`;
    const res = await fetch(`${h.server.url}/v1/slack/commands`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig, ...(o.retry ? { 'x-slack-retry-num': '1' } : {}) }, body });
    const raw = await res.text();
    return { status: res.status, json: raw ? JSON.parse(raw) : undefined };
  };
  const until = async <T>(fn: () => T | undefined, ms = 30_000): Promise<T> => {
    for (let i = 0; i < ms / 100; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timed out');
  };
  const sent = (key: string) => h.slack.messages.filter((m) => (m.metadata?.event_payload as { action_id?: string } | undefined)?.action_id?.startsWith(key));

  beforeAll(async () => {
    h = await startHarness({ worker: false });
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    // `@latest` is the newest published version: a draft cannot be started from Slack.
    const uploaded = await uploadDir(h.api, 'test/fixtures/approval');
    await h.api.post(`/v1/versions/${uploaded.version.id}/publish`, {});
    await h.api.put('/v1/secrets/slack-signing-secret', { value: secret });
    await h.api.put('/v1/secrets/slack-bot-token', { value: 'xoxb-test' });
    const op = await h.api.post<any>('/v1/users', { display_name: 'Op', role: 'operator', token: false });
    await h.api.patch(`/v1/users/${op.id}`, { slack_user_id: 'U0OP' });
    const viewer = await h.api.post<any>('/v1/users', { display_name: 'View', role: 'viewer', token: false });
    await h.api.patch(`/v1/users/${viewer.id}`, { slack_user_id: 'U0VIEW' });
  });
  afterAll(async () => h?.stop());

  const lastReply = async (before: number) => (await until(() => (h.slack.responses.length > before ? h.slack.responses.at(-1) : undefined))) as { text: string };

  it('is refused until the setting is on, and for a bad signature', async () => {
    // Nothing is enabled yet, so no workspace's secret can verify the command.
    expect((await command('run approval-check')).status).toBe(401);
    await h.api.put('/v1/settings/slack-commands', { enabled: true, workflows: ['approval-check'], channel: null });
    expect((await command('run approval-check', { sign: false })).status).toBe(401);
    expect((await h.api.get<any>('/v1/settings/slack-commands')).workflows).toEqual(['approval-check']);
  });

  it('answers privately when the user is unlinked, too low a role, or the workflow is not allowed', async () => {
    const runs = (await h.api.get<any[]>('/v1/runs')).length;
    let n = h.slack.responses.length;
    expect((await command('run approval-check', { user: 'U0NOBODY' })).status).toBe(200);
    expect((await lastReply(n)).text).toContain('not linked');
    n = h.slack.responses.length;
    await command('run approval-check', { user: 'U0VIEW' });
    expect((await lastReply(n)).text).toMatch(/requires role operator/);
    n = h.slack.responses.length;
    await command('run some-other-workflow');
    expect((await lastReply(n)).text).toContain('cannot be started from Slack');
    n = h.slack.responses.length;
    await command('please do things');
    expect((await lastReply(n)).text).toContain('Usage');
    expect((await h.api.get<any[]>('/v1/runs')).length).toBe(runs);
  });

  it('starts the run as the linked user and follows it in one thread: root, approval, one result', async () => {
    const seen = h.slack.responses.length;
    const ack = await command('run approval-check team=payments');
    expect(ack).toMatchObject({ status: 200, json: { response_type: 'ephemeral' } });
    // A refusal would arrive as a private reply instead; fail with its text rather than a bare timeout.
    const root = await until(() => {
      if (h.slack.responses.length > seen) throw new Error(String(h.slack.responses.at(-1)!.text));
      return sent('run-start:')[0];
    });
    expect(root.channel).toBe('C-CMD');
    expect(root.thread_ts).toBeUndefined();
    const runId = (root.metadata!.event_payload as { action_id: string }).action_id.slice('run-start:'.length);

    // A Slack retry of the same command starts nothing more.
    expect((await command('run approval-check team=payments', { retry: true })).status).toBe(200);

    // The approval is asked in the run's thread, not the approvals channel.
    const ask = await until(() => sent(`approval:${runId}:`)[0]);
    expect(ask.channel).toBe('C-CMD');
    expect(ask.thread_ts).toBe(root.ts);

    await h.api.post(`/v1/runs/${runId}/approvals`, { node: 'approve', decision: 'approved', data: {} });
    const done = await waitForRun(h.api, runId);
    expect(done.run.state).toBe('succeeded');
    expect(done.run.created_by).not.toBe('usr_local');

    const result = await until(() => sent(`run-result:${runId}`)[0]);
    expect(result.thread_ts).toBe(root.ts);
    expect(result.text).toContain('approval-check');
    expect(result.text).toContain('succeeded');
    // Later passes of the notifier post nothing more.
    await new Promise((r) => setTimeout(r, 6_000));
    expect(sent(`run-result:${runId}`)).toHaveLength(1);
    expect(sent('run-start:')).toHaveLength(1);
  }, 90_000);
});
