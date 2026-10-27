import { COPILOT_RATES } from '../agents/copilot-pricing.js';
import { PROVIDER_DEFAULTS } from '../agents/providers.js';
import { copilotApi, copilotPlanApi, copilotSignIn, OPENCODE_USER_AGENT } from '../api/copilot.js';
import type { AppContext } from '../server/context.js';
import { resolveSecret } from '../server/secrets.js';

/**
 * The models the workflow builder can use, per provider: the provider's own model list read with
 * the workspace key (Anthropic and OpenAI both have GET /v1/models), or a built-in list when that
 * call fails; for OpenCode, the GitHub Copilot model list its sign-in sees. One model per provider is recommended for workflow building; the person may pick any
 * other, or type an id the list does not show.
 */
export interface BuilderModel {
  id: string;
  label: string;
  /** Served only on the Responses API (some Copilot models); absent means Chat Completions. */
  endpoint?: 'responses';
}

export interface BuilderModels {
  provider: string;
  models: BuilderModel[];
  recommended?: { id: string; reason: string };
  /** `live`: read from the provider just now (or in the last few minutes); `built-in`: the fallback list. */
  source: 'live' | 'built-in';
  /** Why the live list was not used. */
  note?: string;
}

/** Anthropic's current models, newest first; used when the Models API cannot be reached. */
const ANTHROPIC_BUILT_IN: BuilderModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];
const ANTHROPIC_RECOMMENDED = {
  id: 'claude-opus-5-5',
  reason: 'Strongest everyday model for long, structured drafts and for fixing what the compiler reports, at a lower price than Fable.',
};

/** OpenAI ids that are not chat models the builder can drive. */
const OPENAI_NOT_CHAT = /(audio|realtime|tts|transcribe|whisper|image|dall-e|embedding|moderation|search|instruct|davinci|babbage|codex|computer-use|sora)/i;
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/i;

export type ModelProviderId = 'anthropic' | 'openai' | 'opencode' | 'chatgpt';

/**
 * The models OpenCode 1.18.34 offers on a ChatGPT plan (its ChatGPT login filters OpenAI's list to
 * these; the -fast variants are left out). There is no model-list call for a plan, so this list is fixed.
 */
