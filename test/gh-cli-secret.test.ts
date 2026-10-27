import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/security/secrets.js';
import { ghCliPointer, ghCliToken, parseGhCliPointer, setGhRunnerForTests } from '../src/server/gh-cli.js';
import { resolveSecret } from '../src/server/secrets.js';
import type { AppContext } from '../src/server/context.js';

afterEach(() => setGhRunnerForTests());

/** A context with just enough for resolveSecret: a pool that returns one stored secret. */
const ctxWith = (stored: string): AppContext => {
  const secretKey = randomBytes(32);
  const ciphertext = encryptSecret(secretKey, stored);
  return { secretKey, pool: { query: async () => ({ rows: [{ version: 3, ciphertext }] }) } } as unknown as AppContext;
};

describe('a secret that points at the GitHub CLI login', () => {
  it('reads the pointer for github.com and for an Enterprise host, and nothing else', () => {
    expect(parseGhCliPointer('azhi:gh-cli')).toEqual({ host: 'github.com' });
    expect(parseGhCliPointer(' azhi:gh-cli:Git.Example.com ')).toEqual({ host: 'git.example.com' });
    expect(parseGhCliPointer('azhi:gh-cli:bad host')).toBeUndefined();
    expect(parseGhCliPointer('azhi:gh-cli:')).toBeUndefined();
    expect(parseGhCliPointer('github_pat_abc')).toBeUndefined();
    expect(ghCliPointer()).toBe('azhi:gh-cli');
    expect(ghCliPointer('git.example.com')).toBe('azhi:gh-cli:git.example.com');
  });

  it('asks gh for the token of the host, and caches it briefly', async () => {
    const calls: string[][] = [];
    setGhRunnerForTests(async (args) => {
      calls.push(args);
      return { stdout: 'gho_livetoken\n', stderr: '' };
    });
    expect(await ghCliToken()).toBe('gho_livetoken');
    expect(await ghCliToken()).toBe('gho_livetoken');
    expect(calls).toEqual([['auth', 'token', '--hostname', 'github.com']]);
  });

  it('says how to install gh when it is missing, and how to sign in when it is signed out', async () => {
    setGhRunnerForTests(async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    });
    await expect(ghCliToken()).rejects.toThrow(/not found.*winget install GitHub\.cli.*gh auth login/s);
    setGhRunnerForTests(async () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'no oauth token found for github.com' });
    });
    await expect(ghCliToken()).rejects.toThrow(/not signed in to github\.com.*gh auth login/s);
    setGhRunnerForTests(async () => ({ stdout: '  \n', stderr: '' }));
    await expect(ghCliToken()).rejects.toThrow(/no usable token/);
  });

  it('is resolved to the live token, while an ordinary secret is returned as stored', async () => {
    setGhRunnerForTests(async () => ({ stdout: 'gho_fromgh\n', stderr: '' }));
    expect(await resolveSecret(ctxWith('azhi:gh-cli'), 'ws', 'github-write-token')).toEqual({ value: 'gho_fromgh', version: 3 });
    expect(await resolveSecret(ctxWith('github_pat_stored'), 'ws', 'github-write-token')).toEqual({ value: 'github_pat_stored', version: 3 });
  });

  it('fails with the fix, not with a missing secret, when gh is signed out', async () => {
    setGhRunnerForTests(async () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'not logged in' });
    });
    await expect(resolveSecret(ctxWith('azhi:gh-cli'), 'ws', 'github-read-token')).rejects.toThrow(/gh auth login/);
  });
});
