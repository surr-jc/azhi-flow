import { Client, Connection } from '@temporalio/client';
import type { Worker } from '@temporalio/worker';
import { buildApi } from '../api/app.js';
import { bootstrapLocal } from '../api/auth.js';
import type { Settings } from '../config/settings.js';
import { migrate } from '../db/migrate.js';
import { connectTemporal, createGatewayWorker, createInterpreterWorker, interpreterBuildId } from '../runtime/interpreter.js';
import { createContext, type AppContext } from './context.js';
import { startOutboxDispatcher } from './outbox.js';
import { startScheduler } from './scheduler.js';
import { startAlertNotifier } from './alerts.js';

export type ServerRole = 'api' | 'interpreter' | 'gateway' | 'scheduler';
export const ALL_ROLES: ServerRole[] = ['api', 'interpreter', 'gateway', 'scheduler'];

export interface ServerHandle {
  ctx: AppContext;
  url: string;
  interpreterBuild: string;
  localToken?: string;
  localTokenFile?: string;
  scheduler?: ReturnType<typeof startScheduler>;
  stop(): Promise<void>;
}

/**
 * The Azhi server: a modular monolith. Roles can be split across processes; by default one
 * process serves the API, runs the outbox dispatcher and scheduler, hosts the interpreter for
 * its build, and runs gateway activities.
 */
export async function startServer(opts: { roles?: ServerRole[]; settings?: Partial<Settings>; log?: (m: string) => void } = {}): Promise<ServerHandle> {
  const roles = opts.roles ?? ALL_ROLES;
  const log = opts.log ?? ((m: string) => console.log(`[azhi] ${m}`));
  const ctx = createContext(opts.settings);
  const applied = await migrate(ctx.pool);
  if (applied.length) log(`applied migrations: ${applied.join(', ')}`);
  const build = interpreterBuildId(ctx.settings.interpreterBuild);
  await ctx.pool.query(`INSERT INTO interpreter_builds(build_id) VALUES ($1) ON CONFLICT (build_id) DO UPDATE SET last_seen=now()`, [build]);

  let local: Awaited<ReturnType<typeof bootstrapLocal>> | undefined;
  if (ctx.settings.authMode === 'local') local = await bootstrapLocal(ctx);

  const stops: Array<() => Promise<void> | void> = [];
  const temporalConnection = await Connection.connect({ address: ctx.settings.temporalAddress });
  const client = new Client({ connection: temporalConnection, namespace: ctx.settings.temporalNamespace });
  stops.push(() => temporalConnection.close());

  const workers: Worker[] = [];
  if (roles.includes('interpreter') || roles.includes('gateway')) {
    const nc = await connectTemporal(ctx.settings.temporalAddress);
    if (roles.includes('interpreter')) workers.push(await createInterpreterWorker(nc, ctx.settings.temporalNamespace, build));
    if (roles.includes('gateway')) workers.push(await createGatewayWorker(nc, ctx.settings.temporalNamespace, ctx));
    const running = workers.map((w) => w.run());
    stops.unshift(async () => {
      for (const w of workers) if (w.getState() === 'RUNNING') w.shutdown();
      await Promise.allSettled(running);
      await nc.close();
    });
  }

  let url = '';
  let scheduler: ReturnType<typeof startScheduler> | undefined;
  if (roles.includes('api')) {
    const outbox = startOutboxDispatcher(ctx, client, log);
    stops.unshift(() => outbox.stop());
    const app = buildApi({ ctx, temporal: client, interpreterBuild: build });
    url = await app.listen({ host: ctx.settings.host, port: ctx.settings.port });
    stops.unshift(() => app.close());
  }
  if (roles.includes('scheduler')) {
    scheduler = startScheduler(ctx, build, log);
    stops.unshift(() => scheduler!.stop());
    const alerts = startAlertNotifier(ctx, log);
    stops.unshift(() => alerts.stop());
  }
  const heartbeat = setInterval(() => void ctx.pool.query(`UPDATE interpreter_builds SET last_seen=now() WHERE build_id=$1`, [build]).catch(() => {}), 30_000);
  stops.unshift(() => clearInterval(heartbeat));

  log(`server up: roles=${roles.join(',')} build=${build}${url ? ` api=${url}` : ''}`);
  if (local?.token) log(`local owner token written to ${local.tokenFile}`);
  return {
    ctx,
    url,
    interpreterBuild: build,
    localToken: local?.token,
    localTokenFile: local?.tokenFile,
    scheduler,
    async stop() {
      for (const s of stops) await s();
      await ctx.pool.end();
    },
  };
}
