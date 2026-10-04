import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

/**
 * Local mode's durable engine: Temporal's single-binary dev server (`temporal server start-dev`)
 * with SQLite storage in one file, so runs survive restarts without Docker. The CLI is pinned and
 * checksum-verified; `AZHI_TEMPORAL_BIN` or a `temporal` on PATH is used when present.
 */
export const TEMPORAL_CLI_VERSION = '1.9.1';
const SHA256: Record<string, string> = {
  darwin_amd64: '48cdd6c84c56e27ae8e4d9a47052b89289a9c552dee029b49dd312c6fb72873f',
  darwin_arm64: '41e0425378fcb4fb5766340b97435e20fe47bbff2d7bf644ec2d51f7662b7c56',
  linux_amd64: '09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5',
  linux_arm64: '6c57c352d52fc3df34412376fd9ba6f74b7e3ace8e426e6cba8600156d36a145',
  windows_amd64: '42637464c337a3da203fbd4e8c688e4b2d511fd42bd19c337c0422e923a7b619',
  windows_arm64: 'cfdfe43e69a2261191148294b1f7e3a7088ef8d3dc1ab1909b115b1784b6c6fe',
};

const exe = process.platform === 'win32' ? 'temporal.exe' : 'temporal';

function onPath(): string | undefined {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? exe : undefined;
}

/** Finds the Temporal CLI, downloading the pinned build into `binDir` on first use. */
export async function ensureTemporalCli(binDir: string, log: (m: string) => void = () => {}): Promise<string> {
  if (process.env.AZHI_TEMPORAL_BIN) return process.env.AZHI_TEMPORAL_BIN;
  const pinned = join(binDir, `temporal-${TEMPORAL_CLI_VERSION}`, exe);
  if (existsSync(pinned)) return pinned;
  const found = onPath();
  if (found) return found;

  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform as string];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch as string];
  const sha = os && arch ? SHA256[`${os}_${arch}`] : undefined;
  if (!sha) throw new Error(`no Temporal CLI build for ${process.platform}/${process.arch}; install it and set AZHI_TEMPORAL_BIN`);
  const name = `temporal_cli_${TEMPORAL_CLI_VERSION}_${os}_${arch}.tar.gz`;
  const url = `https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI_VERSION}/${name}`;
  log(`downloading Temporal CLI ${TEMPORAL_CLI_VERSION} (about 45 MB, once)`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download of ${url} failed: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== sha) throw new Error(`Temporal CLI checksum mismatch for ${name}: expected ${sha}, got ${got}`);

  const dir = join(binDir, `temporal-${TEMPORAL_CLI_VERSION}`);
  const staging = `${dir}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, name);
  writeFileSync(archive, body);
  // tar ships with Linux, macOS and Windows 10+.
  const t = spawnSync('tar', ['-xzf', name], { cwd: staging, encoding: 'utf8', windowsHide: true });
  if (t.status !== 0) throw new Error(`cannot extract ${name}: ${t.stderr || t.error?.message}`);
  rmSync(archive);
  if (process.platform !== 'win32') chmodSync(join(staging, exe), 0o755);
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return pinned;
}

export async function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | undefined>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(undefined));
      s.listen(port, '127.0.0.1', () => {
        // Read the port before closing: a closed server has no address (and port 0 means "any").
        const got = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(got));
      });
    });
  return (await tryPort(preferred)) ?? (await tryPort(0))!;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => (s.end(), resolve(true)));
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

export interface TemporalDevServer {
  address: string;
  stop(): Promise<void>;
}

/** Starts the dev server on a free port with its state in `dbFile`, and waits until it accepts connections. */
export async function startTemporalDevServer(o: { bin: string; dbFile: string; port?: number; log?: (m: string) => void }): Promise<TemporalDevServer> {
  const port = await freePort(o.port ?? 7233);
  const args = ['server', 'start-dev', '--db-filename', o.dbFile, '--ip', '127.0.0.1', '--port', String(port), '--headless', '--log-level', 'error', '--namespace', 'default'];
  const proc: ChildProcess = spawn(o.bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  const end = Date.now() + 60_000;
  const ready = async () =>
    (await portOpen(port)) && spawnSync(o.bin, ['operator', 'namespace', 'describe', '--namespace', 'default', '--address', `127.0.0.1:${port}`], { stdio: 'ignore', windowsHide: true, timeout: 10_000 }).status === 0;
  while (!(await ready())) {
    if (proc.exitCode !== null) throw new Error(`Temporal dev server exited with code ${proc.exitCode}: ${stderr.trim().slice(-500)}`);
    if (Date.now() > end) {
      proc.kill();
      throw new Error(`Temporal dev server did not start on port ${port} within 60 s: ${stderr.trim().slice(-500)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    address: `127.0.0.1:${port}`,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(t);
    },
  };
}
