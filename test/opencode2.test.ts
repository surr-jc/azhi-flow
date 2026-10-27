import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { opencodeVersion } from '../src/worker/capabilities.js';
import { DCP_PACKAGE, DCP_VERSION, dcpPlugin, OPENCODE2_VERSION, opencode2Binary, opencode2Dir } from '../src/worker/tools.js';

/** The OpenCode 2 pieces that run without a server; the adapter itself runs in opencode.test.ts with AZHI_OPENCODE_MAJOR=2. */
describe('OpenCode 2 setup', () => {
  it('reads the version from either major', () => {
    expect(opencodeVersion('1.18.34')).toBe('1.18.34');
    expect(opencodeVersion('opencode v2.1.4')).toBe('2.1.4');
    expect(opencodeVersion(undefined)).toBeUndefined();
    expect(OPENCODE2_VERSION).toMatch(/^2\.\d+\.\d+$/);
  });

  it('finds the platform binary npm put in the tools folder, and prefers the AVX2 build over the baseline', () => {
    const tools = mkdtempSync(join(tmpdir(), 'azhi-tools-'));
    const env = { AZHI_TOOLS_DIR: tools, PATH: '' };
    expect(opencode2Binary(env, 'linux', 'x64')).toBeUndefined();
    const pkg = (name: string, exe: string) => {
      const dir = join(opencode2Dir(env), 'node_modules', '@opencode', name, 'bin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, exe), '');
      return join(dir, exe);
    };
    const baseline = pkg('cli-windows-x64-baseline', 'opencode.exe');
    expect(opencode2Binary(env, 'win32', 'x64')).toBe(baseline);
    const avx2 = pkg('cli-windows-x64', 'opencode.exe');
    expect(opencode2Binary(env, 'win32', 'x64')).toBe(avx2);
    expect(opencode2Binary(env, 'linux', 'x64')).toBeUndefined();
    expect(opencode2Binary(env, 'linux', 'arm64')).toBeUndefined();
    expect(opencode2Binary({ ...env, AZHI_OPENCODE2_BIN: '/opt/opencode2' }, 'linux', 'x64')).toBe('/opt/opencode2');
  });

  it("gives OpenCode 2 DCP's package folder (it loads plugins only from a folder)", () => {
    const tools = mkdtempSync(join(tmpdir(), 'azhi-tools-'));
    const root = join(tools, 'dcp', 'node_modules', ...DCP_PACKAGE.split('/'));
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.js'), '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: DCP_VERSION }));
    expect(dcpPlugin({ AZHI_TOOLS_DIR: tools })).toEqual({ version: DCP_VERSION, path: join(root, 'dist', 'index.js'), dir: root });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    expect(dcpPlugin({ AZHI_TOOLS_DIR: tools })).toBeUndefined();
  });
});
