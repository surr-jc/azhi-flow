import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * In a source checkout, the web app (web/) is built into src/web/dist, and the server serves
 * whatever is there. After a `git pull` the old build would keep being served, so pages added
 * since then (for example Build with chat) seem to be missing. `azhi up` calls this first: when
 * any file under web/ is newer than the build, it rebuilds. Installs without web/ or without
 * vite (the Docker image builds the app itself) are left alone.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function newest(dir: string): number {
  let t = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    t = Math.max(t, s.isDirectory() ? newest(p) : s.mtimeMs);
  }
  return t;
}

/** Whether the build is missing or older than the web app's sources. */
export function webBuildStale(root = ROOT): boolean {
  const web = join(root, 'web');
  if (!existsSync(join(web, 'src'))) return false;
  const built = join(root, 'src', 'web', 'dist', 'index.html');
  if (!existsSync(built)) return true;
  return newest(web) > statSync(built).mtimeMs;
}

export function ensureWebBuilt(log: (m: string) => void, root = ROOT): void {
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite) || !webBuildStale(root)) return;
  log('building the web app (its sources changed since the last build)');
  const r = spawnSync(process.execPath, [vite, 'build', '--config', join('web', 'vite.config.ts'), '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) log('the web app did not build; run npm run build:web to see why. The previous build is served.');
}
