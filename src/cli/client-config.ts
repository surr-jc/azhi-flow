import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { settings } from '../config/settings.js';
import { ApiClient } from '../worker/api-client.js';

const CLI_CONFIG = join(homedir(), '.azhi', 'cli.json');

export interface CliConfig {
  url: string;
  token: string;
}

/** Flags, then AZHI_URL/AZHI_TOKEN, then `azhi login`, then a local server's token file. */
export function resolveCliConfig(flags: { url?: string; token?: string } = {}): CliConfig {
  const saved: Partial<CliConfig> = existsSync(CLI_CONFIG) ? JSON.parse(readFileSync(CLI_CONFIG, 'utf8')) : {};
  const s = settings();
  const localTokenFile = join(s.dataDir, 'local-token');
  const url = flags.url ?? process.env.AZHI_URL ?? saved.url ?? s.publicUrl;
  const token = flags.token ?? process.env.AZHI_TOKEN ?? saved.token ?? (existsSync(localTokenFile) ? readFileSync(localTokenFile, 'utf8').trim() : undefined);
  if (!token) throw new Error('not logged in: run `azhi login --url <server> --token <token>` or start a local server with `azhi server start`');
  return { url, token };
}

export function saveCliConfig(cfg: CliConfig) {
  mkdirSync(dirname(CLI_CONFIG), { recursive: true });
  writeFileSync(CLI_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function apiClient(flags: { url?: string; token?: string } = {}): ApiClient {
  const c = resolveCliConfig(flags);
  return new ApiClient(c.url, c.token);
}
