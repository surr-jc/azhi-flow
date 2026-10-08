import { checkRepoAccess, type GithubConfig, type RepoAccess } from '../gateway/tools/github.js';
import type { AgentNode, ToolNode } from '../definition/types.js';
import type { ToolSpec } from '../gateway/types.js';
import { loadCatalog } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { resolveSecret } from '../server/secrets.js';
import type { VersionRow } from '../server/workflows.js';
import { buildRunPlan } from './run-plan.js';

/**
 * Checks a workflow against the real systems it uses before it is started: that every tool it
 * calls is registered with its secret set, that each GitHub token can use the repositories the
 * run will touch (and has what the step needs to do there), that Slack accepts its token, and
 * everything the run plan already checks (workers, datasets, signature). Where a repository
 * comes from a run input, the input given for this run is checked too.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';
export interface PreflightCheck {
  id: string;
  kind: 'plan' | 'tool' | 'secret' | 'dataset' | 'github' | 'slack';
  status: CheckStatus;
  /** What was checked, such as a tool, a secret or a repository. */
  target: string;
  node?: string;
  message: string;
  fix?: string;
}
export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** A value from the workflow file as a string, when it is a literal or a plain input reference. */
function textOf(v: unknown, inputs: Record<string, unknown>): { value?: string; from?: string } {
  if (typeof v === 'string') return { value: v };
  if (v && typeof v === 'object' && typeof (v as { ref?: unknown }).ref === 'string') {
    const m = /^inputs\.([A-Za-z_]\w*)$/.exec((v as { ref: string }).ref);
    if (m) return { value: typeof inputs[m[1]!] === 'string' ? (inputs[m[1]!] as string) : undefined, from: `input ${m[1]}` };
  }
  return {};
}

const apiFor = (host?: string) => {
  const h = (host ?? 'https://github.com').replace(/\/+$/, '');
  return h === 'https://github.com' ? 'https://api.github.com' : `${h}/api/v3`;
};

const fromAccess = (a: RepoAccess, base: Pick<PreflightCheck, 'id' | 'target' | 'node'>): PreflightCheck => ({
  ...base,
  kind: 'github',
  status: a.ok ? (a.warning ? 'warn' : 'ok') : 'fail',
  message: a.ok && a.warning ? `${a.message} ${a.warning}` : a.message,
  ...(a.fix ? { fix: a.fix } : {}),
});

