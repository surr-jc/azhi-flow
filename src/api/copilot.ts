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
  enterprise?: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
  nextPollAt: number;
}

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

async function github(ctx: AppContext, path: string, body: Record<string, string>, enterprise?: string): Promise<Record<string, any>> {
  const r = await fetch(`${(enterprise ? hostUrl(enterprise) : ctx.settings.copilotGithubUrl).replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'azhi-flow' },
    body: JSON.stringify(body),
  }).catch((e) => {
    throw new AzhiError(ErrorClass.transient, `could not reach GitHub for the Copilot sign-in: ${(e as Error).message}`);
  });
  if (!r.ok) throw new AzhiError(ErrorClass.transient, `GitHub answered HTTP ${r.status} to the Copilot sign-in`);
  return (await r.json()) as Record<string, any>;
}

/** GitHub's REST API for the sign-in's host: api.github.com, api.<name>.ghe.com, or <host>/api/v3 on GitHub Enterprise Server. */
function apiBase(githubUrl: string): string {
  const u = new URL(githubUrl);
  if (u.hostname === 'github.com') return 'https://api.github.com';
  if (u.hostname.endsWith('.ghe.com')) return `${u.protocol}//api.${u.host}`;
  return `${githubUrl.replace(/\/$/, '')}/api/v3`;
}

/**
 * A GitHub Enterprise host as OpenCode names it (`enterpriseUrl`: no scheme, no slash), from what a person
 * types (https://octo.ghe.com/). http:// is kept only on loopback, for local stand-ins.
 */
export function enterpriseHost(v: string): string {
  const t = v.trim().replace(/\/+$/, '');
  const m = /^(?:(https?):\/\/)?([A-Za-z0-9.-]+(?::\d+)?)$/.exec(t);
  if (!m || !m[2]!.includes('.') && !/^localhost|^127\./.test(m[2]!)) throw new AzhiError(ErrorClass.invalidInput, `'${v}' is not a GitHub Enterprise host such as octo.ghe.com`);
  if (m[1] === 'http' && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(m[2]!)) throw new AzhiError(ErrorClass.invalidInput, 'a GitHub Enterprise host is https://');
  return m[1] === 'http' ? `http://${m[2]}` : m[2]!;
}
const hostUrl = (host: string) => (host.startsWith('http://') ? host : `https://${host}`);

/**
 * The Copilot sign-in in what the secret holds: a bare token (github.com), or OpenCode's own entry
 * (auth.json, or its github-copilot entry), kept whole so OpenCode gets what its own login wrote.
 */
function entryOf(value: string): { entry?: Record<string, unknown>; token: string; enterprise?: string } {
  const v = value.trim();
  if (!v.startsWith('{')) return { token: v };
  let j: any;
  try {
    j = JSON.parse(v);
  } catch {
    throw new AzhiError(ErrorClass.invalidInput, 'that looks like JSON but does not parse');
  }
  const entry = j['github-copilot'] ?? j['github-copilot-enterprise'] ?? j;
  if (entry && typeof entry.refresh === 'string' && entry.refresh) return { entry, token: entry.refresh, ...(entry.enterpriseUrl ? { enterprise: String(entry.enterpriseUrl) } : {}) };
  const names = Object.keys(j).filter((k) => typeof j[k] === 'object');
  throw new AzhiError(ErrorClass.invalidInput, `that JSON has no github-copilot sign-in (a refresh token) in it${names.length ? `; it holds: ${names.join(', ')}` : ''}`);
}
const signIn = entryOf;

export interface CopilotCheck {
  ok: boolean;
  message: string;
  plan?: string;
  steps: Array<{ name: string; status: number | string; detail: string }>;
}

/** The Copilot API as OpenCode reaches it: the stand-in URL in tests, copilot-api.<host> on Enterprise, else api.githubcopilot.com. */
function copilotApi(ctx: AppContext, enterprise?: string): string {
  if (ctx.settings.copilotApiUrl) return ctx.settings.copilotApiUrl.replace(/\/$/, '');
  return enterprise ? `https://copilot-api.${enterprise.replace(/^https?:\/\//, '')}` : 'https://api.githubcopilot.com';
}

async function call(url: string, init: RequestInit): Promise<{ status: number | string; text: string; requestId?: string }> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    return { status: r.status, text: (await r.text()).slice(0, 2000), requestId: r.headers.get('x-copilot-service-request-id') ?? undefined };
  } catch (e) {
    return { status: 'unreachable', text: (e as Error).message };
  }
}

