import { DefaultLogger, NativeConnection, Runtime, Worker, type LogLevel } from '@temporalio/worker';
import { existsSync, readFileSync } from 'node:fs';
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
  '../executors/capabilities.ts',
  '../lib/json.ts',
  '../lib/errors.ts',
];

/** Written next to this module by `npm run build:app`; absent in a source checkout. */
const BUNDLE_PATH = fileURLToPath(new URL('./workflow-bundle.js', import.meta.url));
const BUILD_FILE = fileURLToPath(new URL('./interpreter-build.json', import.meta.url));

export function interpreterBuildId(override?: string): string {
  if (override) return override;
  // A packaged app has no .ts sources to hash: use the ID recorded when the workflow was bundled.
  if (existsSync(BUILD_FILE)) return (JSON.parse(readFileSync(BUILD_FILE, 'utf8')) as { id: string }).id;
  // Line endings are normalised so a Windows checkout (CRLF) gets the same build ID as Linux.
  const h = INTERPRETER_SOURCES.map((p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')).join('\0');
  return `b${sha256(h).slice(0, 12)}`;
}

export const WORKFLOWS_PATH = fileURLToPath(new URL('./workflow.ts', import.meta.url));

let runtimeInstalled = false;
/** Installs the Temporal runtime once, with a quieter default log level. */
export function installTemporalRuntime() {
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  try {
    Runtime.install({ logger: new DefaultLogger((process.env.AZHI_TEMPORAL_LOG_LEVEL ?? 'ERROR') as LogLevel) });
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
    // Packaged: the workflow was bundled at build time, so no webpack or SWC runs here.
    ...(existsSync(BUNDLE_PATH)
      ? { workflowBundle: { codePath: BUNDLE_PATH } }
      : {
          workflowsPath: WORKFLOWS_PATH,
          // Keep workflow bundles free of Node built-ins.
          bundlerOptions: { ignoreModules: [] },
        }),
  });
}

export async function createGatewayWorker(connection: NativeConnection, namespace: string, ctx: AppContext) {
  return Worker.create({
    connection,
    namespace,
    taskQueue: ctx.settings.gatewayQueue,
    activities: gatewayActivities(ctx),
    maxConcurrentActivityTaskExecutions: 50,
  });
}
