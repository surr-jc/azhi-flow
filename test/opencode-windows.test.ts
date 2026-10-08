import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXECUTORS } from '../src/executors/capabilities.js';
import { windowsSystemEnv } from '../src/lib/process.js';
import { opencodeBinary } from '../src/worker/capabilities.js';
import { MCP_LAUNCHER, OPENCODE_PRIVATE_ENV, writeOpencodeSetup } from '../src/worker/opencode-setup.js';

/**
 * OpenCode steps on native Windows workers. These run on any OS: they check the pieces the Windows path is made of
 * (the program the worker starts, the kept system variables, the MCP launcher that replaces `env -u`).
 */
describe('OpenCode on native Windows', () => {
  it('is declared for Windows, marked not yet verified there', () => {
    expect(EXECUTORS.opencode!.capabilities.platforms).toContain('windows');
    expect(EXECUTORS.opencode!.capabilities.unverified).toContain('platforms');
  });

  it('finds the pinned OpenCode program itself, not the npm wrapper', () => {
    const bin = opencodeBinary();
    if (!bin || process.env.AZHI_OPENCODE_BIN) return;
    expect(bin).toMatch(/node_modules[\\/]opencode-ai[\\/]bin[\\/]opencode\.exe$/);
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('keeps the system variables a Windows program needs, only on Windows', () => {
    const env = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', TEMP: 'C:\\Temp', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret' };
    expect(windowsSystemEnv(env, 'win32')).toEqual({ SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', TEMP: 'C:\\Temp' });
    expect(windowsSystemEnv(env, 'linux')).toEqual({});
  });

  it('starts profile MCP servers through the launcher on Windows and `env -u` elsewhere', () => {
    const h = { mcp: { probe: { command: ['node', 'harness/mcp/probe.mjs'] } } };
    const o = { pkgDir: mkdtempSync(join(tmpdir(), 'azhi-oc-win-')), system: 'sys', gitEnv: { HOME: '/h' } };
    const win = writeOpencodeSetup(h, { ...o, configDir: mkdtempSync(join(tmpdir(), 'azhi-oc-cfg-')), platform: 'win32' });
    expect(win.mcp.probe!.command).toEqual([process.execPath, MCP_LAUNCHER, OPENCODE_PRIVATE_ENV.join(','), '--', process.execPath, 'harness/mcp/probe.mjs']);
    const posix = writeOpencodeSetup(h, { ...o, configDir: mkdtempSync(join(tmpdir(), 'azhi-oc-cfg-')), platform: 'linux' });
    expect(posix.mcp.probe!.command.slice(0, 2)).toEqual(['/usr/bin/env', '-u']);
  });

  it('the launcher takes OpenCode secrets out of the environment and passes the exit code on', () => {
    const print = `process.stdout.write(JSON.stringify({auth:process.env.OPENCODE_AUTH_CONTENT??null,pw:process.env.OPENCODE_SERVER_PASSWORD??null,keep:process.env.AZHI_KEEP??null,arg:process.argv[1]}));process.exit(3)`;
    const r = spawnSync(process.execPath, [MCP_LAUNCHER, OPENCODE_PRIVATE_ENV.join(','), '--', process.execPath, '-e', print, 'a b"c'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_AUTH_CONTENT: '{"x":1}', OPENCODE_SERVER_PASSWORD: 'pw', AZHI_KEEP: 'yes' },
    });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual({ auth: null, pw: null, keep: 'yes', arg: 'a b"c' });
  });

  it('the launcher reports a missing command instead of hanging', () => {
    const r = spawnSync(process.execPath, [MCP_LAUNCHER, 'X', '--', 'azhi-no-such-command'], { encoding: 'utf8' });
    expect(r.status).toBe(127);
    expect(r.stderr).toContain('azhi-no-such-command');
  });
});