const CHATGPT_BUILT_IN: BuilderModel[] = ['gpt-5.5', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'].map((id) => ({ id, label: id }));

/**
 * The Copilot models this sign-in's plan lets the person use, as Copilot's own model picker shows
 * them: `model_picker_enabled` (older and dated variants such as gpt-4-0613 are listed but not
 * offered), not switched off by an organization policy (VS Code's "Contact your admin"), chat
 * models that take tool calls on the Chat Completions or the Responses API. One entry per model
 * family. The list is read from the plan's own API address when GitHub gives one
 * (api.business / api.enterprise.githubcopilot.com), else from the address OpenCode uses.
 */
async function copilotModels(ctx: AppContext, signIn: string): Promise<BuilderModel[]> {
  const si = copilotSignIn(signIn);
  const headers = { authorization: `Bearer ${si.token}`, 'user-agent': OPENCODE_USER_AGENT, 'x-github-api-version': '2026-06-01' };
  const plan = await copilotPlanApi(ctx, si.token, si.enterprise);
  // The plan's address may want a Copilot session token rather than the sign-in; then OpenCode's address answers.
  const body = (plan ? await getJson(`${plan}/models`, headers).catch(() => undefined) : undefined) ?? (await getJson(`${copilotApi(ctx, si.enterprise)}/models`, headers));
  return copilotPlanModels((Array.isArray(body) ? body : (body.data ?? body.models ?? [])) as Array<Record<string, any>>);
}

/** Filters Copilot's model list to what the plan offers (see copilotModels). */
export function copilotPlanModels(list: Array<Record<string, any>>): BuilderModel[] {
  const usable = list.filter((m) => {
    if (typeof m?.id !== 'string') return false;
    if (m.model_picker_enabled === false) return false;
    if (m.policy?.state === 'disabled') return false;
    if (m.capabilities?.type && m.capabilities.type !== 'chat') return false;
    if (m.capabilities?.supports?.tool_calls === false) return false;
    if (Array.isArray(m.supported_endpoints) && !m.supported_endpoints.includes('/chat/completions') && !m.supported_endpoints.includes('/responses')) return false;
    return true;
  });
  // One per family: the family's own id (gpt-4o) over dated or preview variants (gpt-4o-2024-11-20).
  const families = new Map<string, Record<string, any>>();
  for (const m of usable) {
    const family = typeof m.capabilities?.family === 'string' ? m.capabilities.family : m.id;
    const had = families.get(family);
    const plain = (x: Record<string, any>) => (x.id === family ? 0 : /\d{4}-\d{2}-\d{2}|preview|-\d{4}$/.test(x.id) ? 2 : 1);
    if (!had || plain(m) < plain(had)) families.set(family, m);
  }
  return [...families.values()].map((m) => ({
    id: m.id,
    label: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : m.id,
    ...(Array.isArray(m.supported_endpoints) && !m.supported_endpoints.includes('/chat/completions') ? { endpoint: 'responses' as const } : {}),
  }));
}

/** The strongest Claude model on Copilot: the newest Opus, else the newest Sonnet. */
function copilotBest(ids: string[]): string | undefined {
  const version = (id: string) => (/(\d+)(?:[.-](\d+))?/.exec(id.replace(/^claude-(opus|sonnet)-/, '')) ?? []).slice(1).map((x) => Number(x ?? 0));
  for (const family of ['opus', 'sonnet']) {
    const found = ids.filter((id) => new RegExp(`^claude-${family}-\\d`).test(id) && !/preview|thought|fast/.test(id));
    found.sort((a, b) => {
      const va = version(a);
      const vb = version(b);
      return vb[0]! - va[0]! || (vb[1] ?? 0) - (va[1] ?? 0);
    });
    if (found[0]) return found[0];
  }
  return undefined;
}

const cache = new Map<string, { at: number; value: BuilderModels }>();
const TTL_MS = 10 * 60 * 1000;

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Orders OpenAI ids so the larger, newer general models come first: gpt-5.2 before gpt-5.1-mini. */
function openaiRank(id: string): number[] {
  const m = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  const small = /(mini|nano)/.test(id) ? 1 : 0;
  const dated = /\d{4}-\d{2}-\d{2}|preview/.test(id) ? 1 : 0;
  return m ? [0, -Number(m[1]), -Number(m[2] ?? 0), small, dated] : [1, 0, 0, small, dated];
}
const byRank = (a: string, b: string) => {
  const ra = openaiRank(a);
  const rb = openaiRank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
  return a.localeCompare(b);
};

async function anthropicModels(ctx: AppContext, key: string): Promise<BuilderModel[]> {
  const base = PROVIDER_DEFAULTS.anthropic.apiUrl(ctx.settings).replace(/\/$/, '');
  const out: BuilderModel[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const body = await getJson(`${base}/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
    for (const m of body.data ?? []) if (typeof m?.id === 'string') out.push({ id: m.id, label: String(m.display_name ?? m.id) });
    if (!body.has_more || !body.last_id) break;
    after = body.last_id;
  }
  return out;
}

async function openaiModels(ctx: AppContext, key: string): Promise<BuilderModel[]> {
  const base = PROVIDER_DEFAULTS.openai.apiUrl(ctx.settings).replace(/\/$/, '');
  const body = await getJson(`${base}/v1/models`, { authorization: `Bearer ${key}` });
  const ids = (body.data ?? []).map((m: { id?: unknown }) => m?.id).filter((id: unknown): id is string => typeof id === 'string' && OPENAI_CHAT.test(id) && !OPENAI_NOT_CHAT.test(id));
  return [...new Set<string>(ids)].sort(byRank).map((id) => ({ id, label: id }));
}

/** Puts the recommended model first and keeps the configured one in the list even if the provider did not report it. */
function finish(provider: string, models: BuilderModel[], recommended: BuilderModels['recommended'], source: BuilderModels['source'], extra: Array<string | undefined>, note?: string): BuilderModels {
  const list = [...models];
  for (const id of extra) if (id && !list.some((m) => m.id === id)) list.push({ id, label: id });
  if (recommended) {
    const i = list.findIndex((m) => m.id === recommended.id);
    if (i > 0) list.unshift(...list.splice(i, 1));
  }
  return { provider, models: list, recommended, source, ...(note ? { note } : {}) };
}

export async function builderModels(ctx: AppContext, workspaceId: string, provider: ModelProviderId, refresh = false): Promise<BuilderModels> {
  const key = `${workspaceId}:${provider}`;
  const hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < TTL_MS) return hit.value;
  const s = ctx.settings;
  const defaults = PROVIDER_DEFAULTS[provider === 'opencode' ? 'github-copilot' : provider === 'chatgpt' ? 'openai-chatgpt' : provider];
  const configured = defaults.model(s);
  const builderModel = s.builderModel && (!s.builderProvider || s.builderProvider === provider) ? s.builderModel : undefined;
  const secret = await resolveSecret(ctx, workspaceId, defaults.credential);
  let value: BuilderModels;
  if (provider === 'chatgpt') {
    const rec = { id: configured ?? s.chatgptModel, reason: 'The model this server uses for ChatGPT plan steps (AZHI_CHATGPT_MODEL).' };
    value = finish('chatgpt', CHATGPT_BUILT_IN, rec, 'built-in', [builderModel, configured], 'the models OpenCode offers on a ChatGPT plan; your plan may not include all of them');
  } else if (provider === 'opencode') {
    let live: BuilderModel[] | undefined;
    let note: string | undefined;
    if (secret) live = await copilotModels(ctx, secret.value).catch((e) => ((note = `could not read Copilot's model list (${(e as Error).message}); showing the models Azhi knows Copilot offers`), undefined));
    const models = live?.length ? live : Object.keys(COPILOT_RATES).map((id) => ({ id, label: id }));
    const best = copilotBest(models.map((m) => m.id));
    const rec = best
      ? { id: best, reason: 'The strongest Claude model your Copilot seat offers: best at long, structured drafts and at fixing what the compiler reports. It uses more AI Credits than smaller models.' }
      : configured ? { id: configured, reason: 'The model this server already uses for OpenCode steps (AZHI_COPILOT_MODEL).' } : undefined;
    // A live list is what the plan offers, so the configured model joins it only when the server names it for the builder.
    value = finish('opencode', models, rec, live?.length ? 'live' : 'built-in', live?.length ? [builderModel] : [builderModel, configured], note);
  } else if (provider === 'anthropic') {
    let live: BuilderModel[] | undefined;
    let note: string | undefined;
    if (secret) live = await anthropicModels(ctx, secret.value).catch((e) => ((note = `could not read Anthropic's model list (${(e as Error).message}); showing the built-in list`), undefined));
    const models = live?.length ? live : ANTHROPIC_BUILT_IN;
    const rec = models.some((m) => m.id === ANTHROPIC_RECOMMENDED.id) ? ANTHROPIC_RECOMMENDED : models[0] ? { id: models[0].id, reason: 'The newest model this key can use.' } : undefined;
    value = finish('anthropic', models, rec, live?.length ? 'live' : 'built-in', [builderModel, configured], note);
  } else {
    let live: BuilderModel[] | undefined;
    let note: string | undefined;
    if (secret) live = await openaiModels(ctx, secret.value).catch((e) => ((note = `could not read OpenAI's model list (${(e as Error).message})`), undefined));
    const models = live?.length ? live : [];
    // The newest full-size GPT model this key can use: strongest at tool calls and long structured output.
    const best = configured && (!live?.length || live.some((m) => m.id === configured)) ? configured : models.find((m) => /^gpt-\d/.test(m.id) && !/(mini|nano)/.test(m.id))?.id ?? models[0]?.id;
    const rec = best ? { id: best, reason: best === configured ? 'The model this server already uses for OpenAI steps (AZHI_OPENAI_MODEL).' : 'The newest full-size GPT model this key can use; strongest at tool calls and long structured output.' } : undefined;
    value = finish('openai', models, rec, live?.length ? 'live' : 'built-in', [builderModel, configured], note ?? (!live?.length && !configured ? 'type a model id, or set AZHI_OPENAI_MODEL on the server' : undefined));
  }
  if (value.source === 'live') cache.set(key, { at: Date.now(), value });
  return value;
}

/** The model the builder uses when the browser does not name one. */
export async function defaultBuilderModel(ctx: AppContext, workspaceId: string, provider: ModelProviderId): Promise<string | undefined> {
  const s = ctx.settings;
  if (s.builderModel && (!s.builderProvider || s.builderProvider === provider)) return s.builderModel;
  if (provider === 'anthropic') return ANTHROPIC_RECOMMENDED.id;
  if (provider === 'opencode') return (await builderModels(ctx, workspaceId, provider)).recommended?.id ?? s.copilotModel;
  if (provider === 'chatgpt') return s.chatgptModel;
  return PROVIDER_DEFAULTS.openai.model(s) ?? (await builderModels(ctx, workspaceId, provider)).recommended?.id;
}

/** Which API a Copilot model answers on, from the plan's model list (Chat Completions when unknown). */
export async function copilotEndpoint(ctx: AppContext, workspaceId: string, model: string): Promise<'chat' | 'responses'> {
  const list = await builderModels(ctx, workspaceId, 'opencode');
  return list.models.find((m) => m.id === model)?.endpoint === 'responses' ? 'responses' : 'chat';
}
