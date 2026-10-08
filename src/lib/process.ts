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

/**
 * What a Windows program needs from its environment to start and reach the network (Winsock and TLS
 * read SystemRoot). A child given a scrubbed environment keeps these; on other platforms there are none.
 */
const WINDOWS_SYSTEM_ENV = ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'ProgramData', 'ProgramFiles'];
export function windowsSystemEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== 'win32') return {};
  return Object.fromEntries(WINDOWS_SYSTEM_ENV.flatMap((k) => (env[k] !== undefined ? [[k, env[k]!]] : [])));
}
