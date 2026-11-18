import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../src/api/app.js';
import { bootstrapLocal } from '../src/api/auth.js';
import { MAX_HISTORY_MESSAGES, trimHistory } from '../src/assistant/actions.js';
import { migrate } from '../src/db/migrate.js';
import { toMrkdwn } from '../src/gateway/tools/slack-format.js';
import { newId } from '../src/lib/ids.js';
import { newApiToken } from '../src/security/tokens.js';
import { createContext, type AppContext } from '../src/server/context.js';
import { setSecret } from '../src/server/secrets.js';
import { uploadPackage, upsertSchedule } from '../src/server/workflows.js';
import { startFakeAnthropic, type FakeRequest, type FakeStep } from '../src/testing/fake-anthropic.js';
import { startFakeSlack } from '../src/testing/fake-slack.js';

/**
 * The assistant in Slack: DMs and @azhi mentions become a conversation per thread, with the stored
 * transcript, an owner, event dedupe, and Confirm/Dismiss cards. Runs in-process on PGlite with a
 * scripted model and the fake Slack API; no Temporal needed.
 */
const profile = `model: {provider: anthropic, name: default, credential: anthropic-api-key}\nmax_turns: 2\ninstructions: |\n  Summarise the notes.\n`;
const schema = JSON.stringify({ type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false });
const workflow = `schema_version: "2.0"
id: standup-summary
name: Standup summary
trigger: {manual: true}
inputs:
  type: object
  properties: {notes: {type: string}}
nodes:
  - id: summarise
    type: agent
    profile: summariser@1
    input: {ref: inputs.notes}
    output_schema: schemas/summary.json
    budget: {max_output_tokens: 1000, max_tool_calls: 0}
`;
const b64 = (s: string) => Buffer.from(s).toString('base64');
const SECRET = 'shh-assistant';

describe('toMrkdwn / trimHistory', () => {
  it('turns Markdown into mrkdwn and cannot be used to ping or link', () => {
    expect(toMrkdwn('## Title\n**bold** and [docs](https://x.test/a)\n- one\n- two')).toBe('*Title*\n*bold* and <https://x.test/a|docs>\n• one\n• two');
    expect(toMrkdwn('<!channel> <@U1> a & b')).toBe('&lt;!channel&gt; &lt;@U1&gt; a &amp; b');
    expect(toMrkdwn('`**x**` and ```\n# y\n```')).toBe('`**x**` and ```\n# y\n```');
  });

  it('drops the oldest whole turns and never leaves a tool_result without its tool_use', () => {
    const turn = (i: number) => [
      { role: 'user' as const, content: [{ type: 'text' as const, text: `q${i}` }] },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: `t${i}`, name: 'list_runs', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: `t${i}`, content: 'ok' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: `a${i}` }] },
    ];
    const long = Array.from({ length: MAX_HISTORY_MESSAGES / 4 + 3 }, (_, i) => turn(i)).flat();
    const trimmed = trimHistory(long);
    expect(trimmed.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    expect(trimmed[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: expect.stringMatching(/^q\d+$/) }] });
    expect(trimmed.at(-1)).toEqual(long.at(-1));
    expect(trimHistory(long.slice(0, 8))).toEqual(long.slice(0, 8));
  });
});

