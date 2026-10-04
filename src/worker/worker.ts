import { NativeConnection, Worker } from '@temporalio/worker';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { TASK_QUEUES } from '../config/settings.js';
import { installTemporalRuntime } from '../runtime/interpreter.js';
import { newId } from '../lib/ids.js';
import { ApiClient } from './api-client.js';
import { detectCapabilities } from './capabilities.js';
import { scriptActivities, type ScriptWorkerOptions } from './script-activity.js';
import { ApplicationFailure } from '@temporalio/common';
import { ErrorClass } from '../lib/errors.js';
import { trustAccepts, verifyPackageSignature, type PackageSignature, type TrustPolicy } from '../security/signing.js';

export interface WorkerOptions {
  apiUrl: string;
  token: string;
  temporalAddress: string;
  namespace?: string;
  name?: string;
  dataDir?: string;
  trustPolicy?: Record<string, unknown>;
  verifyPackage?: ScriptWorkerOptions['verifyPackage'];
  log?: (m: string) => void;
}

/**
 * An execution worker (`azhi worker start`): runs script nodes on this Linux host, advertises its
 * capabilities and trust policy to the server, and heartbeats so runs can report
 * `worker_offline` honestly.
 */
export async function startWorker(o: WorkerOptions) {
  const log = o.log ?? ((m: string) => console.log(`[worker] ${m}`));
  const dataDir = o.dataDir ?? join(homedir(), '.azhi', 'worker');
  mkdirSync(dataDir, { recursive: true });
  const idFile = join(dataDir, 'worker-id');
  const workerId = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : newId('wkr');
  writeFileSync(idFile, workerId);

  const api = new ApiClient(o.apiUrl, o.token);
  const me = await api.get<{ userId: string; workspaceId: string }>('/v1/me');
  const trustPolicy: TrustPolicy = (o.trustPolicy as TrustPolicy | undefined) ?? { kind: 'self' };
  // Pin the workspace root key on first contact; a changed root key is refused.
  const rootFile = join(dataDir, `trust-root-${me.workspaceId}.pub`);
  const served = (await api.get<{ public_key: string }>('/v1/trust/root')).public_key;
  if (existsSync(rootFile) && readFileSync(rootFile, 'utf8').trim() !== served) {
    throw new Error(`workspace root key changed since this worker pinned it (${rootFile}); refusing to start`);
  }
  writeFileSync(rootFile, served);
  const verifyPackage: ScriptWorkerOptions['verifyPackage'] =
    o.verifyPackage ??
    (async (_manifest, packageHash) => {
      const { signature } = await api.get<{ signature: PackageSignature | null }>(`/v1/packages/${encodeURIComponent(packageHash)}/signature`);
      const check = verifyPackageSignature(signature, packageHash, served);
      if (!check.ok) throw ApplicationFailure.create({ type: ErrorClass.workerTrustDenied, message: `worker refuses package: ${check.reason}`, nonRetryable: true });
      let isPublisher = false;
      if (trustPolicy.kind === 'workspace-publishers') {
        const users = await api.get<Array<{ id: string; role: string }>>('/v1/users');
        isPublisher = ['author', 'admin', 'owner'].includes(users.find((u) => u.id === check.publisher)?.role ?? '');
      }
      const t = trustAccepts(trustPolicy, check.publisher, { workerOwner: me.userId, publisherIsPublisherRole: isPublisher });
      if (!t.ok) throw ApplicationFailure.create({ type: ErrorClass.workerTrustDenied, message: `worker refuses package: ${t.reason}`, nonRetryable: true });
    });
  const pythonVersion = process.env.AZHI_PYTHON_VERSION ?? '3.12';
  const capabilities = detectCapabilities(pythonVersion);
  const name = o.name ?? hostname();
  const heartbeat = () =>
    api.post('/v1/workers/heartbeat', { id: workerId, name, task_queue: TASK_QUEUES.exec(workerId), capabilities, trust_policy: trustPolicy }).catch((e) => log(`heartbeat failed: ${(e as Error).message}`));
  await heartbeat();
  const hb = setInterval(heartbeat, 10_000);

  installTemporalRuntime();
  const connection = await NativeConnection.connect({ address: o.temporalAddress });
  const worker = await Worker.create({
    connection,
    namespace: o.namespace ?? 'default',
    taskQueue: TASK_QUEUES.exec(workerId),
    activities: scriptActivities({ api, workerId, cacheDir: dataDir, capabilities, pythonVersion, verifyPackage }),
    maxConcurrentActivityTaskExecutions: Number(process.env.AZHI_WORKER_CONCURRENCY ?? 4),
  });
  const running = worker.run();
  let stopped = false;
  log(`worker ${name} (${workerId}) up; runtimes: ${Object.entries(capabilities.runtimes).map(([k, v]) => `${k} ${v.version}`).join(', ') || 'none'}`);
  return {
    workerId,
    capabilities,
    running,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(hb);
      await api.post(`/v1/workers/${workerId}/offline`).catch(() => {});
      if (worker.getState() === 'RUNNING') worker.shutdown();
      await running.catch(() => {});
      await connection.close();
    },
  };
}
