import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/** Where Azhi keeps tools it provisions itself: AZHI_TOOLS_DIR, else ~/.azhi/tools (set it to another drive on a small disk). */
export function toolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AZHI_TOOLS_DIR ?? join(env.AZHI_HOME ?? join(homedir(), '.azhi'), 'tools');
}

function which(cmd: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env });
    return out.split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * ripgrep (`rg`): AZHI_RG_BIN, the tools folder, or PATH. OpenCode's grep and glob tools run it; it looks on PATH,
 * then in its own per-step data folder, and otherwise downloads a copy on every step (the folder is new each time).
 */
export function ripgrepBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AZHI_RG_BIN) return existsSync(env.AZHI_RG_BIN) ? env.AZHI_RG_BIN : undefined;
  const local = join(toolsDir(env), 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
  return existsSync(local) ? local : which('rg', env);
}

export function ripgrepVersion(path: string): string | undefined {
  try {
    return /ripgrep\s+(\S+)/.exec(execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }))?.[1];
  } catch {
    return undefined;
  }
}

/** PATH for an OpenCode step: the folder holding rg first when rg is not already on PATH, so OpenCode never downloads it. */
export function pathWithRipgrep(path: string | undefined, rg: string | undefined): string | undefined {
  if (!rg) return path;
  const dir = dirname(rg);
  const parts = (path ?? '').split(delimiter);
  return parts.includes(dir) ? path : [dir, ...parts.filter(Boolean)].join(delimiter);
}

/** Install commands per platform, for `azhi setup` and doctor messages. */
export function ripgrepInstallHint(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'darwin') return 'brew install ripgrep';
  if (platform === 'win32') return 'winget install BurntSushi.ripgrep.MSVC (OpenCode steps run on Linux, macOS or WSL workers; install it there with apt)';
  const wsl = Boolean(env.WSL_DISTRO_NAME);
  return `sudo apt install ripgrep (Debian, Ubuntu${wsl ? ', WSL' : ''}) or sudo dnf install ripgrep (Fedora, RHEL); without root, download the release from github.com/BurntSushi/ripgrep and put rg in ${join(toolsDir(env), 'bin')} or set AZHI_RG_BIN`;
}

/** Added to an OpenCode step's prompt when token saving is on: file reads stack up across turns, searches do not. */
export const SEARCH_FIRST_GUIDANCE = `Reading rules: find things with grep and glob first, then read only the lines you need (use offset and limit). Do not read a whole large file, and do not read the same file twice; keep the facts you need in your notes instead.`;

/** Whether token saving applies to a step: the profile's choice, else AZHI_OPENCODE_TOKEN_SAVING (on or off; default off). */
export function tokenSavingOn(profileSetting: 'on' | 'off' | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return (profileSetting ?? (env.AZHI_OPENCODE_TOKEN_SAVING === 'on' ? 'on' : 'off')) === 'on';
}
