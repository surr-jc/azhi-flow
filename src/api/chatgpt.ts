import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { resolveSecret, setSecret } from '../server/secrets.js';
import { accountIdOf, chatgptAuth, type ChatgptAuth, type TokenResponse } from '../agents/chatgpt-auth.js';
import { requireRole } from './auth.js';

/**
 * Signing in with a ChatGPT plan (Plus, Pro, Business) for OpenCode steps, from mission control or
 * `azhi chatgpt login`: OpenAI's device sign-in with the client OpenCode's own "ChatGPT Pro/Plus
 * (headless)" login uses, run by the server so the browser never talks to OpenAI. The tokens go
 * straight into a workspace secret (openai-chatgpt-auth by default), stored as OpenCode's auth.json
 * entry `{"openai": {...}}`, and are never shown.
 *
 * OpenAI rotates the refresh token on every refresh, so only Azhi may refresh this sign-in: the
 * server does it when a step fetches the credential (see freshChatgptAuth), saves the new tokens,
 * and hands OpenCode an access token that outlasts the step. Do not reuse the sign-in of your own
 * OpenCode or Codex here; each would invalidate the other's tokens.
 */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_SECRET = 'openai-chatgpt-auth';
const SECRET = /^[A-Za-z0-9._-]+$/;
/**
 * An access token is renewed when it would expire within this long. A step that runs longer than what is
 * left lets OpenCode renew it; the worker then sends the renewed sign-in back (keepRenewedChatgptAuth).
 */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

const store = (a: ChatgptAuth) => JSON.stringify({ openai: a });

function fromTokens(t: TokenResponse, previous?: ChatgptAuth): ChatgptAuth {
  if (!t.access_token || !t.refresh_token) throw new AzhiError(ErrorClass.authorization, 'OpenAI answered the ChatGPT sign-in without tokens');
  const accountId = accountIdOf(t) ?? previous?.accountId;
  return { type: 'oauth', refresh: t.refresh_token, access: t.access_token, expires: Date.now() + (t.expires_in ?? 3600) * 1000, ...(accountId ? { accountId } : {}) };
}

async function post(url: string, init: { json?: Record<string, string>; form?: Record<string, string> }): Promise<{ status: number; body: any }> {
  const r = await fetch(url, {
    method: 'POST',
    headers: init.json ? { 'content-type': 'application/json', 'user-agent': 'azhi-flow' } : { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'azhi-flow' },
    body: init.json ? JSON.stringify(init.json) : new URLSearchParams(init.form).toString(),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => {
    throw new AzhiError(ErrorClass.transient, `could not reach OpenAI for the ChatGPT sign-in: ${(e as Error).message}`);
  });
  const text = await r.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text.slice(0, 200) };
  }
  return { status: r.status, body };
}

const reason = (b: any) => String(b?.error_description ?? b?.error?.message ?? b?.error ?? b?.message ?? 'no reason given').slice(0, 200);

async function refresh(ctx: AppContext, a: ChatgptAuth): Promise<ChatgptAuth> {
  const r = await post(`${ctx.settings.chatgptIssuer}/oauth/token`, { form: { grant_type: 'refresh_token', refresh_token: a.refresh, client_id: CHATGPT_CLIENT_ID } });
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    throw new AzhiError(ErrorClass.authorization, `OpenAI refused to renew the ChatGPT sign-in (${r.status}: ${reason(r.body)}). Sign in again with \`azhi chatgpt login\`. If you also pasted this sign-in into your own OpenCode or Codex, they renew it too and cancel each other out: give Azhi its own sign-in.`);
  }
  if (r.status >= 300) throw new AzhiError(ErrorClass.transient, `OpenAI answered HTTP ${r.status} when renewing the ChatGPT sign-in: ${reason(r.body)}`);
  return fromTokens(r.body, a);
}

/** One renewal per secret at a time: two steps starting together must not both spend the same refresh token. */
const renewing = new Map<string, Promise<string>>();

/**
 * The secret's value as a step should get it: for a ChatGPT sign-in, renewed first when its access
 * token would expire within REFRESH_MARGIN_MS, with the new tokens saved as a new secret version.
 * Any other secret comes back unchanged.
 */
export async function freshChatgptAuth(ctx: AppContext, workspaceId: string, name: string, value: string, force = false): Promise<string> {
  const a = chatgptAuth(value);
  if (!a || (!force && a.access && a.expires > Date.now() + REFRESH_MARGIN_MS)) return value;
  const key = `${workspaceId}/${name}`;
  const running = renewing.get(key);
  if (running) return running;
  const job = (async () => {
    // Another server may have renewed it since this value was read: start from the newest version.
    const latest = (await resolveSecret(ctx, workspaceId, name))?.value ?? value;
    const cur = chatgptAuth(latest) ?? a;
    if (!force && cur.access && cur.expires > Date.now() + REFRESH_MARGIN_MS) return latest;
    const next = store(await refresh(ctx, cur));
    const version = await setSecret(ctx, workspaceId, name, next, 'azhi:chatgpt-refresh');
    await audit(ctx, workspaceId, 'azhi', 'chatgpt.refreshed', { secret: name, version });
    return next;
  })().finally(() => renewing.delete(key));
  renewing.set(key, job);
  return job;
}

/**
 * A sign-in OpenCode renewed during a step, sent back by the worker so the next step does not start from a
 * refresh token OpenAI has already rotated. Kept only when it is a ChatGPT sign-in for the same account
 * and newer than the stored one.
 */
