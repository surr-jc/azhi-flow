import { spawnSync } from 'node:child_process';

/**
 * Signals a child started with `detached: true` and everything it started. On Linux and macOS
 * that is its process group; Windows has no process groups, so `taskkill /T` walks the tree
 * (always forcefully: Windows has no SIGTERM to ask nicely).
 */
export function killTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  process.kill(-pid, signal);
}
