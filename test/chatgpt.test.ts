import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatgptAuth } from '../src/agents/chatgpt-auth.js';
import { isClaudePlanToken } from '../src/executors/capabilities.js';
import { resolveSecret } from '../src/server/secrets.js';
import { signRunToken } from '../src/security/tokens.js';
import { ApiClient } from '../src/worker/api-client.js';
import { keepRenewedSignIn } from '../src/worker/harness-activity.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness, temporalAvailable, type Harness } from './helpers/harness.js';

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** OpenAI's sign-in server as OpenCode's ChatGPT login uses it: device code, token exchange, rotating refresh tokens. */
async function startFakeIssuer() {
  const s = { approved: false, refresh: 'rt_1', n: 1, refreshes: 0, calls: [] as string[], expiresIn: 3 * 3600 };
  const issue = () => {
    s.refresh = `rt_${++s.n}`;
    return { id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' } }), access_token: `at_${s.n}`, refresh_token: s.refresh, expires_in: s.expiresIn };
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      s.calls.push(`${req.method} ${req.url}`);
      const send = (status: number, j: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(j));
      };
      if (req.url === '/api/accounts/deviceauth/usercode') {
        if (JSON.parse(body).client_id !== 'app_EMoamEEZ73f0CkXaXp7hrann') return send(400, { error: 'bad client' });
        return send(200, { device_auth_id: 'dev_1', user_code: 'ABCD-1234', interval: '1' });
      }
      if (req.url === '/api/accounts/deviceauth/token') return s.approved ? send(200, { authorization_code: 'code_1', code_verifier: 'ver_1' }) : send(403, { error: 'pending' });
      if (req.url === '/oauth/token') {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'authorization_code') return f.get('code') === 'code_1' && f.get('code_verifier') === 'ver_1' ? send(200, issue()) : send(400, { error: 'invalid_grant' });
        if (f.get('grant_type') === 'refresh_token') {
          s.refreshes++;
          // A refresh token works once: OpenAI rotates it.
          if (f.get('refresh_token') !== s.refresh) return send(401, { error: 'invalid_grant', error_description: 'refresh token already used' });
          return send(200, issue());
        }
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address() as { port: number };
  return { url: `http://127.0.0.1:${a.port}`, state: s, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('plan tokens', () => {
  it('knows a Claude plan token from an API key', () => {
    expect(isClaudePlanToken(' sk-ant-oat01-abc')).toBe(true);
    expect(isClaudePlanToken('sk-ant-api03-abc')).toBe(false);
  });

  it('reads a ChatGPT sign-in from Azhi\'s secret or OpenCode\'s auth.json, and nothing else', () => {
    const entry = { type: 'oauth', refresh: 'rt', access: 'at', expires: 5, accountId: 'acct' };
    expect(chatgptAuth(JSON.stringify({ openai: entry, 'github-copilot': { type: 'oauth', refresh: 'x' } }))).toEqual(entry);
    expect(chatgptAuth(JSON.stringify({ openai: { type: 'api', key: 'sk-x' } }))).toBeUndefined();
    expect(chatgptAuth(JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: 'x' } }))).toBeUndefined();
    expect(chatgptAuth('sk-proj-abc')).toBeUndefined();
  });
});

const up = await temporalAvailable();

