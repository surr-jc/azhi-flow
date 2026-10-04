/**
 * Crash suite (alpha check 4): the process running the Slack post is killed at each ledger state
 * (after planned, after dispatched but before the send, after the send but before the receipt).
 * A fresh gateway process recovers every time, Slack ends up with exactly one message, and the
 * ledger's transitions say how.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type ServerHandle } from '../src/server/server.js';
import { startFakeSlack } from '../src/testing/fake-slack.js';
import { ApiClient } from '../src/worker/api-client.js';
import { startWorker } from '../src/worker/worker.js';
import { freshDatabase, PGLITE, TEMPORAL, temporalAvailable, uploadDir, waitForRun } from './helpers/harness.js';

const up = await temporalAvailable();

const CASES = [
  { point: 'ledger.planned', sentBeforeCrash: false, transitions: ['planned', 'dispatched', 'confirmed'] },
  { point: 'ledger.dispatched', sentBeforeCrash: false, transitions: ['planned', 'dispatched', 'outcome_unknown', 'dispatched', 'confirmed'] },
  { point: 'ledger.sent', sentBeforeCrash: true, transitions: ['planned', 'dispatched', 'outcome_unknown', 'confirmed'] },
];

// A second server process shares the database, which an embedded (PGlite) database cannot do.
describe.skipIf(!up || PGLITE)('crash suite: kill the gateway at every ledger state', () => {
  let server: ServerHandle;
  let api: ApiClient;
  let slack: Awaited<ReturnType<typeof startFakeSlack>>;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  let env: NodeJS.ProcessEnv;
  const children: ChildProcess[] = [];
  let version: string;

  const gateway = (fault?: string) => {
    const c = spawn(process.execPath, ['bin/azhi.js', 'server', 'start', '--roles', 'gateway'], { env: { ...env, ...(fault ? { AZHI_FAULT: fault } : {}) }, stdio: 'ignore' });
    children.push(c);
    return c;
  };

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'azhi-crash-'));
    slack = await startFakeSlack();
    const databaseUrl = await freshDatabase();
    const build = `crash${Date.now().toString(36)}`;
    const gatewayQueue = `azhi-gateway-${build}`;
    env = { ...process.env, AZHI_DATABASE_URL: databaseUrl, AZHI_DATA_DIR: dataDir, AZHI_SLACK_API_URL: slack.url, AZHI_TEMPORAL_ADDRESS: TEMPORAL, AZHI_PORT: '0', AZHI_GATEWAY_QUEUE: gatewayQueue };
    server = await startServer({
      roles: ['api', 'interpreter', 'scheduler'],
      log: () => {},
      settings: { databaseUrl, dataDir, artifactDir: join(dataDir, 'artifacts'), temporalAddress: TEMPORAL, port: 0, slackApiUrl: slack.url, interpreterBuild: build, gatewayQueue },
    });
    const token = readFileSync(server.localTokenFile!, 'utf8').trim();
    api = new ApiClient(server.url, token);
    worker = await startWorker({ apiUrl: server.url, token, temporalAddress: TEMPORAL, dataDir: join(dataDir, 'worker'), log: () => {} });
    await api.put('/v1/secrets/slack-bot-token', { value: 'xoxb-test' });
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await api.post('/v1/tools', t);
    version = (await uploadDir(api, 'examples/ci-digest')).version.id;
  });

  afterAll(async () => {
    for (const c of children) c.kill('SIGKILL');
    await worker?.stop();
    await server?.stop();
    await slack?.close();
  });

  for (const c of CASES) {
    it(`recovers after a kill at ${c.point} with exactly one message`, async () => {
      const team = c.point.replace('ledger.', 'team-');
      const crashing = gateway(c.point);
      const exited = new Promise<NodeJS.Signals | null>((r) => crashing.on('exit', (_code, signal) => r(signal)));
      const { run_id } = await api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team } });
      expect(await exited).toBe('SIGKILL');

      const mine = () => slack.messages.filter((m) => m.text.includes(team));
      expect(mine()).toHaveLength(c.sentBeforeCrash ? 1 : 0);
      const fresh = gateway();
      const d = await waitForRun(api, run_id, 120_000);
      fresh.kill('SIGTERM');
      await new Promise((r) => fresh.on('exit', r));

      expect(d.run.state).toBe('succeeded');
      expect(mine()).toHaveLength(1);
      expect(d.actions).toHaveLength(1);
      expect(d.actions[0].state).toBe('confirmed');
      expect(d.actions[0].transitions.map((t: any) => t.state)).toEqual(c.transitions);
    });
  }
});
