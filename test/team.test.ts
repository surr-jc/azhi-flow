import { createHash, createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { chromium, type Browser } from 'playwright-core';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * Team features of mission control (docs/mission-control-plan.md, increment 4): browser sign-in
 * with OIDC (authorization code + PKCE, exchanged by the server), invitations claimed by verified
 * email, user and role management with its guard rails, and approvals decided from Slack buttons
 * by linked Slack users with their own role.
 */
const CHROMIUM = process.env.AZHI_CHROMIUM ?? '/opt/pw-browsers/chromium';
const up = await temporalAvailable();

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A tiny OIDC provider: discovery, authorize (signs in `who` at once), token with PKCE, JWKS. */
async function startIdp(who: { sub: string; email: string; name: string }) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; nonce: string; client: string; redirect: string }>();
  const tokenRequests: Array<Record<string, string>> = [];
  let issuer = '';
  const jwt = (claims: Record<string, unknown>, aud: string, sub = who.sub) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (b: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (url.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('code_challenge_method') !== 'S256' || q.get('response_type') !== 'code') return json({ error: 'invalid_request' }, 400);
      const code = `code-${codes.size + 1}`;
      codes.set(code, { challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, client: q.get('client_id')!, redirect: q.get('redirect_uri')! });
      res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state')!)}` });
      return res.end();
    }
    if (url.pathname === '/token') {
      let raw = '';
      for await (const c of req) raw += c;
      const f = Object.fromEntries(new URLSearchParams(raw));
      tokenRequests.push(f);
      const c = codes.get(f.code!);
      codes.delete(f.code!);
      if (!c || f.redirect_uri !== c.redirect || f.client_id !== c.client) return json({ error: 'invalid_grant' }, 400);
      if (createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
      return json({
        token_type: 'Bearer',
        access_token: await jwt({ email: who.email, email_verified: true, name: who.name }, 'azhi-api'),
        id_token: await jwt({ email: who.email, email_verified: true, name: who.name, nonce: c.nonce }, c.client),
      });
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return { issuer, tokenRequests, jwt, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe.skipIf(!up)('team', () => {
  let h: Harness;
  let browser: Browser;
  let idp: Awaited<ReturnType<typeof startIdp>>;
  let token: string;
  const errors: string[] = [];

  beforeAll(async () => {
    if (!existsSync('src/web/dist/index.html') || process.env.AZHI_BUILD_WEB) execSync('npm run build:web', { stdio: 'ignore' });
    idp = await startIdp({ sub: 'idp|asha', email: 'asha@example.com', name: 'Asha' });
    const port = await freePort();
    h = await startHarness({ settings: { port, publicUrl: `http://127.0.0.1:${port}`, oidcIssuer: idp.issuer, oidcAudience: 'azhi-api', oidcClientId: 'mission-control' } });
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    token = readFileSync(h.server.localTokenFile!, 'utf8').trim();
    browser = await chromium.launch({ executablePath: CHROMIUM });
  });
  afterAll(async () => {
    await browser?.close();
    await h?.stop();
    await idp?.close();
  });

  it('signs in with single sign-on, claiming an invitation by verified email', async () => {
    const invite = await h.api.post<any>('/v1/users', { display_name: 'Asha', email: 'ASHA@example.com', role: 'author', token: false });
    expect(invite.token).toBeUndefined();

    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${h.server.url}/ui/runs`);
    await page.getByRole('link', { name: 'Sign in with single sign-on' }).click();
    await page.waitForURL(`${h.server.url}/ui/runs`);
    await page.getByRole('heading', { name: 'Runs' }).waitFor();
    expect(idp.tokenRequests.at(-1)).toMatchObject({ grant_type: 'authorization_code', client_id: 'mission-control', code_verifier: expect.stringMatching(/^[\w-]{43}$/) });
    // The token stays in the tab, not in the address bar or a cookie.
    expect(page.url()).not.toContain('token');
    expect((await page.context().cookies()).map((c) => c.name)).not.toContain('azhi_sso');
    const held = await page.evaluate(() => sessionStorage.getItem('azhi-token'));
    const me = await new ApiClient(h.server.url, held!).get<any>('/v1/me');
    expect(me).toMatchObject({ kind: 'user', userId: invite.id, role: 'author' });
    expect((await h.api.get<any[]>('/v1/users')).find((u) => u.id === invite.id)).toMatchObject({ sso: true, tokens: 0 });
    expect((await h.api.get<any[]>('/v1/audit')).some((e) => e.kind === 'user.signed_in' && e.actor === invite.id)).toBe(true);
    await page.close();

    // Someone not invited starts as a viewer (the workspace already has an owner).
    const stranger = await idp.jwt({ email: 'eve@example.com', email_verified: true }, 'azhi-api', 'idp|eve');
    expect(await new ApiClient(h.server.url, stranger).get('/v1/me')).toMatchObject({ kind: 'user', role: 'viewer' });
  });

  it('refuses a callback whose state does not match the signed cookie', async () => {
    const res = await fetch(`${h.server.url}/v1/auth/callback?code=x&state=forged`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Sign-in failed');
    const login = await fetch(`${h.server.url}/v1/auth/login?next=https://evil.example/`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const sso = login.headers.get('set-cookie')!.match(/azhi_sso=([^;]+)/)![1]!;
    expect(JSON.parse(Buffer.from(sso.split('.')[0]!, 'base64url').toString()).next).toBe('/ui');
  });

  it('manages users and roles with guard rails, from the browser', async () => {
    const op = await h.api.post<any>('/v1/users', { display_name: 'Ravi', role: 'operator' });
    const adminUser = await h.api.post<any>('/v1/users', { display_name: 'Meena', role: 'admin' });
    const admin = new ApiClient(h.server.url, adminUser.token);
    await expect(admin.post('/v1/users', { display_name: 'x', role: 'admin' })).rejects.toThrow(/only the owner/);
    await expect(admin.patch(`/v1/users/${adminUser.id}`, { role: 'viewer' })).rejects.toThrow(/your own role/);
    await expect(admin.patch(`/v1/users/usr_local`, { role: 'viewer' })).rejects.toThrow(/owner cannot be changed/);
    await expect(new ApiClient(h.server.url, op.token).patch(`/v1/users/${adminUser.id}`, { role: 'viewer' })).rejects.toThrow(/admin/);

    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`${h.server.url}/ui/users#token=${encodeURIComponent(token)}`);
    await page.getByLabel('Role of Ravi').selectOption('author');
    for (let i = 0; i < 50 && (await h.api.get<any[]>('/v1/users')).find((u) => u.id === op.id).role !== 'author'; i++) await page.waitForTimeout(100);
    expect((await h.api.get<any[]>('/v1/users')).find((u) => u.id === op.id).role).toBe('author');

    const row = page.getByRole('row', { name: /Ravi/ });
    await row.getByRole('button', { name: 'New token' }).click();
    const fresh = await page.getByLabel('New API token').innerText();
    expect((await new ApiClient(h.server.url, fresh).get<any>('/v1/me')).userId).toBe(op.id);

    await row.getByRole('button', { name: 'Disable' }).click();
    await row.getByText('disabled').waitFor();
    await expect(new ApiClient(h.server.url, op.token).get('/v1/me')).rejects.toThrow(/invalid API token/);
    await row.getByRole('button', { name: 'Enable' }).click();
    await row.getByRole('button', { name: 'Disable' }).waitFor();
    await row.getByRole('button', { name: 'Revoke tokens' }).click();
    await expect(new ApiClient(h.server.url, fresh).get('/v1/me')).rejects.toThrow(/invalid API token/);

    await page.getByLabel('Slack user of Ravi').fill('U0RAVI');
    await row.getByRole('button', { name: 'Save' }).click();
    for (let i = 0; i < 50 && !(await h.api.get<any[]>('/v1/users')).find((u) => u.id === op.id).slack_user_id; i++) await page.waitForTimeout(100);
    expect((await h.api.get<any[]>('/v1/users')).find((u) => u.id === op.id).slack_user_id).toBe('U0RAVI');
    const kinds = (await h.api.get<any[]>('/v1/audit')).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['user.changed', 'user.token_created', 'user.tokens_revoked']));
    await page.close();
  });

  it('posts a waiting approval to Slack and takes the decision from a linked Slack user', async () => {
    await h.api.put('/v1/secrets/slack-signing-secret', { value: 'shh-signing' });
    await h.api.put('/v1/settings/approvals', { slack_channel: 'C-APPROVALS' });
    const version = (await uploadDir(h.api, 'test/fixtures/approval')).version.id;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team: 'payments' } });
    let msg: any;
    for (let i = 0; i < 150 && !msg; i++) {
      msg = h.slack.messages.find((m) => m.channel === 'C-APPROVALS' && JSON.stringify(m.blocks ?? '').includes(run_id));
      if (!msg) await new Promise((r) => setTimeout(r, 200));
    }
    expect(msg.text).toBe('Approval needed on approval-check (approve)');
    const value = (msg.blocks as any[]).find((b) => b.type === 'actions').elements[0].value;

    const click = async (slackUser: string, action: 'approve' | 'reject', secret = 'shh-signing') => {
      const payload = JSON.stringify({ type: 'block_actions', user: { id: slackUser }, actions: [{ action_id: action, value }], response_url: `${h.slack.url}/response/${h.slack.responses.length}` });
      const body = `payload=${encodeURIComponent(payload)}`;
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
      return fetch(`${h.server.url}/v1/slack/interactions`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body });
    };
    expect((await click('U0RAVI', 'approve', 'wrong')).status).toBe(401);

    expect((await click('U0NOBODY', 'approve')).status).toBe(200);
    expect(h.slack.responses.at(-1)).toMatchObject({ response_type: 'ephemeral', text: expect.stringContaining('not linked') });

    expect((await click('U0RAVI', 'approve')).status).toBe(200);
    expect(h.slack.responses.at(-1)).toMatchObject({ replace_original: true, text: expect.stringContaining('Approved by <@U0RAVI>') });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.state).toBe('succeeded');
    const ravi = (await h.api.get<any[]>('/v1/users')).find((u) => u.slack_user_id === 'U0RAVI');
    expect(d.approvals[0]).toMatchObject({ decision: 'approved', decided_by: ravi.id });
    expect((await h.api.get<any[]>('/v1/audit')).find((e) => e.kind === 'approval.submitted' && e.data.run === run_id)).toMatchObject({ actor: ravi.id, data: { via: 'slack' } });

    // A second click is refused: the first decision stands.
    await click('U0RAVI', 'reject');
    expect(h.slack.responses.at(-1)).toMatchObject({ response_type: 'ephemeral', text: expect.stringContaining('already decided') });
    expect(errors).toEqual([]);
  });
});