describe.skipIf(!up)('ChatGPT plan sign-in', () => {
  let h: Harness;
  let issuer: Awaited<ReturnType<typeof startFakeIssuer>>;
  let ws: string;

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    h = await startHarness({ worker: false, settings: { chatgptIssuer: issuer.url } });
    ws = (await h.server.ctx.pool.query(`SELECT workspace_id FROM secrets WHERE name='slack-bot-token'`)).rows[0].workspace_id;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
    await issuer?.close();
  });

  const runApi = (creds: string[]) => new ApiClient(h.server.url, signRunToken(h.server.ctx.secretKey, { ws, run: 'run_1', node: 'n1', tools: [], creds, exp: Math.floor(Date.now() / 1000) + 600 }));

  it('signs in with the device code and stores OpenCode\'s auth entry as the secret', async () => {
    const l = await h.api.post<any>('/v1/chatgpt/login', {});
    expect(l).toMatchObject({ user_code: 'ABCD-1234', verification_uri: `${issuer.url}/codex/device`, secret: 'openai-chatgpt-auth' });
    expect(JSON.stringify(l)).not.toContain('dev_1');
    expect((await h.api.post<any>(`/v1/chatgpt/login/${l.id}`, {})).status).toBe('pending');
    issuer.state.approved = true;
    await new Promise((r) => setTimeout(r, 1100));
    const done = await h.api.post<any>(`/v1/chatgpt/login/${l.id}`, {});
    expect(done).toEqual({ status: 'done', secret: 'openai-chatgpt-auth', version: 1, account: 'found' });
    const a = chatgptAuth((await resolveSecret(h.server.ctx, ws, 'openai-chatgpt-auth'))!.value)!;
    expect(a).toMatchObject({ type: 'oauth', refresh: 'rt_2', access: 'at_2', accountId: 'acct_123' });
    expect((await h.api.post<any>(`/v1/chatgpt/login/${l.id}`, {})).status).toBe('expired');
    const u = await h.api.post<{ token: string }>('/v1/users', { display_name: 'author-cg', role: 'author' });
    await expect(new ApiClient(h.server.url, u.token).post('/v1/chatgpt/login', {})).rejects.toThrow(/admin/);
  });

  it('renews a sign-in about to expire when a step fetches it, once for steps starting together, and keeps the new tokens', async () => {
    // Fresh enough: handed out as stored, no call to OpenAI.
    const before = issuer.state.refreshes;
    const fresh = await runApi(['openai-chatgpt-auth']).get<{ value: string }>('/v1/gateway/credentials/openai-chatgpt-auth');
    expect(chatgptAuth(fresh.value)!.access).toBe('at_2');
    // Expiring within the step: two steps start together; OpenAI is asked once and both get the new token.
    await h.api.put('/v1/secrets/openai-chatgpt-auth', { value: JSON.stringify({ openai: { ...chatgptAuth(fresh.value), expires: Date.now() + 60_000 } }) });
    const [x, y] = await Promise.all([0, 1].map(() => runApi(['openai-chatgpt-auth']).get<{ value: string }>('/v1/gateway/credentials/openai-chatgpt-auth')));
    expect(issuer.state.refreshes).toBe(before + 1);
    expect(chatgptAuth(x!.value)).toMatchObject({ access: 'at_3', refresh: 'rt_3', accountId: 'acct_123' });
    expect(y!.value).toBe(x!.value);
    expect(chatgptAuth(x!.value)!.expires).toBeGreaterThan(Date.now() + 3_000_000);
    expect(chatgptAuth((await resolveSecret(h.server.ctx, ws, 'openai-chatgpt-auth'))!.value)!.refresh).toBe('rt_3');
    // Other secrets are not touched.
    await h.api.put('/v1/secrets/plain-key', { value: 'sk-plain' });
    expect((await runApi(['plain-key']).get<{ value: string }>('/v1/gateway/credentials/plain-key')).value).toBe('sk-plain');
  });

  it('keeps a sign-in OpenCode renewed during a long step, and only a newer one for the same account', async () => {
    const stored = chatgptAuth((await resolveSecret(h.server.ctx, ws, 'openai-chatgpt-auth'))!.value)!;
    const home = mkdtempSync(join(tmpdir(), 'azhi-cg-home-'));
    // No renewal in the step: nothing is sent.
    await keepRenewedSignIn(runApi(['openai-chatgpt-auth']), 'openai-chatgpt-auth', home, stored);
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    const renewed = { ...stored, refresh: 'rt_opencode', access: 'at_opencode', expires: stored.expires + 1000 };
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ openai: renewed }));
    await keepRenewedSignIn(runApi(['openai-chatgpt-auth']), 'openai-chatgpt-auth', home, stored);
    expect(chatgptAuth((await resolveSecret(h.server.ctx, ws, 'openai-chatgpt-auth'))!.value)).toEqual(renewed);
    // Older, another account, or a credential the token may not touch: refused.
    expect((await runApi(['openai-chatgpt-auth']).post<any>('/v1/gateway/credentials/openai-chatgpt-auth/renewed', { value: JSON.stringify({ openai: { ...renewed, refresh: 'rt_old', expires: 1 } }) })).kept).toBe(false);
    await expect(runApi(['openai-chatgpt-auth']).post('/v1/gateway/credentials/openai-chatgpt-auth/renewed', { value: JSON.stringify({ openai: { ...renewed, refresh: 'rt_x', expires: renewed.expires + 5, accountId: 'acct_other' } }) })).rejects.toThrow(/different ChatGPT account/);
    await expect(runApi(['plain-key']).post('/v1/gateway/credentials/openai-chatgpt-auth/renewed', { value: '{}' })).rejects.toThrow(/may not update/);
    expect(chatgptAuth((await resolveSecret(h.server.ctx, ws, 'openai-chatgpt-auth'))!.value)!.refresh).toBe('rt_opencode');
    issuer.state.refresh = 'rt_opencode';
  });

  it('checks the sign-in by renewing it, and says what to do when OpenAI refuses it', async () => {
    const ok = await h.api.post<any>('/v1/chatgpt/check', {});
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain('renewed');
    // Used elsewhere (say, pasted into your own OpenCode, which renewed it): the stored refresh token is dead.
    issuer.state.refresh = 'rt_elsewhere';
    const bad = await h.api.post<any>('/v1/chatgpt/check', {});
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/OpenAI refused to renew the ChatGPT sign-in \(401: refresh token already used\)/);
    expect(bad.message).toContain('azhi chatgpt login');
    expect(JSON.stringify(bad)).not.toMatch(/rt_\d/);
    await h.api.put('/v1/secrets/not-chatgpt', { value: 'sk-x' });
    expect((await h.api.post<any>('/v1/chatgpt/check', { secret: 'not-chatgpt' })).message).toContain('not a ChatGPT sign-in');
    expect((await h.api.post<any>('/v1/chatgpt/check', { secret: 'nothing-here' })).message).toContain('No sign-in is saved');
  });
});
