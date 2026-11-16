import { describe, expect, it } from 'vitest';
import { ensureToolPath, toolDirs } from '../src/lib/tool-path.js';

describe('ensureToolPath', () => {
  it('adds Homebrew on macOS after the existing PATH, only when the folder exists', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    ensureToolPath(env, 'darwin', (p) => p === '/opt/homebrew/bin');
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin');
  });

  it('does not duplicate entries already on PATH', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/opt/homebrew/bin:/usr/bin' };
    ensureToolPath(env, 'darwin', () => true);
    expect(env.PATH!.split(':').filter((p) => p === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('lists both Homebrew prefixes for macOS', () => {
    const dirs = toolDirs('darwin', {}, '/Users/x');
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
  });
});
