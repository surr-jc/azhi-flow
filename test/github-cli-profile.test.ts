import { afterEach, describe, expect, it, vi } from 'vitest';
import { setGhRunnerForTests } from '../src/server/gh-cli.js';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, type Harness } from './helpers/harness.js';

describe('GitHub CLI profile endpoint', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setGhRunnerForTests();
    await h?.stop();
    h = undefined;
  });

  it('returns the current CLI login and scopes without returning the token or mutating secrets', async () => {
    h = await startHarness({ worker: false });
    const before = await h.api.get('/v1/secrets');
    const token = 'controlled-test-value';
    vi.stubEnv('AZHI_EGRESS_ALLOW', 'api.github.com');
    setGhRunnerForTests(async () => ({ stdout: `${token}\n`, stderr: '' }));
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://api.github.com/user') {
        expect(init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
        return new Response(JSON.stringify({ login: 'octo-profile' }), { headers: { 'x-oauth-scopes': 'repo, read:org' } });
      }
      return fetch(input, init);
    });

    const profile = await h.api.get<{ host: string; login: string | null; scopes: string[] }>('/v1/github/cli-login');
    const viewer = await h.api.post<{ token: string }>('/v1/users', { display_name: 'profile-viewer', role: 'viewer' });
    const viewerProfile = await new ApiClient(h.server.url, viewer.token).get<{ host: string; login: string | null; scopes: string[] }>('/v1/github/cli-login');

    expect(profile).toEqual({ host: 'github.com', login: 'octo-profile', scopes: ['repo', 'read:org'] });
    expect(viewerProfile).toEqual({ host: 'github.com', login: 'octo-profile', scopes: ['repo', 'read:org'] });
    expect(JSON.stringify(profile)).not.toContain(token);
    expect(await h.api.get('/v1/secrets')).toEqual(before);
  });

  it('propagates the actionable unavailable CLI-login error', async () => {
    h = await startHarness({ worker: false });
    setGhRunnerForTests(async () => { throw Object.assign(new Error('exit 1'), { stderr: 'not logged in' }); });

    await expect(h.api.get('/v1/github/cli-login')).rejects.toThrow(/GitHub CLI is not signed in.*gh auth login/);
  });
});
