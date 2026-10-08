import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRepoAccess } from '../src/gateway/tools/github.js';
import { startFakeGithub } from '../src/testing/fake-github.js';

process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
const empty = { runs: [], issues: [] };

describe('checking a token against a repository', () => {
  const servers: Array<{ stop(): Promise<void> }> = [];
  afterAll(async () => void (await Promise.all(servers.map((s) => s.stop()))));
  const start = async (opts: Parameters<typeof startFakeGithub>[1]) => {
    const g = await startFakeGithub(empty, opts);
    servers.push(g);
    return g;
  };
  let tokenless: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => void (tokenless = await start({ token: 'good' })));

  it('accepts a token that can read and change the repository', async () => {
    const g = await start({ token: 'good', scopes: 'repo', repos: { 'acme/payments': { private: true, permissions: { pull: true, push: true } } } });
    const r = await checkRepoAccess({ api_url: g.url }, 'good', 'acme/payments', 'write');
    expect(r).toMatchObject({ ok: true, status: 'ok', token_kind: 'classic', scopes: ['repo'] });
  });

  it('says a wrong token is wrong', async () => {
    const r = await checkRepoAccess({ api_url: tokenless.url }, 'bad', 'acme/payments', 'read');
    expect(r).toMatchObject({ ok: false, status: 'unauthorized' });
    expect(await checkRepoAccess({ api_url: tokenless.url }, undefined, 'acme/payments', 'read')).toMatchObject({ ok: false, status: 'unauthorized', message: expect.stringContaining('No token') });
  });

  it('names the repository access when GitHub cannot find it for this token', async () => {
    const g = await start({ token: 'github_pat_x', repos: { 'acme/payments': {} } });
    const r = await checkRepoAccess({ api_url: g.url }, 'github_pat_x', 'acme/secret', 'read');
    expect(r).toMatchObject({ ok: false, status: 'not_found', token_kind: 'fine-grained' });
    expect(r.fix).toContain('resource owner');
  });

  it('flags a token that can read but not change', async () => {
    const g = await start({ token: 'good', repos: { 'acme/ledger': { permissions: { pull: true, push: false } } } });
    const r = await checkRepoAccess({ api_url: g.url }, 'good', 'acme/ledger', 'write');
    expect(r).toMatchObject({ ok: false, status: 'insufficient' });
    expect(r.message).toContain('not change');
    expect(await checkRepoAccess({ api_url: g.url }, 'good', 'acme/ledger', 'read')).toMatchObject({ ok: true });
  });

  it('flags a classic token without the repo scope for a private repository', async () => {
    const g = await start({ token: 'ghp_abc', scopes: 'read:org, gist', repos: { 'acme/payments': { private: true } } });
    const r = await checkRepoAccess({ api_url: g.url }, 'ghp_abc', 'acme/payments', 'read');
    expect(r).toMatchObject({ ok: false, status: 'insufficient', token_kind: 'classic' });
    expect(r.message).toContain('read:org, gist');
    expect(r.fix).toContain('repo');
  });

  it('accepts public_repo for a public repository, and warns for fine-grained tokens', async () => {
    const g = await start({ token: 'ghp_abc', scopes: 'public_repo', repos: { 'acme/open': { private: false, permissions: { push: true } } } });
    expect(await checkRepoAccess({ api_url: g.url }, 'ghp_abc', 'acme/open', 'write')).toMatchObject({ ok: true });
    const f = await start({ token: 'github_pat_z', repos: { 'acme/payments': { private: true, permissions: { push: true } } } });
    const w = await checkRepoAccess({ api_url: f.url }, 'github_pat_z', 'acme/payments', 'write');
    expect(w).toMatchObject({ ok: true, token_kind: 'fine-grained' });
    expect(w.warning).toContain('Pull requests');
  });

  it('reports an unreachable GitHub', async () => {
    const r = await checkRepoAccess({ api_url: 'http://127.0.0.1:1' }, 'good', 'acme/payments', 'read', 2000);
    expect(r).toMatchObject({ ok: false, status: 'error' });
  });
});
