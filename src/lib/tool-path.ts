import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/**
 * Where command-line tools (gh, git, ...) are usually installed. A desktop app started from Finder, the
 * Dock or a Start-menu shortcut gets the system's short PATH (macOS: /usr/bin:/bin:/usr/sbin:/sbin), not the
 * one from the user's shell, so Homebrew (/opt/homebrew/bin on Apple Silicon, /usr/local/bin on Intel),
 * MacPorts, Nix, Linuxbrew, snap and the GitHub CLI's own installers are missed.
 */
export function toolDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/opt/local/bin', '/run/current-system/sw/bin', join(home, '.nix-profile', 'bin'), join(home, 'bin'), join(home, '.local', 'bin')];
  }
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [join(pf, 'GitHub CLI'), join(pf86, 'GitHub CLI'), join(local, 'Programs', 'GitHub CLI'), join(local, 'GitHubCLI'), join(home, 'scoop', 'shims'), join(env.ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey', 'bin')];
  }
  return ['/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', '/nix/var/nix/profiles/default/bin', join(home, '.nix-profile', 'bin'), join(home, 'bin'), join(home, '.local', 'bin')];
}

/** Appends the usual install folders that exist and are not on PATH yet (after the existing entries, so the user's own choice still wins). */
export function ensureToolPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): void {
  const key = platform === 'win32' ? (Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path') : 'PATH';
  const current = (env[key] ?? '').split(platform === 'win32' ? win32.delimiter : posix.delimiter).filter(Boolean);
  const seen = new Set(current.map((p) => (platform === 'win32' ? p.toLowerCase() : p)));
  const extra = toolDirs(platform, env).filter((d) => !seen.has(platform === 'win32' ? d.toLowerCase() : d) && exists(d));
  if (extra.length) env[key] = [...current, ...extra].join(platform === 'win32' ? win32.delimiter : posix.delimiter);
}
