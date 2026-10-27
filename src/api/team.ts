import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { Role } from '../db/schema.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { newApiToken } from '../security/tokens.js';
import { audit } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { authenticate, requireRole } from './auth.js';

/**
 * Team management for mission control (docs/mission-control-plan.md, increment 4).
 *
 * Browser sign-in uses the authorization code flow with PKCE against the configured OIDC issuer.
 * The server does the code exchange (the page's CSP only lets it talk to this origin), keeps the
 * PKCE verifier, state and nonce in a short-lived signed cookie scoped to /v1/auth, and hands the
 * resulting token to the tab in the URL fragment, the same way `azhi open` does. The token is the
 * issuer's own JWT, checked by the same `authenticate` as every other request, so sign-in creates
 * no session the server has to keep.
 *
 * Users: admins invite (by email, claimed on first sign-in), change roles, disable, and issue or
 * revoke API tokens. Nobody changes their own role or disables themselves, the owner is never
 * changed here, and only the owner makes or changes admins. All of it is audited.
 */
const RANK: Record<Role, number> = { viewer: 0, operator: 1, author: 2, admin: 3, owner: 4 };
const COOKIE = 'azhi_sso';
const b64url = (b: Buffer) => b.toString('base64url');

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

/** Paths that answer before anyone is signed in. */
export const isAuthPath = (url: string) => url === '/v1/auth/config' || url.startsWith('/v1/auth/login') || url.startsWith('/v1/auth/callback');

interface Discovery { authorization_endpoint: string; token_endpoint: string }
const discovered = new Map<string, Discovery>();
async function discovery(issuer: string): Promise<Discovery> {
  const hit = discovered.get(issuer);
  if (hit) return hit;
  const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new AzhiError(ErrorClass.internal, `OIDC discovery failed (${res.status})`);
  const d = (await res.json()) as Discovery;
  discovered.set(issuer, d);
  return d;
}

