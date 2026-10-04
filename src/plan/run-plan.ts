import type { PlanNode } from '../compiler/plan.js';
import type { TaintReport } from '../compiler/taint.js';
import type { AgentNode, RetrieveNode, ScriptNode } from '../definition/types.js';
import { parseProfile } from '../agents/profile.js';
import { profilePath } from '../compiler/compile.js';
import { EXECUTORS } from '../executors/capabilities.js';
import { packageFile } from '../server/packages.js';
import { loadCatalog } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { evaluateWorkerTrust } from '../server/trust.js';
import type { VersionRow } from '../server/workflows.js';
import type { PackageSignature } from '../security/signing.js';

/**
 * The run plan (spec section 3): before anything executes, every requirement of every node is
 * marked native, bridged, unsupported or unverified for this executor, worker and workspace;
 * policy coverage says which actions the gateway enforces, which the harness controls and which
 * are unobservable; taint paths and missing grants are listed. Unsupported blocks the run.
 */
export type Mark = 'native' | 'bridged' | 'unsupported' | 'unverified';
export type Enforcement = 'enforced' | 'harness' | 'unobservable';

export interface Requirement {
  name: string;
  mark: Mark;
  detail: string;
}

export interface Coverage {
  action: string;
  enforcement: Enforcement;
  detail: string;
}

export interface NodePlan {
  id: string;
  type: string;
  executor?: string;
  requirements: Requirement[];
  coverage: Coverage[];
  tainted?: string;
}

export interface Blocker {
  code: string;
  message: string;
  node?: string;
}

export interface RunPlanReport {
  workflow: string;
  version: number;
  package_hash: string;
  signer: { publisher?: string; verified: boolean; error?: string };
  ok: boolean;
  nodes: NodePlan[];
  taint: TaintReport;
  missing_grants: Array<{ kind: 'secret' | 'dataset' | 'tool'; name: string; node: string }>;
  worker_trust: Array<{ worker: string; name: string; policy: unknown; accepted: boolean; reason?: string }>;
  blockers: Blocker[];
}