export async function preflight(ctx: AppContext, workspaceId: string, version: VersionRow, opts: { inputs?: Record<string, unknown>; principal?: { userId: string; role: string } } = {}): Promise<PreflightReport> {
  const inputs = opts.inputs ?? {};
  const checks: PreflightCheck[] = [];
  const catalog = await loadCatalog(ctx, workspaceId);
  const plan = await buildRunPlan(ctx, workspaceId, version, opts.principal);
  const secretCache = new Map<string, Promise<string | undefined>>();
  const secret = (name: string) => {
    if (!secretCache.has(name)) secretCache.set(name, resolveSecret(ctx, workspaceId, name).then((s) => s?.value, () => undefined));
    return secretCache.get(name)!;
  };

  // What the run plan already knows: missing secrets, datasets and tools first, then its other blockers.
  const named = new Set<string>();
  for (const g of plan.missing_grants) {
    named.add(`${g.node}:${g.name}`);
    checks.push({
      id: `${g.kind}:${g.name}:${g.node}`,
      kind: g.kind === 'secret' ? 'secret' : g.kind === 'dataset' ? 'dataset' : 'tool',
      status: 'fail',
      target: g.name,
      node: g.node,
      message: g.kind === 'secret' ? `The secret ${g.name} is not set (used by ${g.node}).` : g.kind === 'dataset' ? `The dataset ${g.name} is not available to this workflow (read by ${g.node}).` : `The tool ${g.name} is not registered (called by ${g.node}).`,
      fix: g.kind === 'secret' ? 'Set it under Secrets, or from the Marketplace page of this workflow.' : g.kind === 'dataset' ? 'Create and publish the dataset, or grant access to it.' : 'Register the tool, or install the workflow from the Marketplace.',
    });
  }
  for (const b of plan.blockers) {
    if (b.node && plan.missing_grants.some((g) => g.node === b.node && b.message.includes(g.name))) continue;
    checks.push({ id: `plan:${b.code}:${b.node ?? ''}`, kind: 'plan', status: 'fail', target: b.node ?? 'workflow', ...(b.node ? { node: b.node } : {}), message: b.message });
  }

  const pending: Array<Promise<PreflightCheck | undefined>> = [];
  const seen = new Set<string>();
  const once = (key: string, run: () => Promise<PreflightCheck | undefined>) => {
    if (seen.has(key)) return;
    seen.add(key);
    pending.push(run());
  };
  const github = (credential: string | undefined, cfg: GithubConfig, repo: string, need: 'read' | 'write', node: string, target: string) =>
    once(`gh:${credential}:${cfg.api_url ?? ''}:${repo.toLowerCase()}:${need}`, async () => {
      if (!credential) return undefined;
      const token = await secret(credential);
      if (!token) return undefined; // reported above as a missing secret
      return fromAccess(await checkRepoAccess(cfg, token, repo, need), { id: `github:${credential}:${repo}:${need}`, target: `${repo} with ${credential}`, node });
    });

  // A checkout and the GitHub tools of one workflow talk to the same GitHub, so the tools' API address
  // (an Enterprise server's) also serves the checkout's token check.
  const toolApi = version.plan.nodes
    .map((n) => (n.type === 'tool' ? ((catalog.get((n.def as ToolNode).tool)?.transport as { config?: GithubConfig } | undefined)?.config?.api_url) : undefined))
    .find(Boolean);

  for (const n of version.plan.nodes) {
    if (n.type === 'tool') {
      const def = n.def as ToolNode;
      const spec: ToolSpec | undefined = catalog.get(def.tool);
      if (!spec) continue;
      const cfg = ((spec.transport as { config?: GithubConfig }).config ?? {}) as GithubConfig;
      const need = spec.effect === 'read' ? 'read' : 'write';
      if (Array.isArray(cfg.repos)) {
        for (const repo of cfg.repos) github(spec.credential, cfg, repo, need, n.id, repo);
        // A repository taken from this run's input must be one the tool allows.
        const arg = textOf((def.arguments as Record<string, unknown> | undefined)?.repo, inputs);
        if (arg.from && arg.value !== undefined) {
          const allowed = cfg.repos.some((r) => r.toLowerCase() === arg.value!.toLowerCase());
          checks.push(
            !REPO.test(arg.value)
              ? { id: `repo:${n.id}`, kind: 'github', status: 'fail', target: arg.value, node: n.id, message: `${arg.value} is not a repository name (owner/name).` }
              : allowed
                ? { id: `repo:${n.id}`, kind: 'github', status: 'ok', target: arg.value, node: n.id, message: `${arg.value} is one of the repositories ${def.tool} may use.` }
                : { id: `repo:${n.id}`, kind: 'github', status: 'fail', target: arg.value, node: n.id, message: `${arg.value} is not in the repositories ${def.tool} may use (${cfg.repos.join(', ')}).`, fix: `Add ${arg.value} to the allowed repositories under Workflow settings, Connections.` },
          );
        }
      }
    }
    if (n.type === 'agent') {
      const ws = (n.def as AgentNode).workspace;
      if (!ws?.credential) continue;
      const repo = textOf(ws.repo, inputs);
      if (repo.value === undefined) {
        if (repo.from) checks.push({ id: `ws:${n.id}`, kind: 'github', status: 'warn', target: n.id, node: n.id, message: `${repo.from} has no value yet, so the checkout of ${n.id} cannot be checked.` });
        else checks.push({ id: `ws:${n.id}`, kind: 'github', status: 'skipped', target: n.id, node: n.id, message: `The repository for ${n.id} comes from an expression and is checked when the run starts.` });
        continue;
      }
      if (!REPO.test(repo.value)) {
        checks.push({ id: `ws:${n.id}`, kind: 'github', status: 'fail', target: repo.value, node: n.id, message: `${repo.value} is not a repository name (owner/name).` });
        continue;
      }
      github(ws.credential, { api_url: toolApi ?? apiFor(ws.host) }, repo.value, ws.mode === 'write' ? 'write' : 'read', n.id, repo.value);
    }
    if (n.type === 'notify') {
      const spec = catalog.get('slack.post-message@1');
      if (!spec?.credential) continue;
      once(`slack:${spec.credential}`, async () => {
        const token = await secret(spec.credential!);
        if (!token) return undefined;
        try {
          const res = await fetch(`${ctx.settings.slackApiUrl ?? 'https://slack.com/api'}/auth.test`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: '{}', signal: AbortSignal.timeout(10_000) });
          const body = (await res.json()) as { ok?: boolean; error?: string; team?: string };
          return body.ok
            ? { id: `slack:${spec.credential}`, kind: 'slack' as const, status: 'ok' as const, target: spec.credential!, node: n.id, message: `Slack accepts the token${body.team ? ` (workspace ${body.team})` : ''}.` }
            : { id: `slack:${spec.credential}`, kind: 'slack' as const, status: 'fail' as const, target: spec.credential!, node: n.id, message: `Slack refuses the token: ${body.error ?? 'unknown error'}.`, fix: 'Create a new bot token and save it as the secret.' };
        } catch (err) {
          return { id: `slack:${spec.credential}`, kind: 'slack' as const, status: 'warn' as const, target: spec.credential!, node: n.id, message: `Could not reach Slack to check the token: ${(err as Error).message}` };
        }
      });
    }
  }
  for (const c of await Promise.all(pending)) if (c) checks.push(c);

  // What is in place, so the list shows what was checked and not only what failed.
  for (const n of version.plan.nodes) {
    if (n.type !== 'tool') continue;
    const def = n.def as ToolNode;
    const spec = catalog.get(def.tool);
    if (spec && !checks.some((c) => c.node === n.id && c.status === 'fail')) checks.push({ id: `tool:${n.id}`, kind: 'tool', status: 'ok', target: def.tool, node: n.id, message: `${def.tool} is registered${spec.credential ? ` and its secret ${spec.credential} is set` : ''}.` });
  }
  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}