describe('assistant in Slack', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof buildApi>;
  let fake: Awaited<ReturnType<typeof startFakeAnthropic>>;
  let slack: Awaited<ReturnType<typeof startFakeSlack>>;
  let ws: string;
  let ownerToken: string;
  let viewerToken: string;
  let schedule: string;
  let script: (req: FakeRequest) => FakeStep[] = () => [{ text: 'hello from the assistant' }];
  let n = 0;

  const user = async (role: string, slackUser: string | null) => {
    const id = newId('usr');
    const t = newApiToken();
    await ctx.pool.query(`INSERT INTO users(id, workspace_id, display_name, role, slack_user_id) VALUES ($1,$2,$3,$4,$5)`, [id, ws, role, role, slackUser]);
    await ctx.pool.query(`INSERT INTO api_tokens(id, workspace_id, user_id, name, token_hash) VALUES ($1,$2,$3,$4,$5)`, [newId('tok'), ws, id, role, t.hash]);
    return { id, token: t.token };
  };
  const sign = (raw: string, secret = SECRET) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}` };
  };
  const event = async (body: Record<string, unknown>, o: { secret?: string } = {}) => {
    const raw = JSON.stringify(body);
    const r = await app.inject({ method: 'POST', url: '/v1/slack/events', headers: { 'content-type': 'application/json', ...sign(raw, o.secret) }, payload: raw });
    return r.statusCode;
  };
  const dm = (text: string, o: { user?: string; ts?: string; thread_ts?: string; event_id?: string; channel?: string } = {}) => {
    const ts = o.ts ?? `1700000${String(++n).padStart(3, '0')}.000100`;
    return { ts, body: { type: 'event_callback', event_id: o.event_id ?? `Ev${ts}`, event: { type: 'message', channel_type: 'im', user: o.user ?? 'U0OWNER', channel: o.channel ?? 'D-OWNER', text, ts, ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}) } } };
  };
  const mention = (text: string, o: { user?: string; thread_ts?: string } = {}) => {
    const ts = `1700100${String(++n).padStart(3, '0')}.000100`;
    return { ts, body: { type: 'event_callback', event_id: `Ev${ts}`, event: { type: 'app_mention', user: o.user ?? 'U0OWNER', channel: 'C-CHAN', text: `<@U0BOT> ${text}`, ts, ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}) } } };
  };
  const click = async (action: 'confirm' | 'dismiss', proposal: string, slackUser = 'U0OWNER') => {
    const payload = { type: 'block_actions', user: { id: slackUser }, response_url: `${slack.url}/response/click`, actions: [{ action_id: `azhi_assistant_${action}`, value: JSON.stringify({ proposal }) }] };
    const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const r = await app.inject({ method: 'POST', url: '/v1/slack/interactions', headers: { 'content-type': 'application/x-www-form-urlencoded', ...sign(raw) }, payload: raw });
    return r.statusCode;
  };
  const until = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> => {
    for (let i = 0; i < ms / 50; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out');
  };
  const inThread = (channel: string, ts: string) => slack.messages.filter((m) => m.channel === channel && m.thread_ts === ts);
  const idle = (channel: string, ts: string) => until(async () => (await ctx.pool.query(`SELECT 1 FROM slack_conversations WHERE channel=$1 AND thread_ts=$2 AND busy_until IS NULL`, [channel, ts])).rowCount === 1 || undefined);
  const stored = async (channel: string, ts: string) => (await ctx.pool.query(`SELECT messages FROM slack_conversations WHERE channel=$1 AND thread_ts=$2`, [channel, ts])).rows[0]?.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  const put = async (token: string, url: string, payload: unknown) => {
    const r = await app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
    return { status: r.statusCode, body: r.json() };
  };
  const enabled = async () => (await ctx.pool.query(`SELECT enabled FROM schedules WHERE id=$1`, [schedule])).rows[0].enabled;

  beforeAll(async () => {
    fake = await startFakeAnthropic({ script: (r) => script(r) });
    slack = await startFakeSlack();
    const dataDir = mkdtempSync(join(tmpdir(), 'azhi-slack-assistant-'));
    ctx = createContext({ databaseUrl: 'pglite://memory', dataDir, artifactDir: join(dataDir, 'artifacts'), anthropicApiUrl: fake.url, slackApiUrl: slack.url, builderProvider: undefined, builderModel: undefined });
    await migrate(ctx.pool);
    await bootstrapLocal(ctx);
    ws = (await ctx.pool.query(`SELECT id FROM workspaces LIMIT 1`)).rows[0].id;
    app = buildApi({ ctx, interpreterBuild: 'test' });
    ownerToken = (await user('owner', 'U0OWNER')).token;
    viewerToken = (await user('viewer', 'U0VIEWER')).token;
    await user('operator', 'U0OTHER');
    await setSecret(ctx, ws, 'anthropic-api-key', 'sk-test', 'test');
    await setSecret(ctx, ws, 'slack-bot-token', 'xoxb-test', 'test');
    await setSecret(ctx, ws, 'slack-signing-secret', SECRET, 'test');
    const up = await uploadPackage(ctx, ws, { workflow: 'workflow.yaml', files: { 'workflow.yaml': b64(workflow), 'profiles/summariser@1.yaml': b64(profile), 'schemas/summary.json': b64(schema) } }, 'test');
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    schedule = await upsertSchedule(ctx, ws, up.version.workflow_id, '0 9 * * 1', 'UTC', {});
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await slack?.close();
  });

  it('does nothing until the setting is on, and for a bad signature; the setting is admin only', async () => {
    // Nothing is enabled, so no workspace's secret can verify the event.
    const first = dm('hi');
    expect(await event(first.body)).toBe(401);
    expect(slack.messages).toHaveLength(0);

    const get = async (token: string) => (await app.inject({ method: 'GET', url: '/v1/settings/slack-assistant', headers: { authorization: `Bearer ${token}` } })).json();
    expect(await get(ownerToken)).toEqual({ enabled: false, provider: null, model: null });
    expect((await put(viewerToken, '/v1/settings/slack-assistant', { enabled: true })).status).toBe(403);
    expect((await put(ownerToken, '/v1/settings/slack-assistant', { enabled: 'yes' })).status).toBe(400);
    expect(await put(ownerToken, '/v1/settings/slack-assistant', { enabled: true })).toEqual({ status: 200, body: { enabled: true, provider: null, model: null } });
    expect(await get(viewerToken)).toEqual({ enabled: true, provider: null, model: null });
    expect((await ctx.pool.query(`SELECT data FROM audit_events WHERE kind='settings.slack_assistant_changed'`)).rows.at(-1).data).toEqual({ enabled: true, provider: null, model: null });

    expect(await event(first.body, { secret: 'wrong' })).toBe(401);
    expect(slack.messages).toHaveLength(0);
  });

  it('replies to a DM in its thread: a placeholder that is then updated with the answer', async () => {
    script = () => [{ text: '**Hello** from the assistant' }];
    fake.requests.length = 0;
    const m = dm('hi there', { event_id: 'Ev-first' });
    expect(await event(m.body)).toBe(200);
    await until(() => slack.updates.length >= 1 || undefined);
    await idle('D-OWNER', m.ts);
    const posted = inThread('D-OWNER', m.ts);
    expect(posted).toHaveLength(1);
    expect(slack.updates.at(-1)).toMatchObject({ channel: 'D-OWNER', ts: posted[0]!.ts, text: '*Hello* from the assistant' });
    expect(posted[0]!.text).toBe('*Hello* from the assistant');
    expect(fake.requests[0]!.system).toContain('This session is in Slack');
    expect(fake.requests[0]!.tools).toContain('list_runs');
    expect(fake.requests[0]!.tools).not.toContain('open_builder');
    const turn = (await ctx.pool.query(`SELECT actor, data FROM audit_events WHERE kind='assistant.turn' ORDER BY seq DESC LIMIT 1`)).rows[0];
    expect(turn.data).toMatchObject({ via: 'slack', event: 'text', provider: 'anthropic' });
    expect(await stored('D-OWNER', m.ts)).toHaveLength(2);

    // A second message in the thread continues the stored history.
    script = () => [{ text: 'second answer' }];
    fake.requests.length = 0;
    const again = dm('and then?', { ts: '1700000999.000100', thread_ts: m.ts });
    expect(await event(again.body)).toBe(200);
    await until(() => slack.updates.some((u) => u.text === 'second answer') || undefined);
    await idle('D-OWNER', m.ts);
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain('hi there');
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain('Hello');
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain('and then?');
    expect(await stored('D-OWNER', m.ts)).toHaveLength(4);

    // Slack resends the first event: acknowledged, nothing more happens.
    const before = { posts: slack.messages.length, calls: fake.requests.length };
    expect(await event(m.body)).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect({ posts: slack.messages.length, calls: fake.requests.length }).toEqual(before);

    // The thread belongs to its starter: another linked person is refused and the model is not called.
    const other = dm('let me in', { user: 'U0OTHER', ts: '1700000998.000100', thread_ts: m.ts });
    expect(await event(other.body)).toBe(200);
    const refusal = await until(() => inThread('D-OWNER', m.ts).find((x) => x.text.includes('belongs to someone else')));
    expect(refusal).toBeTruthy();
    expect(fake.requests).toHaveLength(before.calls);
  });

  it('refuses a Slack user who is not linked', async () => {
    fake.requests.length = 0;
    const m = dm('hello?', { user: 'U0NOBODY', channel: 'D-NOBODY' });
    expect(await event(m.body)).toBe(200);
    await until(() => inThread('D-NOBODY', m.ts).find((x) => x.text.includes('not linked')));
    expect(fake.requests).toHaveLength(0);
    expect((await ctx.pool.query(`SELECT 1 FROM slack_conversations WHERE channel='D-NOBODY'`)).rowCount).toBe(0);
  });

  it('says so when the thread is still busy with the last message', async () => {
    const m = dm('first', { channel: 'D-BUSY' });
    await event(m.body);
    await idle('D-BUSY', m.ts);
    await ctx.pool.query(`UPDATE slack_conversations SET busy_until = now() + interval '5 minutes' WHERE channel='D-BUSY'`);
    fake.requests.length = 0;
    await event(dm('second', { channel: 'D-BUSY', thread_ts: m.ts, ts: '1700000997.000100' }).body);
    await until(() => inThread('D-BUSY', m.ts).find((x) => x.text.includes('Still working')));
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps `@azhi run` on the run path and sends other mentions to the assistant', async () => {
    // Slack commands on, no workflow allowed: a run mention is answered by the run path (no model call).
    await put(ownerToken, '/v1/settings/slack-commands', { enabled: true, workflows: [], channel: null });
    fake.requests.length = 0;
    const run = mention('run standup-summary');
    expect(await event(run.body)).toBe(200);
    const note = await until(() => inThread('C-CHAN', run.ts).find((x) => x.text.includes('cannot be started from Slack')));
    expect(note).toBeTruthy();
    expect(fake.requests).toHaveLength(0);

    script = () => [{ text: 'Nothing failed today.' }];
    const q = mention('what failed today?');
    expect(await event(q.body)).toBe(200);
    await until(() => slack.updates.some((u) => u.text === 'Nothing failed today.') || undefined);
    expect(fake.requests).toHaveLength(1);
    expect(inThread('C-CHAN', q.ts)[0]!.text).toBe('Nothing failed today.');
    // The mention is stripped: the model sees the question only.
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain('what failed today?');
    expect(JSON.stringify(fake.requests[0]!.messages)).not.toContain('U0BOT');
  });

  it('runs a confirmed card once with the stored arguments, and Dismiss tells the model it did not run', async () => {
    script = () => [{ tool: 'set_schedule_enabled', input: { schedule_id: schedule, enabled: false } }, { text: 'Press Confirm to pause it.' }];
    const m = dm('pause the standup schedule', { channel: 'D-ACT' });
    expect(await event(m.body)).toBe(200);
    const hasCard = (x: { blocks?: unknown }) => Array.isArray(x.blocks) && x.blocks.some((b: { type?: string }) => b.type === 'actions');
    const card = await until(() => inThread('D-ACT', m.ts).find(hasCard));
    await idle('D-ACT', m.ts);
    const buttons = ((card.blocks as any[]).find((b) => b.type === 'actions') as { elements: Array<{ action_id: string; value: string; style?: string; confirm?: unknown }> }).elements;
    expect(buttons.map((b) => b.action_id)).toEqual(['azhi_assistant_confirm', 'azhi_assistant_dismiss']);
    // The schedule pause is a danger action: Slack asks again before it is sent.
    expect(buttons[0]).toMatchObject({ style: 'danger', confirm: expect.anything() });
    const proposal = JSON.parse(buttons[0]!.value).proposal as string;
    expect(Object.keys(JSON.parse(buttons[0]!.value))).toEqual(['proposal']);
    expect((await ctx.pool.query(`SELECT args, status FROM slack_assistant_proposals WHERE id=$1`, [proposal])).rows[0]).toMatchObject({ args: { schedule_id: schedule, enabled: false }, status: 'pending' });
    expect(await enabled()).toBe(true);

    // Not the owner: refused, nothing runs, and the card stays pending.
    expect(await click('confirm', proposal, 'U0OTHER')).toBe(200);
    await until(() => slack.responses.find((r) => String(r.text).includes('Only the person who started')));
    expect(await enabled()).toBe(true);
    // A bad signature is refused.
    const bad = await app.inject({ method: 'POST', url: '/v1/slack/interactions', headers: { 'content-type': 'application/x-www-form-urlencoded', ...sign('x', 'wrong') }, payload: new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', actions: [{ action_id: 'azhi_assistant_confirm', value: JSON.stringify({ proposal }) }] }) }).toString() });
    expect(bad.statusCode).toBe(401);

    const actions = async () => (await ctx.pool.query(`SELECT data FROM audit_events WHERE kind='assistant.action'`)).rows.length;
    const before = await actions();
    const seen = slack.responses.length;
    expect(await click('confirm', proposal)).toBe(200);
    await until(async () => (await enabled()) === false || undefined);
    await until(() => slack.responses.slice(seen).find((r) => r.replace_original === true));
    expect(slack.responses.slice(seen).find((r) => r.replace_original === true)!.text).toContain('Confirmed');
    expect((await ctx.pool.query(`SELECT data FROM audit_events WHERE kind='assistant.action' ORDER BY seq DESC LIMIT 1`)).rows[0].data).toMatchObject({ tool: 'set_schedule_enabled', via: 'slack', args: { schedule_id: schedule, enabled: false } });
    expect((await stored('D-ACT', m.ts)).at(-1)!.content.at(-1)!.text).toMatch(/^\(I confirmed "Pause the standup-summary schedule"\. Result: /);

    // A second click does nothing more.
    const again = slack.responses.length;
    expect(await click('confirm', proposal)).toBe(200);
    await until(() => slack.responses.length > again || undefined);
    expect(slack.responses.at(-1)!.text).toContain('already decided');
    expect(await actions()).toBe(before + 1);

    // Dismiss: the card is replaced, the action never runs, and the model is told next turn.
    // The thread already holds assistant messages, so the script picks its step from the last message instead of the turn count.
    script = (r) => (JSON.stringify(r.messages.at(-1)).includes('tool_result') ? [{ text: 'Press Confirm to resume it.' }] : [{ tool: 'set_schedule_enabled', input: { schedule_id: schedule, enabled: true } }]);
    await event(dm('resume it', { channel: 'D-ACT', thread_ts: m.ts, ts: '1700000996.000100' }).body);
    await until(() => inThread('D-ACT', m.ts).filter(hasCard).length >= 2 || undefined);
    await idle('D-ACT', m.ts);
    const second = (await ctx.pool.query(`SELECT id FROM slack_assistant_proposals WHERE status='pending'`)).rows[0].id as string;
    expect(await click('dismiss', second)).toBe(200);
    await until(async () => (await ctx.pool.query(`SELECT 1 FROM slack_assistant_proposals WHERE id=$1 AND status='dismissed'`, [second])).rowCount === 1 || undefined);
    await until(async () => JSON.stringify(await stored('D-ACT', m.ts)).includes('I dismissed') || undefined);
    expect(await enabled()).toBe(false);
    expect(await actions()).toBe(before + 1);
    expect((await stored('D-ACT', m.ts)).at(-1)!.content.at(-1)!.text).toBe('(I dismissed "Resume the standup-summary schedule"; it did not run.)');
  });

  it('saves the model Slack chat uses: omitted keeps it, null clears it, a model needs a provider', async () => {
    const url = '/v1/settings/slack-assistant';
    const get = async () => (await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${ownerToken}` } })).json();
    expect((await put(ownerToken, url, { enabled: true, model: 'claude-x' })).status).toBe(400);
    expect((await put(ownerToken, url, { enabled: true, provider: 'nope' })).status).toBe(400);
    expect((await put(ownerToken, url, { enabled: true, provider: 'anthropic', model: 'bad model!' })).status).toBe(400);
    expect((await put(viewerToken, url, { enabled: true, provider: 'anthropic' })).status).toBe(403);
    expect(await put(ownerToken, url, { enabled: true, provider: 'anthropic', model: 'claude-pick-1' })).toEqual({ status: 200, body: { enabled: true, provider: 'anthropic', model: 'claude-pick-1' } });
    expect((await ctx.pool.query(`SELECT data FROM audit_events WHERE kind='settings.slack_assistant_changed'`)).rows.at(-1).data).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-pick-1' });
    // An older client that sends only `enabled` keeps the saved choice.
    await put(ownerToken, url, { enabled: true });
    expect(await get()).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-pick-1' });
    // A provider without a model means that provider's default.
    await put(ownerToken, url, { enabled: true, provider: 'openai' });
    expect(await get()).toEqual({ enabled: true, provider: 'openai', model: null });
    await put(ownerToken, url, { enabled: true, provider: 'anthropic', model: 'claude-pick-1' });
    await put(ownerToken, url, { enabled: true, provider: null, model: null });
    expect(await get()).toEqual({ enabled: true, provider: null, model: null });
  });

  it('answers with the configured model, and says so in the thread when its provider is not ready', async () => {
    await put(ownerToken, '/v1/settings/slack-assistant', { enabled: true, provider: 'anthropic', model: 'claude-pick-1' });
    script = () => [{ text: 'chosen model answer' }];
    fake.requests.length = 0;
    const m = dm('which model?', { channel: 'D-MODEL' });
    expect(await event(m.body)).toBe(200);
    await until(() => slack.updates.some((u) => u.text === 'chosen model answer') || undefined);
    await idle('D-MODEL', m.ts);
    expect(fake.requests[0]!.model).toBe('claude-pick-1');
    expect((await ctx.pool.query(`SELECT data FROM audit_events WHERE kind='assistant.turn' ORDER BY seq DESC LIMIT 1`)).rows[0].data).toMatchObject({ provider: 'anthropic', model: 'claude-pick-1' });

    // OpenAI has no key here: no fallback to the default, the person gets the error and a hint.
    await put(ownerToken, '/v1/settings/slack-assistant', { enabled: true, provider: 'openai' });
    fake.requests.length = 0;
    const f = dm('and now?', { channel: 'D-MODEL2' });
    expect(await event(f.body)).toBe(200);
    const note = await until(() => slack.updates.find((u) => u.ts === inThread('D-MODEL2', f.ts)[0]?.ts && u.text.includes('could not answer')));
    expect(note.text).toContain('The default model set under System, Slack may need attention.');
    expect(fake.requests).toHaveLength(0);
    await idle('D-MODEL2', f.ts);
    await put(ownerToken, '/v1/settings/slack-assistant', { enabled: true, provider: null, model: null });
  });

  it('replaces the placeholder with a short note and audits when the turn fails', async () => {
    const failed = async () => (await ctx.pool.query(`SELECT 1 FROM audit_events WHERE kind='assistant.slack_failed'`)).rowCount;
    const before = await failed();
    await ctx.pool.query(`DELETE FROM secrets WHERE workspace_id=$1 AND name='anthropic-api-key'`, [ws]);
    const m = dm('will this work?', { channel: 'D-FAIL' });
    expect(await event(m.body)).toBe(200);
    await until(() => slack.updates.find((u) => u.ts === inThread('D-FAIL', m.ts)[0]?.ts && u.text.includes('could not answer')));
    await idle('D-FAIL', m.ts);
    expect(await failed()).toBe(before! + 1);
    await setSecret(ctx, ws, 'anthropic-api-key', 'sk-test', 'test');
  });

  it('forgets seen event ids after a day', async () => {
    const { startSlackRunNotifier } = await import('../src/server/slack-runs.js');
    await ctx.pool.query(`UPDATE slack_events SET received_at = now() - interval '2 days' WHERE event_id='Ev-first'`);
    const notifier = startSlackRunNotifier(ctx, () => {}, 3_600_000);
    await until(async () => (await ctx.pool.query(`SELECT 1 FROM slack_events WHERE event_id='Ev-first'`)).rowCount === 0 || undefined);
    notifier.stop();
    expect((await ctx.pool.query(`SELECT 1 FROM slack_events WHERE event_id='Ev-first'`)).rowCount).toBe(0);
    expect((await ctx.pool.query(`SELECT 1 FROM slack_events`)).rowCount).toBeGreaterThan(0);
  });

  it('tells a mention it is off when the assistant is disabled', async () => {
    await put(ownerToken, '/v1/settings/slack-assistant', { enabled: false });
    await put(ownerToken, '/v1/settings/slack-commands', { enabled: true, workflows: [], channel: null });
    fake.requests.length = 0;
    const q = mention('what failed today?');
    expect(await event(q.body)).toBe(200);
    const hint = await until(() => inThread('C-CHAN', q.ts).find((x) => x.text.includes('The assistant is turned off for Slack')));
    expect(hint!.text).toContain('@azhi run <workflow>');
    await new Promise((r) => setTimeout(r, 200));
    expect(inThread('C-CHAN', q.ts)).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
    // Slack resends the event: acknowledged, no second hint.
    expect(await event(q.body)).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(inThread('C-CHAN', q.ts)).toHaveLength(1);
    await put(ownerToken, '/v1/settings/slack-assistant', { enabled: true });
  });
});
