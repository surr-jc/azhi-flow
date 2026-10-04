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
  const pythonVersion = process.env.AZHI_PYTHON_VERSION ?? '3.12';
  const capabilities = detectCapabilities(pythonVersion);
  const name = o.name ?? hostname();
  const heartbeat = () =>
    api.post('/v1/workers/heartbeat', { id: workerId, name, task_queue: TASK_QUEUES.exec, capabilities, trust_policy: o.trustPolicy }).catch((e) => log(`heartbeat failed: ${(e as Error).message}`));
  await heartbeat();
  const hb = setInterval(heartbeat, 10_000);

  installTemporalRuntime();
  const connection = await NativeConnection.connect({ address: o.temporalAddress });
  const worker = await Worker.create({
    connection,
    namespace: o.namespace ?? 'default',
    taskQueue: TASK_QUEUES.exec,
    activities: scriptActivities({ api, workerId, cacheDir: dataDir, capabilities, pythonVersion, verifyPackage: o.verifyPackage }),
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
      if (worker.getState() === 'RUNNING') worker.shutdown();
      await running.catch(() => {});
      await connection.close();
    },
  };
}
