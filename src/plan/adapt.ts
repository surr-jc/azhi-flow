import { applyModelDefaults, MODEL_PROVIDERS, parseProfile, usesDefaultModel, type AgentProfile, type ModelDefaults, type ModelProviderName } from '../agents/profile.js';
import { profilePath } from '../compiler/compile.js';
import type { AgentNode } from '../definition/types.js';
import { EXECUTORS } from '../executors/capabilities.js';
import type { AppContext } from '../server/context.js';
import { packageFile } from '../server/packages.js';
import type { VersionRow } from '../server/workflows.js';

/**
 * Fits a workflow to the sign-ins a workspace actually has, before a run starts: picks the provider
 * (and optionally the model and harness) for the steps that say `name: default`, and the executor each
 * step needs to drive it. Nothing is saved here; the result carries the edited definition so the caller
 * can check it and save it as a draft through the editor.
 *
 * A step that names its own model keeps it (the same rule as model_defaults), so such a step whose provider
 * is not signed in is reported as `blocked` for a person to fix in its profile.
 */
export interface AdaptRequest {
  provider?: ModelProviderName;
  model?: string;
  /** Force this harness on every step that can run on it (and whose provider it drives). */
  executor?: string;
}

export interface AdaptStep {
  node: string;
  /** What the step runs on today, before any change. */
  from: { executor: string; provider: string | null; model: string | null };
  to: { executor: string; provider: string | null; model: string | null };
  changed: boolean;
  status: 'ok' | 'changed' | 'blocked';
  reason?: string;
}

export interface AdaptResult {
  /** Providers whose credential is set in this workspace. */
  ready: ModelProviderName[];
  model_defaults: ModelDefaults | null;
  steps: AdaptStep[];
  /** True when no step needs a change, so there is nothing to save. */
  unchanged: boolean;
  /** The definition with the changes applied; absent when nothing changed. */
  definition?: Record<string, unknown>;
}

/** Which of an executor's providers a step can use; a checkout (`workspace`) is OpenCode-only. */
function executorsFor(def: AgentNode, provider: ModelProviderName, forced?: string): string[] {
  const all = ['model-agent', ...Object.keys(EXECUTORS).filter((e) => e !== 'model-agent')].filter((e) => (EXECUTORS[e]?.providers as string[] | undefined)?.includes(provider));
  const allowed = def.workspace ? all.filter((e) => e === 'opencode') : all;
  // The step's own executor first, so a step that already works is left alone; the experimental codex harness is never picked for a person.
  const current = def.executor ?? 'model-agent';
  const order = [...allowed.filter((e) => e === current), ...allowed.filter((e) => e !== current && e !== 'codex')];
  // A forced harness is a preference: a step it cannot drive keeps the executor that works for it.
  return forced && order.includes(forced) ? [forced, ...order.filter((e) => e !== forced)] : order;
}

export async function adaptWorkflow(
  ctx: AppContext,
  workspaceId: string,
  version: VersionRow,
  ready: ModelProviderName[],
  req: AdaptRequest = {},
  read: (path: string) => Promise<string> = async (p) => (await packageFile(ctx, workspaceId, version.package_hash, p)).toString('utf8'),
): Promise<AdaptResult> {
  const agents = version.plan.nodes.filter((n) => n.type === 'agent').map((n) => n.def as AgentNode & { id: string });
  const profiles = new Map<string, AgentProfile | undefined>();
  for (const a of agents) {
    const path = profilePath(a.profile);
    if (!profiles.has(a.profile)) profiles.set(a.profile, await read(path).then((t) => parseProfile(t, path), () => undefined));
  }

  const current = version.definition.model_defaults as ModelDefaults | undefined;
  // How many default-model steps could run on a provider, counting a step that already works there.
  const score = (p: ModelProviderName) => agents.filter((a) => {
    const prof = profiles.get(a.profile);
    return prof && usesDefaultModel(prof) && executorsFor(a, p, req.executor).length > 0;
  }).length;
  const defaultSteps = agents.filter((a) => { const prof = profiles.get(a.profile); return prof && usesDefaultModel(prof); });

  let chosen: ModelDefaults | undefined;
  if (req.provider) chosen = { provider: req.provider, ...(req.model ? { name: req.model } : {}) };
  else if (req.model) chosen = current?.provider ? { provider: current.provider, name: req.model } : undefined;
  else if (current?.provider && ready.includes(current.provider)) chosen = current;
  else if (defaultSteps.length) {
    // Prefer what the steps use today when it is signed in; otherwise the signed-in provider the most steps can run on.
    const today = defaultSteps.map((a) => applyModelDefaults(profiles.get(a.profile)!, current).model.provider).filter((p): p is ModelProviderName => p !== 'scripted');
    const order = [...new Set([...today, ...MODEL_PROVIDERS])].filter((p) => ready.includes(p));
    const best = order.sort((a, b) => score(b) - score(a))[0];
    if (best && !(today.length && today.every((p) => ready.includes(p)))) chosen = { provider: best };
  }

  const steps: AdaptStep[] = agents.map((a) => {
    const prof = profiles.get(a.profile);
    const executor = a.executor ?? 'model-agent';
    const view = (e: string, p: AgentProfile) => {
      const m = p.model;
      return { executor: e, provider: m.provider === 'scripted' ? null : m.provider, model: m.provider === 'scripted' || !m.name || m.name === 'default' ? null : m.name };
    };
    if (!prof) return { node: a.id, from: { executor, provider: null, model: null }, to: { executor, provider: null, model: null }, changed: false, status: 'blocked', reason: `the profile ${a.profile} could not be read` };
    const before = view(executor, applyModelDefaults(prof, current));
    if (prof.model.provider === 'scripted') return { node: a.id, from: before, to: before, changed: false, status: 'ok' };
    const effective = applyModelDefaults(prof, chosen ?? current);
    const provider = effective.model.provider as ModelProviderName;
    const options = executorsFor(a, provider, req.executor);
    const target = options[0];
    if (!target) return { node: a.id, from: before, to: before, changed: false, status: 'blocked', reason: `no harness here can drive ${provider}${a.workspace ? ' with a checkout (OpenCode only)' : ''}` };
    if (!ready.includes(provider)) return { node: a.id, from: before, to: view(target, effective), changed: false, status: 'blocked', reason: usesDefaultModel(prof) ? `${provider} is not signed in` : `this step names its own ${provider} model and ${provider} is not signed in; change its profile` };
    const to = view(target, effective);
    const changed = target !== executor || to.provider !== before.provider || to.model !== before.model;
    return { node: a.id, from: before, to, changed, status: changed ? 'changed' : 'ok' };
  });

  const modelChanged = JSON.stringify(chosen ?? null) !== JSON.stringify(current ?? null) && Boolean(chosen);
  const unchanged = !modelChanged && !steps.some((s) => s.from.executor !== s.to.executor);
  const result: AdaptResult = { ready, model_defaults: chosen ?? current ?? null, steps, unchanged };
  if (unchanged) return result;

  const definition = structuredClone(version.definition) as unknown as Record<string, unknown> & { nodes: Array<Record<string, unknown>> };
  if (chosen && modelChanged) definition.model_defaults = chosen;
  for (const s of steps) {
    if (s.status === 'blocked' || s.from.executor === s.to.executor) continue;
    const node = definition.nodes.find((n) => n.id === s.node);
    // `model-agent` is the default, so it is written by leaving the field out.
    if (node) s.to.executor === 'model-agent' ? delete node.executor : (node.executor = s.to.executor);
  }
  result.definition = definition;
  return result;
}
