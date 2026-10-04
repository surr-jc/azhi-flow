import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { packageFromDirectory } from '../../src/definition/package.js';
import { loadDefinitionText } from '../../src/definition/load.js';
import { signForUpload } from '../../src/cli/signing-client.js';
import { startServer, type ServerHandle, type ServerRole } from '../../src/server/server.js';
import { startFakeSlack } from '../../src/testing/fake-slack.js';
import { ApiClient } from '../../src/worker/api-client.js';
import { startWorker } from '../../src/worker/worker.js';

export const ADMIN_DB_URL = process.env.AZHI_TEST_DATABASE_URL ?? 'postgres://azhi:azhi@localhost:5433/azhi';
export const TEMPORAL = process.env.AZHI_TEMPORAL_ADDRESS ?? 'localhost:7233';

export async function temporalAvailable(): Promise<boolean> {
  const [host, port] = TEMPORAL.split(':');
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.connect({ host, port: Number(port) }, () => (s.end(), resolve(true)));
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

/** A fresh database per test file. */
export async function freshDatabase(): Promise<string> {
  const name = `azhi_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_DB_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface Harness {
  server: ServerHandle;
  api: ApiClient;
  slack: Awaited<ReturnType<typeof startFakeSlack>>;
  worker?: Awaited<ReturnType<typeof startWorker>>;
  dataDir: string;
  stop(): Promise<void>;
}

export async function startHarness(opts: { worker?: boolean; roles?: ServerRole[]; build?: string } = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'azhi-test-'));
  const slack = await startFakeSlack();
  const server = await startServer({
    roles: opts.roles,
    log: () => {},
    settings: {
      databaseUrl: await freshDatabase(),
      temporalAddress: TEMPORAL,
      dataDir,
      artifactDir: join(dataDir, 'artifacts'),
      port: 0,
      slackApiUrl: slack.url,
      authMode: 'local',
      interpreterBuild: opts.build ?? `test${Date.now().toString(36)}`,
      gatewayQueue: `azhi-gateway-${dataDir.slice(-8)}`,
    },
  });
  const token = readFileSync(server.localTokenFile!, 'utf8').trim();
  const api = new ApiClient(server.url, token);
  await api.put('/v1/secrets/slack-bot-token', { value: 'xoxb-test' });
  const worker = opts.worker === false ? undefined : await startWorker({ apiUrl: server.url, token, temporalAddress: TEMPORAL, dataDir: join(dataDir, 'worker'), log: () => {} });
  return {
    server,
    api,
    slack,
    worker,
    dataDir,
    async stop() {
      await worker?.stop();
      await server.stop();
      await slack.close();
    },
  };
}

export async function uploadDir(api: ApiClient, dir: string, opts: { sign?: boolean; keyDir?: string } = {}) {
  const pkg = packageFromDirectory(dir);
  const files: Record<string, string> = {};
  for (const f of pkg.manifest.files) files[f.path] = pkg.read(f.path)!.toString('base64');
  const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;
  const signature = opts.sign === false ? undefined : await signForUpload(api, pkg, def.id, opts.keyDir ?? keyDirFor(api));
  return api.post<{ ok: boolean; diagnostics: any[]; version: { id: string; workflow: string; version: number; package_hash: string; signed: boolean } }>('/v1/packages', {
    workflow: pkg.manifest.workflow,
    files,
    signature,
  });
}

const keyDirs = new Map<string, string>();
/** Test publisher keys live in a temp dir per API client, never in the real home directory. */
export function keyDirFor(api: ApiClient): string {
  const k = api.baseUrl;
  if (!keyDirs.has(k)) keyDirs.set(k, mkdtempSync(join(tmpdir(), 'azhi-keys-')));
  return keyDirs.get(k)!;
}

export async function waitForRun(api: ApiClient, runId: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const d = await api.get<any>(`/v1/runs/${runId}`);
    if (['succeeded', 'delivery_failed', 'failed', 'cancelled', 'expired'].includes(d.run.state)) return d;
    if (Date.now() > end) throw new Error(`run ${runId} still ${d.run.state} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