function sign(ctx: AppContext, value: string) {
  return createHmac('sha256', ctx.secretKey).update(`sso:${value}`).digest('base64url');
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function cookie(ctx: AppContext, value: string, maxAge: number) {
  const secure = ctx.settings.publicUrl.startsWith('https:') ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/v1/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function failure(reply: FastifyReply, message: string) {
  return reply
    .status(400)
    .headers({ 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    .type('text/html; charset=utf-8')
    .send(`<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><body style="font:15px system-ui;max-width:560px;margin:15vh auto;padding:16px"><h1>Sign-in failed</h1><p>${escape(message)}</p><p><a href="/ui">Back to Azhi Flow</a></p>`);
}

export function registerTeamRoutes(app: FastifyInstance, ctx: AppContext) {
  const s = ctx.settings;
  const sso = () => Boolean(s.oidcIssuer && s.oidcClientId);
  const redirectUri = () => `${s.publicUrl.replace(/\/$/, '')}/v1/auth/callback`;

  app.get('/v1/auth/config', async () => ({ sso: sso(), issuer: sso() ? s.oidcIssuer : undefined }));

  app.get('/v1/auth/login', async (req, reply) => {
    if (!sso()) return failure(reply, 'Single sign-on is not set up on this server. Sign in with an API token.');
    const { next } = z.object({ next: z.string().optional() }).parse(req.query);
    const d = await discovery(s.oidcIssuer!);
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(16));
    // Only paths inside the app, so the sign-in cannot be used to redirect anywhere else.
    const back = next && /^\/ui(\/[\w\-./%@]*)?(\?[\w\-=&%.@]*)?$/.test(next) ? next : '/ui';
    const payload = b64url(Buffer.from(JSON.stringify({ state, verifier, nonce, next: back, exp: Date.now() + 10 * 60_000 })));
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: s.oidcClientId!,
      redirect_uri: redirectUri(),
      scope: s.oidcScopes,
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return reply.header('set-cookie', cookie(ctx, `${payload}.${sign(ctx, payload)}`, 600)).header('cache-control', 'no-store').redirect(url.toString());
  });

  app.get('/v1/auth/callback', async (req, reply) => {
    reply.header('set-cookie', cookie(ctx, '', 0));
    if (!sso()) return failure(reply, 'Single sign-on is not set up on this server.');
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }).parse(req.query);
    if (q.error) return failure(reply, `The identity provider refused: ${q.error_description ?? q.error}`);
    const raw = readCookie(req, COOKIE) ?? '';
    const [payload, mac] = raw.split('.');
    const expected = payload ? sign(ctx, payload) : '';
    if (!payload || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return failure(reply, 'The sign-in expired or was started in another browser. Try again.');
    const saved = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { state: string; verifier: string; nonce: string; next: string; exp: number };
    if (saved.exp < Date.now() || !q.state || q.state !== saved.state || !q.code) return failure(reply, 'The sign-in expired or did not match. Try again.');

    const d = await discovery(s.oidcIssuer!);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: redirectUri(), client_id: s.oidcClientId!, code_verifier: saved.verifier });
    if (s.oidcClientSecret) form.set('client_secret', s.oidcClientSecret);
    const res = await fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form });
    if (!res.ok) return failure(reply, `The identity provider did not issue a token (${res.status}).`);
    const tokens = (await res.json()) as { access_token?: string; id_token?: string };
    if (tokens.id_token) {
      try {
        if (decodeJwt(tokens.id_token).nonce !== saved.nonce) return failure(reply, 'The sign-in did not match (nonce). Try again.');
      } catch {
        return failure(reply, 'The identity provider returned an unreadable ID token.');
      }
    }
    // The access token when it is a JWT for this API, otherwise the ID token; whichever the
    // server accepts, through the same check every request gets.
    for (const t of [tokens.access_token, tokens.id_token]) {
      if (!t || t.split('.').length !== 3) continue;
      let p;
      try {
        p = await authenticate(ctx, `Bearer ${t}`);
      } catch (e) {
        if (/disabled/.test((e as Error).message)) return failure(reply, 'Your user is disabled in this workspace. Ask an admin.');
        continue;
      }
      if (p.kind !== 'user') continue;
      await audit(ctx, p.workspaceId, p.userId, 'user.signed_in', { via: 'oidc' });
      return reply.header('cache-control', 'no-store').redirect(`${saved.next}#token=${encodeURIComponent(t)}`);
    }
    return failure(reply, 'The token from the identity provider is not accepted by this server (check AZHI_OIDC_AUDIENCE).');
  });

  // Users
  const target = async (workspaceId: string, id: string) => {
    const u = (await ctx.pool.query(`SELECT id, role, email, disabled_at FROM users WHERE id=$1 AND workspace_id=$2`, [id, workspaceId])).rows[0];
    if (!u) throw new AzhiError(ErrorClass.invalidInput, 'user not found');
    return u as { id: string; role: Role; email: string | null; disabled_at: Date | null };
  };
  /** Who may manage whom: admins manage roles below admin; only the owner manages admins; nobody manages the owner. */
  const mayManage = (actor: { role: Role; userId: string }, t: { id: string; role: Role }, newRole?: Role) => {
    if (t.role === 'owner') throw new AzhiError(ErrorClass.authorization, 'the owner cannot be changed here');
    if ((t.role === 'admin' || newRole === 'admin') && actor.role !== 'owner') throw new AzhiError(ErrorClass.authorization, 'only the owner can make or change admins');
    if (newRole && RANK[newRole] >= RANK.owner) throw new AzhiError(ErrorClass.authorization, 'there is one owner per workspace');
  };

  app.patch('/v1/users/:id', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z
      .object({
        role: z.enum(['admin', 'author', 'operator', 'viewer']).optional(),
        disabled: z.boolean().optional(),
        display_name: z.string().min(1).max(120).optional(),
        email: z.string().email().nullable().optional(),
        slack_user_id: z.string().regex(/^[UW][A-Z0-9]{2,}$/).nullable().optional(),
      })
      .parse(req.body);
    const t = await target(p.workspaceId, (req.params as { id: string }).id);
    const self = t.id === p.userId;
    if (self && (b.role !== undefined || b.disabled !== undefined)) throw new AzhiError(ErrorClass.authorization, 'you cannot change your own role or disable yourself');
    if (!(self && b.role === undefined && b.disabled === undefined)) mayManage(p, t, b.role);
    await ctx.pool.query(
      `UPDATE users SET role=COALESCE($3, role),
         disabled_at=CASE WHEN $4::boolean IS NULL THEN disabled_at WHEN $4 THEN COALESCE(disabled_at, now()) ELSE NULL END,
         display_name=COALESCE($5, display_name),
         email=CASE WHEN $6::boolean THEN $7 ELSE email END,
         slack_user_id=CASE WHEN $8::boolean THEN $9 ELSE slack_user_id END
       WHERE id=$1 AND workspace_id=$2`,
      [t.id, p.workspaceId, b.role ?? null, b.disabled ?? null, b.display_name ?? null, b.email !== undefined, b.email ?? null, b.slack_user_id !== undefined, b.slack_user_id ?? null],
    ).catch((e) => {
      if ((e as { code?: string }).code === '23505') throw new AzhiError(ErrorClass.invalidInput, 'another user already has that Slack user');
      throw e;
    });
    await audit(ctx, p.workspaceId, p.userId, 'user.changed', { user: t.id, ...b });
    return (await ctx.pool.query(`SELECT id, display_name, email, role, disabled_at, slack_user_id FROM users WHERE id=$1`, [t.id])).rows[0];
  });

  app.post('/v1/users/:id/tokens', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const { name } = z.object({ name: z.string().min(1).max(80).default('mission control') }).parse(req.body ?? {});
    const t = await target(p.workspaceId, (req.params as { id: string }).id);
    if (t.id !== p.userId) mayManage(p, t);
    if (t.disabled_at) throw new AzhiError(ErrorClass.invalidInput, 'enable the user first');
    const tok = newApiToken();
    await ctx.pool.query(`INSERT INTO api_tokens(id, workspace_id, user_id, name, token_hash) VALUES ($1,$2,$3,$4,$5)`, [newId('tok'), p.workspaceId, t.id, name, tok.hash]);
    await audit(ctx, p.workspaceId, p.userId, 'user.token_created', { user: t.id, name });
    return { token: tok.token };
  });

  app.delete('/v1/users/:id/tokens', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const t = await target(p.workspaceId, (req.params as { id: string }).id);
    if (t.id === p.userId) throw new AzhiError(ErrorClass.authorization, 'revoke your own tokens with another admin, so you are not locked out');
    mayManage(p, t);
    const r = await ctx.pool.query(`UPDATE api_tokens SET revoked_at=now() WHERE user_id=$1 AND workspace_id=$2 AND revoked_at IS NULL`, [t.id, p.workspaceId]);
    await audit(ctx, p.workspaceId, p.userId, 'user.tokens_revoked', { user: t.id, count: r.rowCount });
    return { revoked: r.rowCount };
  });
}
