import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { opencodeHarnessProblems } from '../src/agents/profile.js';
import { DCP_CONFIG, DCP_PROTECTED_TOOLS, DCP_VERSION, dcpConfig, dcpLimits, dcpNote, dcpPlugin, pathWithRipgrep, ripgrepBinary, ripgrepInstallHint, SEARCH_FIRST_GUIDANCE, tokenSavingOn, toolsDir, writeDcpWrapper } from '../src/worker/tools.js';

describe('token saving', () => {
  it('is off unless the profile or the worker setting turns it on', () => {
    expect(tokenSavingOn(undefined, {})).toBe(false);
    expect(tokenSavingOn(undefined, { AZHI_OPENCODE_TOKEN_SAVING: 'on' })).toBe(true);
    expect(tokenSavingOn('off', { AZHI_OPENCODE_TOKEN_SAVING: 'on' })).toBe(false);
    expect(tokenSavingOn('on', {})).toBe(true);
    expect(SEARCH_FIRST_GUIDANCE).toMatch(/grep/);
  });

  it('checks the profile value', () => {
    expect(opencodeHarnessProblems({ token_saving: 'on' }, () => undefined)).toEqual([]);
    expect(opencodeHarnessProblems({ token_saving: 'yes' as never }, () => undefined)).toHaveLength(1);
  });

  it('puts the ripgrep folder on PATH only when it is missing from it', () => {
    const PATH = ['/usr/bin', '/bin'].join(delimiter);
    expect(pathWithRipgrep(PATH, '/opt/azhi/tools/bin/rg')?.split(delimiter)[0]).toBe('/opt/azhi/tools/bin');
    expect(pathWithRipgrep(PATH, '/usr/bin/rg')).toBe(PATH);
    expect(pathWithRipgrep('/usr/bin', undefined)).toBe('/usr/bin');
  });

  it('finds ripgrep from AZHI_RG_BIN and keeps the tools folder overridable', () => {
    expect(ripgrepBinary({ AZHI_RG_BIN: '/nonexistent/rg' })).toBeUndefined();
    expect(toolsDir({ AZHI_TOOLS_DIR: '/d/azhi-tools' })).toBe('/d/azhi-tools');
    expect(ripgrepInstallHint('darwin', {})).toContain('brew');
    expect(ripgrepInstallHint('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toContain('WSL');
    expect(ripgrepInstallHint('win32', {})).toContain('winget');
  });

  it('uses DCP only when the pinned version is installed in the tools folder', () => {
    expect(dcpPlugin({ AZHI_TOOLS_DIR: '/nonexistent/azhi-tools' })).toBeUndefined();
    expect(DCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DCP_CONFIG.autoUpdate).toBe(false);
    expect(DCP_CONFIG.commands.enabled).toBe(false);
  });

  it('never lets DCP prune the Azhi gateway tools, only OpenCode tools', () => {
    expect(DCP_PROTECTED_TOOLS).toEqual(['azhi_*']);
    const c = dcpConfig({});
    expect(c.compress.protectedTools).toEqual(['azhi_*']);
    expect(c.strategies.deduplication.protectedTools).toEqual(['azhi_*']);
    expect(c.strategies.purgeErrors.protectedTools).toEqual(['azhi_*']);
    expect(c.commands.protectedTools).toEqual(['azhi_*']);
  });

  it('takes DCP context limits from the worker settings, and refuses bad ones', () => {
    expect(dcpLimits({})).toEqual({});
    expect(dcpConfig({}).compress).not.toHaveProperty('minContextLimit');
    expect(dcpLimits({ AZHI_DCP_MIN_CONTEXT: '20000', AZHI_DCP_MAX_CONTEXT: '40000' })).toEqual({ minContextLimit: 20000, maxContextLimit: 40000 });
    expect(dcpLimits({ AZHI_DCP_MIN_CONTEXT: ' 25% ', AZHI_DCP_MAX_CONTEXT: '50%' })).toEqual({ minContextLimit: '25%', maxContextLimit: '50%' });
    expect(dcpLimits({ AZHI_DCP_MAX_CONTEXT: '60000' })).toEqual({ maxContextLimit: 60000 });
    expect(dcpConfig({ AZHI_DCP_MIN_CONTEXT: '20000' }).compress).toMatchObject({ permission: 'allow', minContextLimit: 20000, protectedTools: ['azhi_*'] });
    for (const bad of ['0', '-5', '12k', '0%', '150%', 'lots']) expect(() => dcpLimits({ AZHI_DCP_MIN_CONTEXT: bad })).toThrow(/AZHI_DCP_MIN_CONTEXT/);
    expect(() => dcpLimits({ AZHI_DCP_MIN_CONTEXT: '50000', AZHI_DCP_MAX_CONTEXT: '40000' })).toThrow(/must not be above/);
    expect(() => dcpLimits({ AZHI_DCP_MIN_CONTEXT: '60%', AZHI_DCP_MAX_CONTEXT: '40%' })).toThrow(/must not be above/);
  });

  it('says on the run page when DCP will step in', () => {
    expect(dcpNote('3.2.0').text).toContain('from 50,000 tokens');
    expect(dcpNote('3.2.0', { minContextLimit: 20000, maxContextLimit: '40%' }).text).toMatch(/from 20,000 tokens .* past 40% of the context window/);
    expect(dcpNote('3.2.0').text).toContain('gateway tool results are always kept');
  });

  it("keeps a checkout's .opencode/dcp.json out of the DCP config a step runs with", async () => {
    const root = mkdtempSync(join(tmpdir(), 'azhi-dcp-'));
    try {
      // A repository can ship a project config that would turn DCP's commands and custom prompts back on.
      const checkout = join(root, 'checkout');
      mkdirSync(join(checkout, '.opencode'), { recursive: true });
      writeFileSync(join(checkout, '.opencode', 'dcp.json'), JSON.stringify({ commands: { enabled: true }, experimental: { customPrompts: true } }));
      // A stand-in for DCP 3.2.0's lookup (lib/config.ts): dcp.json in the nearest `.opencode` at or above the directory it is handed.
      const fake = join(root, 'fake-dcp.js');
      writeFileSync(
        fake,
        [
          `import { existsSync, readFileSync, statSync } from 'node:fs';`,
          `import { join } from 'node:path';`,
          `const project = (dir) => {`,
          `  for (let cur = dir; ; cur = dirname(cur)) {`,
          `    const d = join(cur, '.opencode');`,
          `    if (existsSync(d) && statSync(d).isDirectory()) return existsSync(join(d, 'dcp.json')) ? JSON.parse(readFileSync(join(d, 'dcp.json'), 'utf8')) : {};`,
          `    if (dirname(cur) === cur) return {};`,
          `  }`,
          `};`,
          `export default { id: 'opencode-dcp', server: async (ctx) => ({ project: project(ctx.directory), ctx }), setup: async (ctx) => ({ project: project(ctx.location.directory), ctx }) };`,
        ].join('\n'),
      );
      const plain = (await import(pathToFileURL(fake).href)).default;
      expect((await plain.server({ directory: checkout })).project).toMatchObject({ commands: { enabled: true } });

      const wrapper = writeDcpWrapper(join(root, 'step'), { path: fake });
      expect(JSON.parse(readFileSync(join(wrapper.dir, 'package.json'), 'utf8')).main).toBe('server.js');
      const dcp = (await import(pathToFileURL(wrapper.path).href)).default;
      expect(dcp.id).toBe('opencode-dcp');
      const client = {};
      // OpenCode 1.x: the server plugin gets the step's folder instead of the checkout; the rest of ctx is passed through.
      const v1 = await dcp.server({ directory: checkout, client });
      expect(v1.project).toEqual({});
      expect(v1.ctx.client).toBe(client);
      expect(v1.ctx.directory.startsWith(join(root, 'step'))).toBe(true);
      expect(existsSync(join(v1.ctx.directory, '.opencode', 'dcp.json'))).toBe(false);
      // OpenCode 2: setup's location.
      const v2 = await dcp.setup({ location: { directory: checkout }, rpc: client });
      expect(v2.project).toEqual({});
      expect(v2.ctx.rpc).toBe(client);
      expect(v2.ctx.location.directory).toBe(v1.ctx.directory);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