const brief = (r: { text: string; requestId?: string }) => {
  let m = r.text.trim();
  try {
    const j = JSON.parse(m);
    m = String(j?.error?.message ?? j?.message ?? m);
  } catch {
    // plain text
  }
  return `${m.replace(/\s+/g, ' ').slice(0, 200)}${r.requestId ? ` (request ${r.requestId})` : ''}`;
};

/**
 * Does Copilot accept the saved sign-in? The same two requests OpenCode makes with it: the model list,
 * then a one-token chat with the configured model, both as `Authorization: Bearer <token>`. GitHub's
 * token-exchange endpoint is asked too, for the plan name only; some tokens OpenCode uses successfully
 * are refused there, so its answer never decides.
 */
export async function checkCopilotToken(ctx: AppContext, token: string, enterprise?: string): Promise<CopilotCheck> {
  const api = copilotApi(ctx, enterprise);
  const headers = { authorization: `Bearer ${token}`, 'user-agent': 'opencode/1.18.34' };
  const model = ctx.settings.copilotModel;
  const steps: CopilotCheck['steps'] = [];
  const models = await call(`${api}/models`, { headers: { ...headers, 'x-github-api-version': '2026-06-01' } });
  let ids: string[] = [];
  try {
    const j = JSON.parse(models.text);
    const list = (Array.isArray(j) ? j : (j.data ?? j.models ?? j.items ?? [])) as Array<{ id?: string } | string>;
    ids = list.map((m) => (typeof m === 'string' ? m : String(m.id)));
  } catch {
    // not JSON
  }
  steps.push({ name: `GET ${api}/models`, status: models.status, detail: models.status === 200 ? (ids.length ? `${ids.length} models${ids.includes(model) ? `, including ${model}` : `; ${model} is not among them`}` : 'answered (list not read)') : brief(models) });
  const chat = await call(`${api}/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'x-initiator': 'user', 'openai-intent': 'conversation-edits' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with: ok' }], max_tokens: 5, stream: false }),
  });
  steps.push({ name: `POST ${api}/chat/completions (${model})`, status: chat.status, detail: typeof chat.status === 'number' && chat.status < 300 ? 'answered' : brief(chat) });
  const exch = await call(`${apiBase(enterprise ? hostUrl(enterprise) : ctx.settings.copilotGithubUrl)}/copilot_internal/v2/token`, { headers: { accept: 'application/json', authorization: `token ${token}`, 'user-agent': 'azhi-flow' } });
  let plan: string | undefined;
  if (exch.status === 200) {
    try {
      plan = JSON.parse(exch.text).sku;
    } catch {
      // no plan
    }
  }
  steps.push({ name: 'GitHub token exchange (plan name only)', status: exch.status, detail: exch.status === 200 ? (plan ?? 'ok') : 'not used by Azhi or OpenCode' });

  const auth = (s: number | string) => s === 401 || s === 403;
  const where = enterprise ? enterprise : 'github.com';
  const fix = `Sign in again with the GitHub account that has your Copilot seat (azhi copilot login${enterprise ? ` --enterprise-url ${enterprise}` : ' [--enterprise-url octo.ghe.com if your company signs in to its own GitHub address]'}), or reuse the sign-in your OpenCode has (azhi copilot import).`;
  if (models.status === 'unreachable' || chat.status === 'unreachable') return { ok: false, plan, steps, message: `Could not reach the Copilot API (${models.status === 'unreachable' ? models.text : chat.text}). Check the network or proxy (HTTPS_PROXY) of the machine running Azhi.` };
  if (auth(models.status)) return { ok: false, plan, steps, message: `Copilot rejects this sign-in (${models.status} on the model list: ${brief(models)}). OpenCode would get the same answer with it. It is not a Copilot sign-in for ${where}, or it is revoked. ${fix}` };
  if (auth(chat.status)) return { ok: false, plan, steps, message: `Copilot lists models for this sign-in but refuses to chat (${chat.status}: ${brief(chat)}). Usually the account has no Copilot seat or the organization has switched ${model} off; compare with the models your own OpenCode offers, set AZHI_COPILOT_MODEL to one of them, or ${fix.charAt(0).toLowerCase()}${fix.slice(1)}` };
  if (typeof chat.status === 'number' && chat.status >= 300) return { ok: true, plan, steps, message: `Copilot accepts this sign-in, but the test chat with ${model} answered ${chat.status}: ${brief(chat)}. If the run fails the same way, pick another model (AZHI_COPILOT_MODEL).` };
  return { ok: true, plan, steps, message: `Copilot accepts this sign-in: the model list and a test chat with ${model} both worked${plan ? ` (plan: ${plan})` : ''}.` };
}

export interface CopilotQuota {
  ok: boolean;
  message: string;
  plan?: string;
  reset_date?: string;
  quotas: Array<{ name: string; entitlement: number | null; remaining: number | null; used: number | null; percent_remaining: number | null; unlimited: boolean; overage_permitted: boolean | null; overage_count: number | null }>;
  /** The answer's field names and value types (never values that are not numbers or booleans), to see what GitHub sends. */
  shape?: unknown;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Field names and types of a JSON answer; numbers and booleans kept, strings replaced by their type. */
function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > 4) return '...';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  return typeof v === 'number' || typeof v === 'boolean' || v === null ? v : typeof v;
}

/**
 * The signed-in user's own Copilot allowance: what VS Code and OpenChamber show. GitHub answers it at
 * copilot_internal/user for the user's Copilot sign-in, no admin rights needed. It is an internal,
 * undocumented endpoint, so every field is read loosely and the answer's shape is returned too.
 */
export async function copilotQuota(ctx: AppContext, token: string, enterprise?: string): Promise<CopilotQuota> {
  const url = `${apiBase(enterprise ? hostUrl(enterprise) : ctx.settings.copilotGithubUrl)}/copilot_internal/user`;
  const r = await call(url, { headers: { accept: 'application/json', authorization: `token ${token}`, 'user-agent': 'azhi-flow', 'x-github-api-version': '2025-04-01' } });
  if (r.status !== 200) return { ok: false, quotas: [], message: r.status === 'unreachable' ? `Could not reach GitHub (${r.text}).` : `GitHub did not give the Copilot allowance for this sign-in (${r.status}: ${brief(r)}).` };
  let j: Record<string, any>;
  try {
    j = JSON.parse(r.text);
  } catch {
    return { ok: false, quotas: [], message: 'GitHub answered with something that is not JSON.' };
  }
  const snaps = (j.quota_snapshots ?? j.quotas ?? {}) as Record<string, Record<string, unknown>>;
  const quotas = Object.entries(snaps)
    .filter(([, q]) => q && typeof q === 'object')
    .map(([name, q]) => {
      const entitlement = n(q.entitlement ?? q.limit ?? q.total);
      const remaining = n(q.remaining ?? q.quota_remaining);
      const used = n(q.credits_used ?? q.used ?? q.consumed) ?? (entitlement !== null && remaining !== null ? Math.max(0, entitlement - remaining) : null);
      return {
        name,
        entitlement,
        remaining,
        used,
        percent_remaining: n(q.percent_remaining),
        unlimited: q.unlimited === true,
        overage_permitted: typeof q.overage_permitted === 'boolean' ? q.overage_permitted : null,
        overage_count: n(q.overage_count ?? q.overage),
      };
    });
  const plan = typeof j.copilot_plan === 'string' ? j.copilot_plan : typeof j.access_type_sku === 'string' ? j.access_type_sku : undefined;
  const reset = j.quota_reset_date_utc ?? j.quota_reset_date ?? j.limited_user_reset_date;
  const metered = quotas.filter((q) => !q.unlimited);
  const text = metered.length
    ? metered.map((q) => `${q.name}: ${q.used ?? '?'} used of ${q.entitlement ?? '?'}${q.remaining !== null ? `, ${q.remaining} left` : ''}${q.percent_remaining !== null ? ` (${Math.round(q.percent_remaining)}% left)` : ''}`).join('; ')
    : 'GitHub reports no metered allowance for this sign-in.';
  return { ok: true, plan, reset_date: typeof reset === 'string' ? reset : undefined, quotas, message: text, shape: shapeOf(j) };
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
    const si = signIn(s.value);
    return { ...(await checkCopilotToken(ctx, si.token, si.enterprise)), ...(si.enterprise ? { enterprise: si.enterprise } : {}) };
  });

  // The signed-in user's own allowance (what VS Code shows).
  app.get('/v1/copilot/quota', async (req) => {
    const p = user(req);
    requireRole(p, 'operator');
    const q = z.object({ secret: z.string().regex(SECRET).default('github-copilot-token') }).parse(req.query ?? {});
    const s = await resolveSecret(ctx, p.workspaceId, q.secret);
    if (!s) return { ok: false, quotas: [], message: `No sign-in is saved yet (secret ${q.secret}).` };
    const si = signIn(s.value);
    return copilotQuota(ctx, si.token, si.enterprise);
  });

  // The sign-in OpenCode already has (its auth.json, or just the github-copilot entry), stored as the secret.
  app.post('/v1/copilot/import', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z
      .object({
        secret: z.string().regex(SECRET).default('github-copilot-token'),
        auth: z.string().min(2).max(20_000).optional(),
        /** Several sign-ins to try (from OpenCode's file, the environment, the gh tool); the first that Copilot accepts is stored. */
        candidates: z.array(z.object({ name: z.string().max(80), auth: z.string().min(2).max(20_000) })).min(1).max(8).optional(),
        enterprise_url: z.string().max(200).optional(),
      })
      .parse(req.body ?? {});
    if (!b.auth && !b.candidates) throw new AzhiError(ErrorClass.invalidInput, 'give auth (a sign-in) or candidates (several to try)');
    const store = async (auth: string) => {
      const si = signIn(auth);
      const enterprise = b.enterprise_url?.trim() ? enterpriseHost(b.enterprise_url) : si.enterprise ? enterpriseHost(si.enterprise) : undefined;
      const value = si.entry ? JSON.stringify({ ...si.entry, type: 'oauth', ...(enterprise ? { enterpriseUrl: enterprise } : {}) }) : enterprise ? JSON.stringify({ type: 'oauth', refresh: si.token, access: si.token, expires: 0, enterpriseUrl: enterprise }) : si.token;
      return { si, enterprise, value };
    };
    const save = async (value: string, enterprise: string | undefined, via?: string) => {
      const version = await setSecret(ctx, p.workspaceId, b.secret, value, p.userId);
      await audit(ctx, p.workspaceId, p.userId, 'copilot.imported', { secret: b.secret, version, ...(enterprise ? { enterprise } : {}), ...(via ? { via } : {}) });
      return version;
    };
    if (b.auth) {
      const { si, enterprise, value } = await store(b.auth);
      const version = await save(value, enterprise);
      return { secret: b.secret, version, ...(enterprise ? { enterprise } : {}), check: await checkCopilotToken(ctx, si.token, enterprise).catch((e) => ({ ok: false, message: (e as Error).message })) };
    }
    // Try each; store the first Copilot accepts, and nothing when none does (a working sign-in is never replaced by a dead one).
    const tried: Array<{ name: string; ok: boolean; message: string }> = [];
    for (const c of b.candidates!) {
      try {
        const { si, enterprise, value } = await store(c.auth);
        const check = await checkCopilotToken(ctx, si.token, enterprise);
        tried.push({ name: c.name, ok: check.ok, message: check.message });
        if (check.ok) {
          const version = await save(value, enterprise, c.name);
          return { secret: b.secret, version, from: c.name, ...(enterprise ? { enterprise } : {}), check, tried };
        }
      } catch (e) {
        tried.push({ name: c.name, ok: false, message: (e as Error).message });
      }
    }
    return { secret: b.secret, from: null, tried };
  });

  app.post('/v1/copilot/login', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ secret: z.string().regex(SECRET).default('github-copilot-token'), enterprise_url: z.string().max(200).optional() }).parse(req.body ?? {});
    const enterprise = b.enterprise_url?.trim() ? enterpriseHost(b.enterprise_url) : undefined;
    sweep();
    const d = await github(ctx, '/login/device/code', { client_id: OPENCODE_CLIENT_ID, scope: 'read:user' }, enterprise);
    if (!d.device_code || !d.user_code) throw new AzhiError(ErrorClass.transient, 'GitHub did not start the Copilot sign-in');
    const id = `cpl_${randomBytes(12).toString('hex')}`;
    const interval = Math.max(1, Number(d.interval ?? 5));
    pending.set(id, { workspaceId: p.workspaceId, userId: p.userId, secret: b.secret, ...(enterprise ? { enterprise } : {}), deviceCode: d.device_code, interval, expiresAt: Date.now() + Number(d.expires_in ?? 900) * 1000, nextPollAt: 0 });
    return { id, user_code: d.user_code as string, verification_uri: (d.verification_uri as string) ?? `${hostUrl(enterprise ?? 'github.com')}/login/device`, interval, expires_in: Number(d.expires_in ?? 900), secret: b.secret, ...(enterprise ? { enterprise } : {}) };
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
    const t = await github(ctx, '/login/oauth/access_token', { client_id: OPENCODE_CLIENT_ID, device_code: s.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, s.enterprise);
    if (typeof t.access_token === 'string' && t.access_token) {
      pending.delete(id);
      const value = s.enterprise ? JSON.stringify({ type: 'oauth', refresh: t.access_token, access: t.access_token, expires: 0, enterpriseUrl: s.enterprise }) : t.access_token;
      const version = await setSecret(ctx, p.workspaceId, s.secret, value, p.userId);
      await audit(ctx, p.workspaceId, p.userId, 'copilot.signed_in', { secret: s.secret, version, ...(s.enterprise ? { enterprise: s.enterprise } : {}) });
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