export async function buildRunPlan(ctx: AppContext, workspaceId: string, version: VersionRow, principal?: { userId: string; role: string }): Promise<RunPlanReport> {
  const plan = version.plan;
  const catalog = await loadCatalog(ctx, workspaceId);
  const secrets = new Set((await ctx.pool.query(`SELECT DISTINCT name FROM secrets WHERE workspace_id=$1`, [workspaceId])).rows.map((r) => r.name as string));
  const workers = (
    await ctx.pool.query(`SELECT id, name, capabilities FROM workers WHERE workspace_id=$1 AND task_queue LIKE 'azhi-exec-%' AND last_heartbeat > now() - interval '30 seconds'`, [workspaceId])
  ).rows as Array<{ id: string; name: string; capabilities: { runtimes?: Record<string, { version: string }>; limits?: { memory?: boolean } } }>;
  const trust = await evaluateWorkerTrust(ctx, workspaceId, (version.signature as PackageSignature | null) ?? null, version.package_hash);
  const accepting = new Set(trust.workers.filter((w) => w.accepted).map((w) => w.worker));

  const blockers: Blocker[] = [];
  const missing: RunPlanReport['missing_grants'] = [];
  const nodes: NodePlan[] = [];

  const toolRequirement = (n: PlanNode, ref: string): Requirement => {
    const spec = catalog.get(ref);
    if (!spec) return { name: `tool ${ref}`, mark: 'unsupported', detail: 'not registered' };
    if (spec.credential && !secrets.has(spec.credential)) missing.push({ kind: 'secret', name: spec.credential, node: n.id });
    return {
      name: `tool ${ref}`,
      mark: spec.credential && !secrets.has(spec.credential) ? 'unsupported' : 'native',
      detail: `${spec.effect} via ${spec.transport.kind}${spec.credential ? `, credential '${spec.credential}' ${secrets.has(spec.credential) ? 'set' : 'MISSING'}` : ''}`,
    };
  };

  const workerRequirements = (runtime: string, memoryMb?: number): Requirement[] => {
    const capable = workers.filter((w) => w.capabilities.runtimes?.[runtime]);
    const reqs: Requirement[] = [];
    if (!workers.length) reqs.push({ name: `${runtime} runtime on a worker`, mark: 'unverified', detail: 'no worker online; the run will wait (worker_offline)' });
    else if (!capable.length) reqs.push({ name: `${runtime} runtime on a worker`, mark: 'unsupported', detail: `none of ${workers.length} online workers has ${runtime}` });
    else reqs.push({ name: `${runtime} runtime on a worker`, mark: 'native', detail: capable.map((w) => `${w.name}: ${runtime} ${w.capabilities.runtimes![runtime]!.version}`).join(', ') });
    if (memoryMb) {
      const limited = capable.filter((w) => w.capabilities.limits?.memory);
      reqs.push({ name: `memory limit ${memoryMb} MB`, mark: limited.length ? 'native' : capable.length ? 'unsupported' : 'unverified', detail: limited.length ? 'prlimit' : 'no worker can enforce memory limits' });
    }
    if (capable.length) {
      const trusted = capable.filter((w) => accepting.has(w.id));
      const refusals = trust.workers.filter((w) => !w.accepted && capable.some((c) => c.id === w.worker));
      reqs.push({
        name: 'worker trust policy accepts the package signer',
        mark: trusted.length ? 'native' : 'unsupported',
        detail: trusted.length ? `accepted by ${trusted.map((w) => w.name).join(', ')}` : refusals.map((r) => `${r.name}: ${r.reason}`).join('; '),
      });
      if (!trusted.length) blockers.push({ code: 'worker_trust_denied', message: `no capable worker will run this package (${refusals.map((r) => `${r.name}: ${r.reason}`).join('; ')})` });
    }
    return reqs;
  };

  for (const n of plan.nodes) {
    const np: NodePlan = { id: n.id, type: n.type, requirements: [], coverage: [] };
    if (plan.taint.tainted[n.id]) np.tainted = plan.taint.tainted[n.id];
    switch (n.type) {
      case 'tool':
        np.requirements.push(toolRequirement(n, n.tool!.ref));
        np.coverage.push({ action: `${n.tool!.ref} (${n.tool!.effect})`, enforcement: 'enforced', detail: n.tool!.effect === 'read' ? 'gateway authorises, validates and projects' : 'gateway authorises and ledgers the write' });
        break;
      case 'notify':
        np.requirements.push(toolRequirement(n, 'slack.post-message@1'));
        np.coverage.push({ action: 'slack.post-message@1 (write-dedupable)', enforcement: 'enforced', detail: 'gateway ledgers the post; dedupe by action ID in message metadata' });
        break;
      case 'script': {
        const def = n.def as ScriptNode;
        np.requirements.push(...workerRequirements(def.runtime, def.limits?.memory_mb));
        np.coverage.push(
          { action: 'tool calls from the script', enforcement: 'enforced', detail: 'only through the gateway with a run-scoped token' },
          { action: 'network and filesystem access from the script process', enforcement: 'unobservable', detail: 'a subprocess is not a sandbox; trusted-author packages only' },
        );
        break;
      }
      case 'parallel':
        if (n.tool) np.requirements.push(toolRequirement(n, n.tool.ref));
        else np.requirements.push(...workerRequirements((n.def as unknown as { node: ScriptNode }).node.runtime));
        np.coverage.push({ action: 'items', enforcement: 'enforced', detail: 'each item runs as its own tool call or script attempt' });
        break;
      case 'agent': {
        const def = n.def as AgentNode;
        const executor = def.executor ?? 'model-agent';
        np.executor = executor;
        const decl = EXECUTORS[executor];
        if (!decl) {
          np.requirements.push({ name: `executor ${executor}`, mark: 'unsupported', detail: 'unknown executor' });
          break;
        }
        const c = decl.capabilities;
        const mark = (field: keyof typeof c, ok: boolean, bridged = false): Mark => (!ok ? 'unsupported' : c.unverified?.includes(field as never) ? 'unverified' : bridged ? 'bridged' : 'native');
        np.requirements.push(
          { name: 'structured output', mark: mark('structuredOutput', c.structuredOutput !== 'none'), detail: `${c.structuredOutput}; up to 2 repair attempts` },
          { name: 'usage reporting', mark: mark('usage', c.usage !== 'unavailable'), detail: c.usage },
          { name: 'cancellation', mark: mark('cancellation', c.cancellation !== 'none'), detail: c.cancellation },
        );
        if (executor === 'model-agent') np.requirements.push(...(await modelRequirements(ctx, workspaceId, version.package_hash, def, n.id, secrets, missing)));
        if (def.tools?.length) np.requirements.push({ name: 'gateway tools', mark: mark('gatewayTools', c.gatewayTools !== 'none', c.gatewayTools === 'bridged'), detail: c.gatewayTools });
        for (const t of def.tools ?? []) np.requirements.push(toolRequirement(n, t));
        if (def.requires?.enforced_restrictions && c.ambientTools === 'uncontrolled') {
          np.requirements.push({ name: 'enforced restrictions', mark: 'unsupported', detail: `${executor} ambient tools are uncontrolled` });
        }
        np.coverage.push({ action: 'gateway tool calls', enforcement: 'enforced', detail: c.gatewayTools === 'bridged' ? 'bridged to the gateway over MCP' : 'platform-owned tool loop' });
        np.coverage.push({
          action: 'ambient (built-in) tools',
          enforcement: c.ambientTools === 'uncontrolled' ? 'unobservable' : c.ambientTools === 'disableable' && executor === 'model-agent' ? 'enforced' : 'harness',
          detail: executor === 'model-agent' ? 'none exist' : `${c.ambientTools}: ${decl.notes.join('; ')}`,
        });
        for (const d of def.datasets ?? []) np.requirements.push(await datasetRequirement(ctx, workspaceId, d, n.id, missing, principal));
        break;
      }
      case 'retrieve':
        for (const d of (n.def as RetrieveNode).datasets) np.requirements.push(await datasetRequirement(ctx, workspaceId, d, n.id, missing, principal));
        np.coverage.push({ action: 'dataset reads', enforcement: 'enforced', detail: 'dataset ACL checked before ranking' });
        break;
      case 'approval':
        np.coverage.push({ action: 'decision', enforcement: 'enforced', detail: 'recorded with identity, role check and timestamp' });
        break;
      default:
        break;
    }
    for (const r of np.requirements) if (r.mark === 'unsupported') blockers.push({ code: 'unsupported', message: `${r.name}: ${r.detail}`, node: n.id });
    nodes.push(np);
  }
  if (!trust.signer) blockers.push({ code: 'worker_trust_denied', message: `package signature: ${trust.signatureError}` });

  const unique = new Map(blockers.map((b) => [`${b.code}:${b.node ?? ''}:${b.message}`, b]));
  const needsWorkers = plan.nodes.some((n) => n.type === 'script' || (n.type === 'parallel' && !n.tool));
  const finalBlockers = [...unique.values()].filter((b) => b.code !== 'worker_trust_denied' || needsWorkers);
  return {
    workflow: version.slug,
    version: version.version,
    package_hash: version.package_hash,
    signer: { publisher: trust.signer, verified: Boolean(trust.signer), ...(trust.signatureError ? { error: trust.signatureError } : {}) },
    ok: finalBlockers.length === 0,
    nodes,
    taint: plan.taint,
    missing_grants: missing,
    worker_trust: trust.workers,
    blockers: finalBlockers,
  };
}

