import { describe, expect, it } from 'vitest';
import { opencodeHarnessProblems } from '../src/agents/profile.js';
import { pathWithRipgrep, ripgrepBinary, ripgrepInstallHint, SEARCH_FIRST_GUIDANCE, tokenSavingOn, toolsDir } from '../src/worker/tools.js';

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
    expect(pathWithRipgrep('/usr/bin:/bin', '/opt/azhi/tools/bin/rg')?.split(':')[0]).toBe('/opt/azhi/tools/bin');
    expect(pathWithRipgrep('/usr/bin:/bin', '/usr/bin/rg')).toBe('/usr/bin:/bin');
    expect(pathWithRipgrep('/usr/bin', undefined)).toBe('/usr/bin');
  });

  it('finds ripgrep from AZHI_RG_BIN and keeps the tools folder overridable', () => {
    expect(ripgrepBinary({ AZHI_RG_BIN: '/nonexistent/rg' })).toBeUndefined();
    expect(toolsDir({ AZHI_TOOLS_DIR: '/d/azhi-tools' })).toBe('/d/azhi-tools');
    expect(ripgrepInstallHint('darwin', {})).toContain('brew');
    expect(ripgrepInstallHint('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toContain('WSL');
    expect(ripgrepInstallHint('win32', {})).toContain('winget');
  });
});