export async function keepRenewedChatgptAuth(ctx: AppContext, workspaceId: string, name: string, value: string, actor: string): Promise<boolean> {
  const next = chatgptAuth(value);
  const cur = await resolveSecret(ctx, workspaceId, name);
  const prev = cur ? chatgptAuth(cur.value) : undefined;
  if (!next || !prev || next.refresh === prev.refresh || next.expires <= prev.expires) return false;
  if (prev.accountId && next.accountId !== prev.accountId) throw new AzhiError(ErrorClass.authorization, 'the renewed sign-in is for a different ChatGPT account');
  const version = await setSecret(ctx, workspaceId, name, store(next), actor);
  await audit(ctx, workspaceId, actor, 'chatgpt.refreshed', { secret: name, version, by: 'opencode' });
  return true;
}

interface Pending {
  workspaceId: string;
  userId: string;
  secret: string;
  deviceAuthId: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  nextPollAt: number;
}

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

export function registerChatgptRoutes(app: FastifyInstance, ctx: AppContext) {
  const pending = new Map<string, Pending>();
  const sweep = () => {
    for (const [id, p] of pending) if (p.expiresAt < Date.now()) pending.delete(id);
  };

  app.post('/v1/chatgpt/login', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ secret: z.string().regex(SECRET).default(CHATGPT_SECRET) }).parse(req.body ?? {});
    sweep();
    const r = await post(`${ctx.settings.chatgptIssuer}/api/accounts/deviceauth/usercode`, { json: { client_id: CHATGPT_CLIENT_ID } });
    if (r.status >= 300 || !r.body?.device_auth_id || !r.body?.user_code) throw new AzhiError(ErrorClass.transient, `OpenAI did not start the ChatGPT sign-in (${r.status}: ${reason(r.body)})`);
    const id = `cgp_${randomBytes(12).toString('hex')}`;
    const interval = Math.max(1, parseInt(String(r.body.interval ?? '5'), 10) || 5);
    const expiresIn = 15 * 60;
    pending.set(id, { workspaceId: p.workspaceId, userId: p.userId, secret: b.secret, deviceAuthId: r.body.device_auth_id, userCode: r.body.user_code, interval, expiresAt: Date.now() + expiresIn * 1000, nextPollAt: 0 });
    return { id, user_code: r.body.user_code as string, verification_uri: `${ctx.settings.chatgptIssuer}/codex/device`, interval, expires_in: expiresIn, secret: b.secret };
  });

  // One check with OpenAI per call; callers poll at `interval`. Calls in between answer pending without asking OpenAI.
  app.post('/v1/chatgpt/login/:id', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const id = (req.params as { id: string }).id;
    const s = pending.get(id);
    if (!s || s.workspaceId !== p.workspaceId || s.userId !== p.userId) return { status: 'expired' };
    if (s.expiresAt < Date.now()) {
      pending.delete(id);
      return { status: 'expired' };
    }
    if (Date.now() < s.nextPollAt) return { status: 'pending', interval: s.interval };
    s.nextPollAt = Date.now() + s.interval * 1000;
    const r = await post(`${ctx.settings.chatgptIssuer}/api/accounts/deviceauth/token`, { json: { device_auth_id: s.deviceAuthId, user_code: s.userCode } });
    // Not yet approved: OpenAI answers 403 or 404 until the person enters the code.
    if (r.status === 403 || r.status === 404) return { status: 'pending', interval: s.interval };
    pending.delete(id);
    if (r.status >= 300 || !r.body?.authorization_code) return { status: 'denied', message: `OpenAI refused the sign-in (${r.status}: ${reason(r.body)})` };
    const t = await post(`${ctx.settings.chatgptIssuer}/oauth/token`, {
      form: { grant_type: 'authorization_code', code: r.body.authorization_code, redirect_uri: `${ctx.settings.chatgptIssuer}/deviceauth/callback`, client_id: CHATGPT_CLIENT_ID, code_verifier: String(r.body.code_verifier ?? '') },
    });
    if (t.status >= 300) return { status: 'denied', message: `OpenAI did not issue tokens (${t.status}: ${reason(t.body)})` };
    const auth = fromTokens(t.body);
    const version = await setSecret(ctx, p.workspaceId, s.secret, store(auth), p.userId);
    await audit(ctx, p.workspaceId, p.userId, 'chatgpt.signed_in', { secret: s.secret, version });
    return { status: 'done', secret: s.secret, version, account: auth.accountId ? 'found' : 'missing' };
  });

  // Is the saved sign-in usable? Renews it once (the same call a step's start makes) and says when it expires.
  app.post('/v1/chatgpt/check', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ secret: z.string().regex(SECRET).default(CHATGPT_SECRET) }).parse(req.body ?? {});
    const s = await resolveSecret(ctx, p.workspaceId, b.secret);
    if (!s) return { ok: false, message: `No sign-in is saved yet (secret ${b.secret}). Sign in with: azhi chatgpt login` };
    if (!chatgptAuth(s.value)) return { ok: false, message: `Secret ${b.secret} is not a ChatGPT sign-in. Sign in with: azhi chatgpt login --secret ${b.secret}` };
    try {
      const a = chatgptAuth(await freshChatgptAuth(ctx, p.workspaceId, b.secret, s.value, true))!;
      return { ok: true, message: `OpenAI renewed the ChatGPT sign-in; it is good until ${new Date(a.expires).toISOString()}${a.accountId ? '' : ', but it names no ChatGPT account, so the Codex endpoint may refuse it'}.` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });
}