async function datasetRequirement(ctx: AppContext, workspaceId: string, ref: string, node: string, missing: RunPlanReport['missing_grants'], principal?: { userId: string; role: string }): Promise<Requirement> {
  const [name, tag = 'latest'] = ref.split('@');
  const ds = (await ctx.pool.query(`SELECT id, acl, trusted FROM datasets WHERE workspace_id=$1 AND name=$2`, [workspaceId, name])).rows[0];
  if (!ds) {
    missing.push({ kind: 'dataset', name: ref, node });
    return { name: `dataset ${ref}`, mark: 'unsupported', detail: 'dataset does not exist' };
  }
  const rev =
    tag === 'latest'
      ? (await ctx.pool.query(`SELECT max(revision) AS r FROM dataset_revisions WHERE dataset_id=$1`, [ds.id])).rows[0]?.r
      : (await ctx.pool.query(`SELECT revision AS r FROM dataset_tags WHERE dataset_id=$1 AND tag=$2`, [ds.id, tag])).rows[0]?.r;
  if (rev === undefined || rev === null) return { name: `dataset ${ref}`, mark: 'unsupported', detail: `tag '${tag}' does not resolve to a revision` };
  if (principal && !datasetAllows(ds.acl, principal)) {
    missing.push({ kind: 'dataset', name: ref, node });
    return { name: `dataset ${ref}`, mark: 'unsupported', detail: `${principal.userId} (${principal.role}) has no access` };
  }
  return { name: `dataset ${ref}`, mark: 'native', detail: `revision ${rev}${ds.trusted ? '' : ', marked untrusted'}` };
}

