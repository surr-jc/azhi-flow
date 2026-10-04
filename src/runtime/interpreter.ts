import { DefaultLogger, NativeConnection, Runtime, Worker, type LogLevel } from '@temporalio/worker';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TASK_QUEUES } from '../config/settings.js';
import { sha256 } from '../lib/hash.js';
import type { AppContext } from '../server/context.js';
import { gatewayActivities } from './gateway-activities.js';

/** Source files that make up the interpreter. Changing any of them yields a new build ID (ADR-07). */
const INTERPRETER_SOURCES = [
  '../runtime/workflow.ts',
  '../runtime/values.ts',
  '../runtime/types.ts',
  '../runtime/activity-types.ts',
  '../cel/evaluator.ts',
  '../compiler/plan.ts',
  '../definition/types.ts',
  '../lib/json.ts',
  '../lib/errors.ts',
];

export function interpreterBuildId(override?: string): string {
  if (override) return override;
  const h = INTERPRETER_SOURCES.map((p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')).join('\0');
  return `b${sha256(h).slice(0, 12)}`;
}

export const WORKFLOWS_PATH = fileURLToPath(new URL('./workflow.ts', import.meta.url));

let runtimeInstalled = false;
/** Installs the Temporal runtime once, with a quieter default log level. */
export function installTemporalRuntime() {
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  try {
    Runtime.install({ logger: new DefaultLogger((process.env.AZHI_TEMPORAL_LOG_LEVEL ?? 'WARN') as LogLevel) });
  } catch {
    // Already installed by the host process.
  }
}

export async function connectTemporal(address: string) {
  installTemporalRuntime();
  return NativeConnection.connect({ address });
}

export async function createInterpreterWorker(connection: NativeConnection, namespace: string, build: string) {
  return Worker.create({
    connection,
    namespace,
    taskQueue: TASK_QUEUES.interpreter(build),
    workflowsPath: WORKFLOWS_PATH,
    // Keep workflow bundles free of Node built-ins.
    bundlerOptions: { ignoreModules: [] },
  });
}

export async function createGatewayWorker(connection: NativeConnection, namespace: string, ctx: AppContext) {
  return Worker.create({
    connection,
    namespace,
    taskQueue: TASK_QUEUES.gateway,
    activities: gatewayActivities(ctx),
    maxConcurrentActivityTaskExecutions: 50,
  });
}
