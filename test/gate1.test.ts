/**
 * Gate 1 (implementation plan): a tool -> script -> notify workflow runs on a schedule from a
 * fresh install; killing the process executing the notify, after Slack accepted the message but
 * before the receipt was recorded, produces exactly one message; the ledger shows how.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type ServerHandle } from '../src/server/server.js';
import { startFakeSlack } from '../src/testing/fake-slack.js';
import { ApiClient } from '../src/worker/api-client.js';
import { startWorker } from '../src/worker/worker.js';
import { freshDatabase, PGLITE, TEMPORAL, temporalAvailable, uploadDir, waitForRun } from './helpers/harness.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const up = await temporalAvailable();

// A second server process shares the database, which an embedded (PGlite) database cannot do.
describe.skipIf(!up || PGLITE)('Gate 1: scheduled run survives a crash during the Slack post', () => {
  let server: ServerHandle;
  let api: ApiClient;
  let slack: Awaited<ReturnType<typeof startFakeSlack>>;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  let gateway: ChildProcess | undefined;
  let env: NodeJS.ProcessEnv;

  const startGateway = () => {
    gateway = spawn(process.execPath, ['bin/azhi.js', 'server', 'start', '--roles', 'gateway'], { env, stdio: 'ignore' });
    return gateway;
  };

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'azhi-gate1-'));
    slack = await startFakeSlack(0, { postDelayMs: 3000 });
    const databaseUrl = await freshDatabase();
    const build = `gate1${Date.now().toString(36)}`;
    env = { ...process.env, AZHI_DATABASE_URL: databaseUrl, AZHI_DATA_DIR: dataDir, AZHI_SLACK_API_URL: slack.url, AZHI_TEMPORAL_ADDRESS: TEMPORAL, AZHI_PORT: '0', AZHI_GATEWAY_QUEUE: `azhi-gateway-${build}` };
    // API, interpreter and scheduler in this process; gateway activities in a child we can kill.
    server = await startServer({
      roles: ['api', 'interpreter', 'scheduler'],
      log: () => {},
      settings: { databaseUrl, dataDir, artifactDir: join(dataDir, 'artifacts'), temporalAddress: TEMPORAL, port: 0, slackApiUrl: slack.url, interpreterBuild: build, gatewayQueue: `azhi-gateway-${build}` },
    });
    const token = readFileSync(server.localTokenFile!, 'utf8').trim();
    api = new ApiClient(server.url, token);
    worker = await startWorker({ apiUrl: server.url, token, temporalAddress: TEMPORAL, dataDir: join(dataDir, 'worker'), log: () => {} });
    startGateway();
    await api.put('/v1/secrets/slack-bot-token', { value: 'xoxb-test' });
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await api.post('/v1/tools', t);
  });

  afterAll(async () => {
    gateway?.kill('SIGKILL');
    await worker?.stop();
    await server?.stop();
    await slack?.close();
  });

  it('runs from the schedule, recovers after SIGKILL mid-post, and posts exactly once', async () => {
    const v = await uploadDir(api, 'examples/ci-digest');
    await api.post(`/v1/versions/${v.version.id}/publish`, {});
    const sched = await api.post<{ id: string }>('/v1/schedules', { workflow: 'ci-digest', cron: '* * * * *', timezone: 'Asia/Kolkata', inputs: { team: 'payments' } });
    // Bring the next occurrence forward instead of waiting up to a minute for the cron boundary.
    await server.ctx.pool.query(`UPDATE schedules SET next_occurrence_at = date_trunc('second', now()) WHERE id=$1`, [sched.id]);
    await server.scheduler!.tick();

    const runId = (await server.ctx.pool.query(`SELECT id FROM runs WHERE trigger='schedule' ORDER BY created_at DESC LIMIT 1`)).rows[0]?.id as string;
    expect(runId).toBeTruthy();

    // Wait until Slack has the message but has not answered yet, then kill the gateway process.
    for (let i = 0; i < 300 && slack.messages.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(slack.messages).toHaveLength(1);
    gateway!.kill('SIGKILL');
    slack.state.postDelayMs = 0;
    startGateway();

    const d = await waitForRun(api, runId, 120_000);
    expect(d.run.state).toBe('succeeded');
    expect(d.run.trigger).toBe('schedule');
    expect(slack.messages).toHaveLength(1);
    const action = d.actions[0];
    expect(action.state).toBe('confirmed');
    expect(action.transitions.map((t: any) => t.state)).toEqual(['planned', 'dispatched', 'outcome_unknown', 'confirmed']);
    expect(action.transitions.at(-1).note).toMatch(/reconciled/);

    // The same occurrence can never start a second run.
    await server.ctx.pool.query(`UPDATE schedules SET next_occurrence_at = $2 WHERE id=$1`, [sched.id, new Date(d.run.snapshot.reference_time)]);
    await server.scheduler!.tick();
    const count = (await server.ctx.pool.query(`SELECT count(*)::int AS n FROM runs WHERE occurrence_id=$1`, [d.run.occurrence_id])).rows[0].n;
    expect(count).toBe(1);
  }, 180_000);
});