const RANK: Record<string, number> = { viewer: 0, operator: 1, author: 2, admin: 3, owner: 4 };
export function datasetAllows(acl: { roles?: string[]; users?: string[] }, p: { userId: string; role: string }): boolean {
  if (acl.users?.includes(p.userId)) return true;
  return (acl.roles ?? []).some((r) => RANK[p.role]! >= RANK[r]!);
}

/** The model binding, credential and budget enforceability of a model-agent node. */
async function modelRequirements(
  ctx: AppContext,
  workspaceId: string,
  packageHash: string,
  def: AgentNode,
  node: string,
  secrets: Set<string>,
  missing: RunPlanReport['missing_grants'],
): Promise<Requirement[]> {
  const path = profilePath(def.profile);
  let profile;
  try {
    profile = parseProfile((await packageFile(ctx, workspaceId, packageHash, path)).toString('utf8'), path);
  } catch (e) {
    return [{ name: `profile ${def.profile}`, mark: 'unsupported', detail: (e as Error).message }];
  }
  const reqs: Requirement[] = [];
  if (profile.model.provider === 'scripted') {
    reqs.push({ name: 'model binding', mark: 'native', detail: 'scripted provider (fixtures and tests only)' });
  } else {
    const model = profile.model.name && profile.model.name !== 'default' ? profile.model.name : ctx.settings.anthropicModel;
    reqs.push(
      model
        ? { name: 'model binding', mark: 'native', detail: `anthropic ${model}${profile.model.name && profile.model.name !== 'default' ? '' : ' (server default)'}` }
        : { name: 'model binding', mark: 'unsupported', detail: 'the profile uses the default model and AZHI_ANTHROPIC_MODEL is not set' },
    );
    const credential = profile.model.credential ?? 'anthropic-api-key';
    if (!secrets.has(credential)) missing.push({ kind: 'secret', name: credential, node });
    reqs.push({ name: `credential ${credential}`, mark: secrets.has(credential) ? 'native' : 'unsupported', detail: secrets.has(credential) ? 'set' : `MISSING (azhi secret set ${credential})` });
  }
  if (def.budget?.max_cost_usd !== undefined) {
    reqs.push(
      profile.pricing
        ? { name: `budget max_cost_usd ${def.budget.max_cost_usd}`, mark: 'native', detail: `estimated from pricing ${profile.pricing.revision}` }
        : { name: `budget max_cost_usd ${def.budget.max_cost_usd}`, mark: 'unverified', detail: 'the profile declares no pricing, so cost is unavailable and this cap cannot be enforced' },
    );
  }
  return reqs;
}
