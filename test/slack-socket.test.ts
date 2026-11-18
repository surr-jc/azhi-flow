import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../src/api/app.js';
import { bootstrapLocal } from '../src/api/auth.js';
import { migrate } from '../src/db/migrate.js';
import { newId } from '../src/lib/ids.js';
import { createContext, type AppContext } from '../src/server/context.js';
import { setSecret } from '../src/server/secrets.js';
import { startSlackSocketMode, type SocketLike } from '../src/server/slack-socket.js';
import { uploadPackage, upsertSchedule } from '../src/server/workflows.js';
import { startFakeAnthropic, type FakeRequest, type FakeStep } from '../src/testing/fake-anthropic.js';
import { startFakeSlack } from '../src/testing/fake-slack.js';

/**
 * Socket Mode: envelopes arrive over a websocket (a fake one here), are acknowledged first, and are then handed to
 * the same signed routes the webhook uses. Runs in-process on PGlite with a scripted model and the fake Slack API.
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

class FakeSocket implements SocketLike {
  sent: any[] = [];
  closed = false;
  private listeners = new Map<string, Array<(ev: any) => void>>();
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, ev: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  /** Slack sends an envelope. */
  push(env: unknown) {
    this.emit('message', { data: JSON.stringify(env) });
  }
  ack(id: string) {
    return this.sent.find((m) => m.envelope_id === id);
  }
}

