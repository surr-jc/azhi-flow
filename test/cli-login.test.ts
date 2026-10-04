import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, temporalAvailable, type Harness } from './helpers/harness.js';

/** Runs the real CLI entry point (`bin/azhi.js`) with an isolated home directory. */
async function azhi(home: string, args: string[]): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.AZHI_URL;
  delete env.AZHI_TOKEN;
  const c = spawn(process.execPath, ['bin/azhi.js', ...args], { env });
  let out = '';
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number>((r) => c.on('exit', (x) => r(x ?? 1)));
  return { code, out };
}

describe.skipIf(!(await temporalAvailable()))('azhi login (the real CLI)', () => {
  let h: Harness;
  let token: string;
  beforeAll(async () => {
    h = await startHarness({ worker: false });
    token = readFileSync(h.server.localTokenFile!, 'utf8').trim();
  });
  afterAll(async () => h?.stop());

  it('accepts --url and --token after the subcommand, saves them and works afterwards', async () => {
    const home = mkdtempSync(join(tmpdir(), 'azhi-home-'));
    const login = await azhi(home, ['login', '--url', h.server.url, '--token', token]);
    expect(login.out).toMatch(/logged in to .* as usr_local \(owner\)/);
    expect(login.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, '.azhi', 'cli.json'), 'utf8'))).toEqual({ url: h.server.url, token });
    // A later command with no flags uses the saved login.
    const runs = await azhi(home, ['runs']);
    expect(runs.code).toBe(0);
  });

  it('accepts the flags before the subcommand too', async () => {
    const home = mkdtempSync(join(tmpdir(), 'azhi-home-'));
    const login = await azhi(home, ['--url', h.server.url, '--token', token, 'login']);
    expect(login.code).toBe(0);
    expect(existsSync(join(home, '.azhi', 'cli.json'))).toBe(true);
  });

  it('explains what is missing and does not save a login', async () => {
    const home = mkdtempSync(join(tmpdir(), 'azhi-home-'));
    const login = await azhi(home, ['login', '--url', h.server.url]);
    expect(login.code).not.toBe(0);
    expect(login.out).toContain('azhi login --url <server> --token <token>');
    expect(existsSync(join(home, '.azhi', 'cli.json'))).toBe(false);
  });

  it('does not save a login the server rejects', async () => {
    const home = mkdtempSync(join(tmpdir(), 'azhi-home-'));
    const login = await azhi(home, ['login', '--url', h.server.url, '--token', 'azhi_wrong']);
    expect(login.code).not.toBe(0);
    expect(existsSync(join(home, '.azhi', 'cli.json'))).toBe(false);
  });
});
