import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { resolveSecret, setSecret } from '../server/secrets.js';
import { requireRole } from './auth.js';

/**
 * Signing in to GitHub Copilot for OpenCode steps, from mission control or `azhi copilot login`:
 * GitHub's device flow with OpenCode's own OAuth app (the client OpenCode's `auth login` uses, so
 * Copilot accepts the token from OpenCode), run by the server so the browser never talks to GitHub.
 * The person opens the GitHub page and types the code; the token GitHub returns goes straight into a
 * workspace secret (github-copilot-token by default) and is never shown. Pending sign-ins live in
 * this server's memory for the code's lifetime.
 */
const OPENCODE_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const SECRET = /^[A-Za-z0-9._-]+$/;

interface Pending {
  workspaceId: string;
  userId: string;
  secret: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
  nextPollAt: number;
}

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

async function github(ctx: AppContext, path: string, body: Record<string, string>): Promise<Record<string, any>> {
  const r = await fetch(`${ctx.settings.copilotGithubUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'azhi-flow' },
    body: JSON.stringify(body),
  }).catch((e) => {
    throw new AzhiError(ErrorClass.transient, `could not reach GitHub for the Copilot sign-in: ${(e as Error).message}`);
  });
  if (!r.ok) throw new AzhiError(ErrorClass.transient, `GitHub answered HTTP ${r.status} to the Copilot sign-in`);
  return (await r.json()) as Record<string, any>;
}

/** GitHub's REST API for the sign-in's host: api.github.com, or <host>/api/v3 on GitHub Enterprise. */
function apiBase(githubUrl: string): string {
  const u = new URL(githubUrl);
  return u.hostname === 'github.com' ? 'https://api.github.com' : `${githubUrl.replace(/\/$/, '')}/api/v3`;
}

/** The stored token as Copilot sees it (the same request Copilot's editor plugins make to start a session). */
export async function checkCopilotToken(ctx: AppContext, token: string): Promise<{ ok: boolean; message: string; plan?: string; chat?: boolean }> {
  const r = await fetch(`${apiBase(ctx.settings.copilotGithubUrl)}/copilot_internal/v2/token`, {
    headers: { accept: 'application/json', authorization: `token ${token}`, 'user-agent': 'azhi-flow' },
  }).catch((e) => {
    throw new AzhiError(ErrorClass.transient, `could not reach GitHub to check the sign-in: ${(e as Error).message}`);
  });
  if (r.ok) {
    const j = (await r.json().catch(() => ({}))) as { sku?: string; chat_enabled?: boolean };
    if (j.chat_enabled === false) return { ok: false, plan: j.sku, chat: false, message: 'Signed in, but Copilot Chat is turned off for this account (an organization policy). Ask your Copilot administrator to enable Copilot Chat, or use another account.' };
    return { ok: true, plan: j.sku, chat: true, message: `GitHub accepts this sign-in and gives it Copilot access${j.sku ? ` (plan: ${j.sku})` : ''}.` };
  }
  if (r.status === 401) return { ok: false, message: 'GitHub rejects the stored token (401): it is revoked, expired or not a GitHub sign-in. Sign in again (azhi copilot login, or Sign in with GitHub Copilot on the Examples page); do not paste a token by hand.' };
  if (r.status === 403 || r.status === 404) {
    return {
      ok: false,
      message: `GitHub accepts the token but gives it no Copilot access (${r.status}). Either the GitHub account you signed in with has no Copilot seat (check github.com/settings/copilot while signed in as it), or its organization restricts OAuth apps or requires SSO: ask an organization owner to approve the "opencode" OAuth app (Organization settings > Third-party Access) and sign in again.`,
    };
  }
  return { ok: false, message: `GitHub answered HTTP ${r.status} to the Copilot check; try again.` };
}

export function registerCopilotRoutes(app: FastifyInstance, ctx: AppContext) {
  const pending = new Map<string, Pending>();
  const sweep = () => {
    for (const [id, p] of pending) if (p.expiresAt < Date.now()) pending.delete(id);
  };

  app.post('/v1/copilot/check', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ secret: z.string().regex(SECRET).default('github-copilot-token') }).parse(req.body ?? {});
    const s = await resolveSecret(ctx, p.workspaceId, b.secret);
    if (!s) return { ok: false, message: `No sign-in is saved yet (secret ${b.secret}). Sign in with GitHub Copilot first.` };
    return checkCopilotToken(ctx, s.value.trim().startsWith('{') ? (JSON.parse(s.value)['github-copilot']?.refresh ?? JSON.parse(s.value).refresh ?? s.value) : s.value.trim());
  });

  app.post('/v1/copilot/login', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ secret: z.string().regex(SECRET).default('github-copilot-token') }).parse(req.body ?? {});
    sweep();
    const d = await github(ctx, '/login/device/code', { client_id: OPENCODE_CLIENT_ID, scope: 'read:user' });
    if (!d.device_code || !d.user_code) throw new AzhiError(ErrorClass.transient, 'GitHub did not start the Copilot sign-in');
    const id = `cpl_${randomBytes(12).toString('hex')}`;
    const interval = Math.max(1, Number(d.interval ?? 5));
    pending.set(id, { workspaceId: p.workspaceId, userId: p.userId, secret: b.secret, deviceCode: d.device_code, interval, expiresAt: Date.now() + Number(d.expires_in ?? 900) * 1000, nextPollAt: 0 });
    return { id, user_code: d.user_code as string, verification_uri: (d.verification_uri as string) ?? 'https://github.com/login/device', interval, expires_in: Number(d.expires_in ?? 900), secret: b.secret };
  });

  // One check with GitHub per call; callers poll at `interval`. Calls in between answer pending without asking GitHub.
  app.post('/v1/copilot/login/:id', async (req) => {
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
    const t = await github(ctx, '/login/oauth/access_token', { client_id: OPENCODE_CLIENT_ID, device_code: s.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (typeof t.access_token === 'string' && t.access_token) {
      pending.delete(id);
      const version = await setSecret(ctx, p.workspaceId, s.secret, t.access_token, p.userId);
      await audit(ctx, p.workspaceId, p.userId, 'copilot.signed_in', { secret: s.secret, version });
      return { status: 'done', secret: s.secret, version };
    }
    if (t.error === 'authorization_pending') return { status: 'pending', interval: s.interval };
    if (t.error === 'slow_down') {
      s.interval = Number(t.interval ?? s.interval + 5);
      s.nextPollAt = Date.now() + s.interval * 1000;
      return { status: 'pending', interval: s.interval };
    }
    pending.delete(id);
    return { status: t.error === 'expired_token' ? 'expired' : 'denied', message: String(t.error_description ?? t.error ?? 'GitHub refused the sign-in') };
  });
}
