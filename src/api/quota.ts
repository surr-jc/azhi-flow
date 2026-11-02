import type { FastifyInstance, FastifyRequest } from 'fastify';
import { chatgptAuth } from '../agents/chatgpt-auth.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import type { AppContext } from '../server/context.js';
import { resolveSecret } from '../server/secrets.js';
import { requireRole } from './auth.js';
import { freshChatgptAuth, CHATGPT_SECRET } from './chatgpt.js';
import { copilotQuota, copilotSignIn } from './copilot.js';

/** One allowance window of a provider. Unknown numbers are null, never guessed. */
export interface QuotaMeter {
  label: string;
  used_percent: number | null;
  /** "12 of 300" style text when the provider gives counts. */
  detail: string | null;
  resets_at: string | null;
}

export interface ProviderQuota {
  id: 'copilot' | 'chatgpt' | 'anthropic';
  title: string;
  /** not_signed_in: no secret saved; unavailable: signed in but the provider gave no allowance. */
  status: 'ok' | 'not_signed_in' | 'unavailable';
  plan: string | null;
  message: string | null;
  meters: QuotaMeter[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v: number | null) => (v === null ? null : Math.max(0, Math.min(100, Math.round(v))));
/** A reset given as epoch seconds, ISO text, or seconds from now. */
const iso = (at: unknown, after?: unknown): string | null => {
  const a = num(at);
  if (a !== null) return new Date(a < 1e11 ? a * 1000 : a).toISOString();
  if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return new Date(at).toISOString();
  const s = num(after);
  return s !== null ? new Date(Date.now() + s * 1000).toISOString() : null;
};

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number | 'unreachable'; json?: any; text: string }> {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'azhi-flow', ...headers }, signal: AbortSignal.timeout(15_000) });
    const text = (await r.text()).slice(0, 1_000_000);
    try {
      return { status: r.status, json: JSON.parse(text), text: '' };
    } catch {
      return { status: r.status, text: '' };
    }
  } catch (e) {
    return { status: 'unreachable', text: (e as Error).message };
  }
}

const base = (id: ProviderQuota['id'], title: string): ProviderQuota => ({ id, title, status: 'not_signed_in', plan: null, message: null, meters: [] });

async function copilot(ctx: AppContext, workspaceId: string): Promise<ProviderQuota> {
  const out = base('copilot', 'GitHub Copilot');
  const s = await resolveSecret(ctx, workspaceId, 'github-copilot-token');
  if (!s) return { ...out, message: 'Not signed in.' };
  const si = copilotSignIn(s.value);
  const q = await copilotQuota(ctx, si.token, si.enterprise);
  if (!q.ok) return { ...out, status: 'unavailable', message: q.message };
  const metered = q.quotas.filter((x) => !x.unlimited);
  return {
    ...out,
    status: 'ok',
    plan: q.plan ?? null,
    message: metered.length ? null : 'No metered allowance on this plan.',
    meters: metered.map((x) => ({
      label: x.name.replace(/_/g, ' '),
      used_percent: x.entitlement ? pct((100 * (x.used ?? 0)) / x.entitlement) : x.percent_remaining !== null ? pct(100 - x.percent_remaining) : null,
      detail: x.used !== null && x.entitlement !== null ? `${x.used} of ${x.entitlement}` : null,
      resets_at: iso(q.reset_date),
    })),
  };
}

function window(label: string, w: any): QuotaMeter | null {
  if (!w || typeof w !== 'object') return null;
  return { label, used_percent: pct(num(w.used_percent ?? w.utilization)), detail: null, resets_at: iso(w.reset_at ?? w.resets_at, w.reset_after_seconds) };
}

/** ChatGPT plan limits, as the Codex client shows them (5-hour and weekly windows). Undocumented, so read loosely. */
async function chatgpt(ctx: AppContext, workspaceId: string): Promise<ProviderQuota> {
  const out = base('chatgpt', 'ChatGPT plan');
  const s = await resolveSecret(ctx, workspaceId, CHATGPT_SECRET);
  if (!s || !chatgptAuth(s.value)) return { ...out, message: 'Not signed in.' };
  let a;
  try {
    a = chatgptAuth(await freshChatgptAuth(ctx, workspaceId, CHATGPT_SECRET, s.value))!;
  } catch (e) {
    return { ...out, status: 'unavailable', message: (e as Error).message };
  }
  const url = `${ctx.settings.chatgptApiUrl.replace(/\/codex$/, '')}/wham/usage`;
  const r = await getJson(url, { authorization: `Bearer ${a.access}`, ...(a.accountId ? { 'chatgpt-account-id': a.accountId } : {}) });
  if (r.status !== 200 || !r.json) return { ...out, status: 'unavailable', message: r.status === 'unreachable' ? `Could not reach ChatGPT (${r.text}).` : `ChatGPT did not give the plan allowance (HTTP ${r.status}).` };
  const rl = r.json.rate_limit ?? r.json.rate_limits ?? {};
  const meters = [window('5-hour window', rl.primary_window ?? rl.primary), window('Weekly window', rl.secondary_window ?? rl.secondary)].filter((m): m is QuotaMeter => m !== null);
  return { ...out, status: 'ok', plan: typeof r.json.plan_type === 'string' ? r.json.plan_type : null, message: meters.length ? null : 'ChatGPT reported no limit windows for this plan.', meters };
}

/**
 * Claude Pro/Max limits, from the token `claude setup-token` makes. That token is scoped to inference,
 * so Anthropic may refuse the usage call; an API key (anthropic-api-key) has no allowance to report.
 */
async function anthropic(ctx: AppContext, workspaceId: string): Promise<ProviderQuota> {
  const out = base('anthropic', 'Anthropic');
  const plan = await resolveSecret(ctx, workspaceId, 'claude-oauth-token');
  if (!plan) {
    const key = await resolveSecret(ctx, workspaceId, 'anthropic-api-key');
    return key ? { ...out, status: 'unavailable', message: 'An API key is billed per token; Anthropic reports no allowance for it.' } : { ...out, message: 'Not signed in.' };
  }
  const r = await getJson(`${ctx.settings.anthropicApiUrl.replace(/\/$/, '')}/api/oauth/usage`, { authorization: `Bearer ${plan.value.trim()}`, 'anthropic-beta': 'oauth-2025-04-20' });
  if (r.status !== 200 || !r.json) return { ...out, status: 'unavailable', message: r.status === 'unreachable' ? `Could not reach Anthropic (${r.text}).` : r.status === 401 || r.status === 403 ? 'Anthropic does not show plan usage to this token (a `claude setup-token` token can only run models).' : `Anthropic did not give the plan allowance (HTTP ${r.status}).` };
  const meters = [window('5-hour window', r.json.five_hour), window('Weekly window', r.json.seven_day), window('Weekly Opus', r.json.seven_day_opus)].filter((m): m is QuotaMeter => m !== null);
  return { ...out, status: 'ok', message: meters.length ? null : 'Anthropic reported no limit windows.', meters };
}

/** What is left of each model provider's allowance for the sign-ins this workspace has. Values never leave the server. */
export function registerQuotaRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/quota', async (req) => {
    const p = user(req);
    requireRole(p, 'operator');
    const providers = await Promise.all(
      (
        [
          ['copilot', 'GitHub Copilot', copilot],
          ['chatgpt', 'ChatGPT plan', chatgpt],
          ['anthropic', 'Anthropic', anthropic],
        ] as const
      ).map(([id, title, f]) => f(ctx, p.workspaceId).catch((e): ProviderQuota => ({ ...base(id, title), status: 'unavailable', message: (e as Error).message }))),
    );
    return { providers };
  });
}