describe('Slack Socket Mode', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof buildApi>;
  let fake: Awaited<ReturnType<typeof startFakeAnthropic>>;
  let slack: Awaited<ReturnType<typeof startFakeSlack>>;
  let ws: string;
  let schedule: string;
  let stop: () => void = () => {};
  let script: (req: FakeRequest) => FakeStep[] = () => [{ text: 'hello over the socket' }];
  const sockets: FakeSocket[] = [];
  let n = 0;

  const until = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> => {
    for (let i = 0; i < ms / 25; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out');
  };
  const dm = (text: string, channel = 'D-SOCK') => {
    const ts = `1700200${String(++n).padStart(3, '0')}.000100`;
    return { ts, payload: { type: 'event_callback', event_id: `EvSock${ts}`, event: { type: 'message', channel_type: 'im', user: 'U0OWNER', channel, text, ts } } };
  };
  const idle = (channel: string, ts: string) => until(async () => (await ctx.pool.query(`SELECT 1 FROM slack_conversations WHERE channel=$1 AND thread_ts=$2 AND busy_until IS NULL`, [channel, ts])).rowCount === 1 || undefined);

  beforeAll(async () => {
    fake = await startFakeAnthropic({ script: (r) => script(r) });
    slack = await startFakeSlack();
    const dataDir = mkdtempSync(join(tmpdir(), 'azhi-slack-socket-'));
    ctx = createContext({ databaseUrl: 'pglite://memory', dataDir, artifactDir: join(dataDir, 'artifacts'), anthropicApiUrl: fake.url, slackApiUrl: slack.url, builderProvider: undefined, builderModel: undefined });
    await migrate(ctx.pool);
    await bootstrapLocal(ctx);
    ws = (await ctx.pool.query(`SELECT id FROM workspaces LIMIT 1`)).rows[0].id;
    app = buildApi({ ctx, interpreterBuild: 'test' });
    await ctx.pool.query(`INSERT INTO users(id, workspace_id, display_name, role, slack_user_id) VALUES ($1,$2,'owner','owner','U0OWNER')`, [newId('usr'), ws]);
    await setSecret(ctx, ws, 'anthropic-api-key', 'sk-test', 'test');
    await setSecret(ctx, ws, 'slack-bot-token', 'xoxb-test', 'test');
    await setSecret(ctx, ws, 'slack-signing-secret', 'shh-socket', 'test');
    await ctx.pool.query(`UPDATE workspaces SET settings = jsonb_set(jsonb_set(settings, '{slack_assistant}', '{"enabled":true}'), '{slack_commands}', '{"enabled":true,"workflows":[]}') WHERE id=$1`, [ws]);
    const up = await uploadPackage(ctx, ws, { workflow: 'workflow.yaml', files: { 'workflow.yaml': b64(workflow), 'profiles/summariser@1.yaml': b64(profile), 'schemas/summary.json': b64(schema) } }, 'test');
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    schedule = await upsertSchedule(ctx, ws, up.version.workflow_id, '0 9 * * 1', 'UTC', {});
    stop = startSlackSocketMode(ctx, app, () => {}, { connect: (url) => sockets[sockets.push(new FakeSocket(url)) - 1]!, scanMs: 100, backoffMs: { min: 20, max: 100 } });
  }, 120_000);
  afterAll(async () => {
    stop();
    await app?.close();
    await fake?.close();
    await slack?.close();
  });

  it('skips a workspace without the app token, then connects once the token is set', async () => {
    await new Promise((r) => setTimeout(r, 400));
    expect(sockets).toHaveLength(0);
    await setSecret(ctx, ws, 'slack-app-token', 'xapp-test', 'test');
    await until(() => sockets[0]);
    expect(sockets[0]!.url).toBe('wss://fake-slack.test/link');
    sockets[0]!.emit('open', {});
    sockets[0]!.push({ type: 'hello' });
    // One connection per workspace, however many scans pass.
    await new Promise((r) => setTimeout(r, 300));
    expect(sockets).toHaveLength(1);
  });

  it('acknowledges a DM before the turn completes, then posts the reply', async () => {
    script = () => [{ text: 'hello over the socket' }];
    const m = dm('hi over the socket');
    const sock = sockets[0]!;
    sock.push({ envelope_id: 'e-dm', type: 'events_api', accepts_response_payload: false, payload: m.payload });
    expect(sock.ack('e-dm')).toEqual({ envelope_id: 'e-dm' });
    expect(slack.updates).toHaveLength(0);
    await until(() => slack.updates.find((u) => u.text === 'hello over the socket'));
    await idle('D-SOCK', m.ts);
    expect(slack.messages.filter((x) => x.channel === 'D-SOCK' && x.thread_ts === m.ts)).toHaveLength(1);
    // Slack redelivers an envelope it did not see acknowledged: acknowledged again, the event is not handled twice.
    const before = slack.messages.length;
    sock.push({ envelope_id: 'e-dm-2', type: 'events_api', retry_attempt: 1, payload: m.payload });
    expect(sock.ack('e-dm-2')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(slack.messages.length).toBe(before);
  });

  it('acknowledges a slash command with the ephemeral text', async () => {
    const sock = sockets[0]!;
    sock.push({ envelope_id: 'e-cmd', type: 'slash_commands', accepts_response_payload: true, payload: { command: '/azhi', text: 'run standup-summary', user_id: 'U0OWNER', channel_id: 'C-CHAN', response_url: `${slack.url}/response/cmd` } });
    const ack = await until(() => sock.ack('e-cmd'));
    expect(ack).toEqual({ envelope_id: 'e-cmd', payload: { response_type: 'ephemeral', text: 'Starting your run…' } });
    // Nothing is allowlisted, so the command is refused privately through the response url.
    await until(() => slack.responses.find((r) => String(r.text).includes('cannot be started from Slack')));
  });

  it('passes a Confirm press on an assistant card through', async () => {
    script = () => [{ tool: 'set_schedule_enabled', input: { schedule_id: schedule, enabled: false } }, { text: 'Press Confirm to pause it.' }];
    const m = dm('pause the standup schedule', 'D-ACT');
    const sock = sockets[0]!;
    sock.push({ envelope_id: 'e-act', type: 'events_api', payload: m.payload });
    await until(() => slack.messages.find((x) => x.channel === 'D-ACT' && Array.isArray(x.blocks) && x.blocks.some((b: { type?: string }) => b.type === 'actions')));
    await idle('D-ACT', m.ts);
    const proposal = (await ctx.pool.query(`SELECT id FROM slack_assistant_proposals WHERE status='pending'`)).rows[0].id as string;
    const payload = { type: 'block_actions', user: { id: 'U0OWNER' }, response_url: `${slack.url}/response/click`, actions: [{ action_id: 'azhi_assistant_confirm', value: JSON.stringify({ proposal }) }] };
    sock.push({ envelope_id: 'e-click', type: 'interactive', payload });
    expect(sock.ack('e-click')).toEqual({ envelope_id: 'e-click' });
    await until(async () => (await ctx.pool.query(`SELECT enabled FROM schedules WHERE id=$1`, [schedule])).rows[0].enabled === false || undefined);
    expect((await ctx.pool.query(`SELECT 1 FROM audit_events WHERE kind='assistant.action'`)).rowCount).toBe(1);
  });

  it('reconnects with a fresh url when Slack sends disconnect, and after a plain close', async () => {
    const first = sockets[0]!;
    first.push({ type: 'disconnect', reason: 'refresh_requested' });
    expect(first.closed).toBe(true);
    await until(() => sockets[1]);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit('open', {});
    sockets[1]!.close();
    await until(() => sockets[2]);
  });

  it('drops a workspace that no longer qualifies, and stop() closes the socket and stops reconnecting', async () => {
    const live = sockets.at(-1)!;
    await ctx.pool.query(`UPDATE workspaces SET settings = jsonb_set(jsonb_set(settings, '{slack_assistant}', '{"enabled":false}'), '{slack_commands}', '{"enabled":false}') WHERE id=$1`, [ws]);
    await until(() => live.closed || undefined);
    const count = sockets.length;
    await ctx.pool.query(`UPDATE workspaces SET settings = jsonb_set(settings, '{slack_assistant}', '{"enabled":true}') WHERE id=$1`, [ws]);
    await until(() => sockets.length > count);
    const again = sockets.at(-1)!;
    stop();
    expect(again.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(sockets.length).toBe(count + 1);
  });
});
