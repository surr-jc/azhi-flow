import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startServer, type ServerHandle } from '../server/server.js';
import { startWorker } from '../worker/worker.js';
import { ensureTemporalCli, startTemporalDevServer, type TemporalDevServer } from './temporal.js';

/**
 * `azhi up`: Azhi Flow on one machine without Docker. An embedded PostgreSQL (PGlite), the
 * Temporal dev server, the server with every role and an execution worker, all started from one
 * process, with state under `~/.azhi`. The server keeps its usual data dir (`~/.azhi/server`), so
 * the CLI finds the local token without `azhi login`.
 */
export interface LocalOptions {
  home?: string;
  port?: number;
  worker?: boolean;
  log?: (m: string) => void;
}

export interface LocalHandle {
  server: ServerHandle;
  temporal: TemporalDevServer;
  url: string;
  token: string;
  stop(): Promise<void>;
}

export const localHome = (home?: string) => home ?? process.env.AZHI_HOME ?? join(homedir(), '.azhi');
export const pidFile = (home?: string) => join(localHome(home), 'local', 'azhi.pid');

export async function startLocal(o: LocalOptions = {}): Promise<LocalHandle> {
  const log = o.log ?? ((m: string) => console.log(`[azhi] ${m}`));
  const home = localHome(o.home);
  const localDir = join(home, 'local');
  mkdirSync(localDir, { recursive: true });
  const pf = pidFile(home);
  if (existsSync(pf)) {
    const pid = Number(readFileSync(pf, 'utf8'));
    if (pid && pid !== process.pid && alive(pid)) throw new Error(`Azhi is already running locally (pid ${pid}); stop it with 'azhi down'`);
  }

  const bin = await ensureTemporalCli(join(home, 'bin'), log);
  const temporal = await startTemporalDevServer({ bin, dbFile: join(localDir, 'temporal.db'), log });
  log(`Temporal dev server on ${temporal.address}`);
  const stops: Array<() => Promise<void>> = [() => temporal.stop()];
  try {
    const dataDir = join(home, 'server');
    const server = await startServer({
      log,
      settings: {
        databaseUrl: `pglite://${join(localDir, 'db')}`,
        temporalAddress: temporal.address,
        dataDir,
        artifactDir: join(dataDir, 'artifacts'),
        authMode: 'local',
        host: '127.0.0.1',
        ...(o.port !== undefined ? { port: o.port, publicUrl: `http://127.0.0.1:${o.port}` } : {}),
      },
    });
    stops.unshift(() => server.stop());
    const token = readFileSync(server.localTokenFile!, 'utf8').trim();
    if (o.worker !== false) {
      const worker = await startWorker({ apiUrl: server.url, token, temporalAddress: temporal.address, dataDir: join(home, 'worker'), trustPolicy: { kind: 'workspace-publishers' }, log });
      stops.unshift(() => worker.stop());
    }
    writeFileSync(pf, String(process.pid));
    stops.push(async () => rmSync(pf, { force: true }));
    return {
      server,
      temporal,
      url: server.url,
      token,
      async stop() {
        for (const s of stops) await s().catch((e) => log(`stop: ${(e as Error).message}`));
      },
    };
  } catch (err) {
    for (const s of stops) await s().catch(() => {});
    throw err;
  }
}

/** `azhi down`: stops a running `azhi up` by its pid file. */
export async function stopLocal(home?: string): Promise<boolean> {
  const pf = pidFile(home);
  if (!existsSync(pf)) return false;
  const pid = Number(readFileSync(pf, 'utf8'));
  if (!pid || !alive(pid)) {
    rmSync(pf, { force: true });
    return false;
  }
  process.kill(pid, 'SIGTERM');
  const end = Date.now() + 30_000;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
  return true;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
