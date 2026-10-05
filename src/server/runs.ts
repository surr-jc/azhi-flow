import type { AgentNode, RetrieveNode } from '../definition/types.js';
import { pinDatasets } from '../knowledge/datasets.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type pg from 'pg';
import { tx } from '../db/pool.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { buildRunPlan, type RunPlanReport } from '../plan/run-plan.js';
import type { RunInput, RunSnapshot } from '../runtime/types.js';
import { loadCatalog, loadToolRevision } from './catalog.js';
import type { ToolSpec } from '../gateway/types.js';
import { contentHash } from '../lib/hash.js';
import type { AppContext } from './context.js';
import type { VersionRow } from './workflows.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });

export interface CreateRunOptions {
  version: VersionRow;
  inputs: Record<string, unknown>;
  trigger: RunSnapshot['trigger'];
  createdBy: string | null;
  referenceTime?: Date;
  occurrenceId?: string;
  test?: boolean;
  /** `azhi test-node`: run only this node, with upstream outputs from fixtures. */
  testNode?: { node: string; fixtures: Record<string, unknown> };
  interpreterBuild: string;
  /** The run plan already built for this request; built here when absent (schedules). */
  plan?: RunPlanReport;
  /** A subworkflow run: its parent, and no outbox entry (the parent's workflow starts it as a child). */
  parent?: NonNullable<RunSnapshot['parent']>;
}

/**
 * Creates a run and its outbox entry in one transaction. The outbox dispatcher starts the
 * Temporal workflow, so a crash between the two never loses a run or starts one twice.
 * A schedule occurrence ID makes creation idempotent.
 */
function sameExceptRepos(a: ToolSpec, b: ToolSpec): boolean {
  const strip = ({ revision: _r, ...t }: ToolSpec) => ({ ...t, transport: { ...t.transport, config: { ...((t.transport as { config?: object }).config ?? {}), repos: null } } });
  return contentHash(strip(a)) === contentHash(strip(b));
}

export async function createRun(ctx: AppContext, workspaceId: string, o: CreateRunOptions): Promise<{ runId: string; created: boolean }> {
  const schema = o.version.plan.inputsSchema;
  if (schema) {
    const validate = ajv.compile(schema);
    if (!validate(o.inputs)) throw new AzhiError(ErrorClass.invalidInput, `inputs do not match the workflow's input schema: ${ajv.errorsText(validate.errors)}`);
  }
  const catalog = await loadCatalog(ctx, workspaceId);
  const toolRevisions: Record<string, number> = {};
  for (const n of o.version.plan.nodes) if (n.tool) toolRevisions[n.tool.ref] = n.tool.revision ?? catalog.revisions.get(n.tool.ref) ?? 0;
  for (const n of o.version.plan.nodes) for (const t of n.agentTools ?? []) toolRevisions[t.ref] ??= t.revision ?? catalog.revisions.get(t.ref) ?? 0;
  toolRevisions['slack.post-message@1'] ??= 0;
  // A version pins the tool revisions it was compiled against, except for the repository list:
  // a later revision that changes only `transport.config.repos` (azhi example repos, Allowed
  // repositories) applies to new runs of versions saved before it.
  for (const [ref, pinned] of Object.entries(toolRevisions)) {
    const latest = catalog.get(ref);
    if (!latest?.revision || latest.revision <= pinned) continue;
    const old = await loadToolRevision(ctx, workspaceId, ref, pinned);
    if (old && sameExceptRepos(old, latest)) toolRevisions[ref] = latest.revision;
  }

  if (o.testNode) {
    const target = o.version.plan.nodes.find((n) => n.id === o.testNode!.node);
    if (!target) throw new AzhiError(ErrorClass.invalidInput, `workflow has no node '${o.testNode.node}'`);
    const missingDeps = target.dataDeps.filter((d) => !(d in o.testNode!.fixtures));
    if (missingDeps.length) throw new AzhiError(ErrorClass.invalidInput, `fixture needs outputs for ${missingDeps.map((d) => `nodes.${d}`).join(', ')}`);
  }
  const datasetRefs = o.version.plan.nodes.flatMap((n) => (n.type === 'retrieve' ? (n.def as RetrieveNode).datasets : n.type === 'agent' ? ((n.def as AgentNode).datasets ?? []) : []));
  const datasetRevisions = datasetRefs.length ? await pinDatasets(ctx, workspaceId, datasetRefs) : undefined;
  // Dataset access is checked as the run's creator; scheduled runs act as the version's publisher.
  const principal = (
    await ctx.pool.query(
      `SELECT u.id AS "userId", u.role FROM users u WHERE u.id = coalesce((SELECT id FROM users WHERE id=$1), (SELECT published_by FROM workflow_versions WHERE id=$2))`,
      [o.createdBy, o.version.id],
    )
  ).rows[0] as { userId: string; role: string } | undefined;

  // The plan as it stood when the run was created is kept with the run, so the run page shows
  // the coverage this run actually had, not whatever the workers look like later.
  const plan = o.plan ?? (await buildRunPlan(ctx, workspaceId, o.version, principal));

  // Spend limits hold back every trigger, scheduled runs included; test runs are exempt like
  // other plan blockers, since `azhi test-node` is how authors debug.
  const overBudget = plan.blockers.find((b) => b.code === 'budget_exceeded');
  if (overBudget && !o.test) throw new AzhiError(ErrorClass.unsupportedCapability, `refused: ${overBudget.message}`, { blockers: [overBudget] });

  const runId = newId('run');
  const snapshot: RunSnapshot = {
    reference_time: (o.referenceTime ?? new Date()).toISOString(),
    interpreter_build: o.interpreterBuild,
    package_hash: o.version.package_hash,
    workflow_version_id: o.version.id,
    tool_revisions: toolRevisions,
    trigger: o.trigger,
    gateway_queue: ctx.settings.gatewayQueue,
    ...(o.testNode ? { test_node: o.testNode } : {}),
    ...(datasetRevisions ? { dataset_revisions: datasetRevisions } : {}),
    ...(principal ? { principal } : {}),
    ...(o.occurrenceId ? { occurrence_id: o.occurrenceId } : {}),
    ...(o.parent ? { parent: o.parent } : {}),
  };
  return tx(ctx.db, async (c: pg.PoolClient) => {
    const r = await c.query(
      `INSERT INTO runs(id, workspace_id, workflow_version_id, state, inputs, snapshot, interpreter_build, trigger, occurrence_id, test, created_by)
       VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (occurrence_id) DO NOTHING`,
      [runId, workspaceId, o.version.id, JSON.stringify(o.inputs), JSON.stringify(snapshot), o.interpreterBuild, o.trigger, o.occurrenceId ?? null, o.test ?? false, o.createdBy],
    );
    if (r.rowCount === 0) {
      const existing = (await c.query(`SELECT id FROM runs WHERE occurrence_id=$1`, [o.occurrenceId])).rows[0].id as string;
      return { runId: existing, created: false };
    }
    await c.query(`INSERT INTO run_events(workspace_id, run_id, kind, data) VALUES ($1,$2,'run.queued',$3)`, [workspaceId, runId, JSON.stringify({ state: 'queued', trigger: o.trigger })]);
    await c.query(`INSERT INTO run_events(workspace_id, run_id, kind, data) VALUES ($1,$2,'run.planned',$3)`, [workspaceId, runId, JSON.stringify(plan)]);
    if (!o.parent) {
      await c.query(`INSERT INTO outbox(workspace_id, kind, payload) VALUES ($1,'run.start',$2)`, [workspaceId, JSON.stringify({ run_id: runId })]);
      await c.query(`NOTIFY azhi_outbox`);
    }
    return { runId, created: true };
  });
}

export async function requestCancel(ctx: AppContext, workspaceId: string, runId: string, actor: string) {
  const r = await ctx.pool.query(`SELECT state FROM runs WHERE id=$1 AND workspace_id=$2`, [runId, workspaceId]);
  if (!r.rows[0]) throw new AzhiError(ErrorClass.invalidInput, `run ${runId} not found`);
  await ctx.pool.query(`INSERT INTO outbox(workspace_id, kind, payload) VALUES ($1,'run.cancel',$2)`, [workspaceId, JSON.stringify({ run_id: runId, by: actor })]);
  await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, data) VALUES ($1,$2,'run.cancel_requested',$3)`, [workspaceId, runId, JSON.stringify({ by: actor })]);
  await ctx.pool.query(`NOTIFY azhi_outbox`);
}

export async function getRunDetail(ctx: AppContext, workspaceId: string, runId: string) {
  const run = (
    await ctx.pool.query(
      `SELECT r.*, w.slug AS workflow, v.version AS workflow_version FROM runs r
       JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
       WHERE r.id=$1 AND r.workspace_id=$2`,
      [runId, workspaceId],
    )
  ).rows[0];
  if (!run) return undefined;
  const [attempts, actions, transitions, requests, decisions, usage, manifests, planned] = await Promise.all([
    ctx.pool.query(`SELECT node_id, attempt, state, worker_id, started_at, ended_at, error, output FROM node_attempts WHERE run_id=$1 ORDER BY started_at, node_id, attempt`, [runId]),
    ctx.pool.query(`SELECT id, node_id, tool, effect, state, fence, receipt, error, target, created_at, updated_at FROM actions WHERE run_id=$1 ORDER BY created_at`, [runId]),
    ctx.pool.query(
      `SELECT t.action_id, t.state, t.fence, t.note, t.at FROM action_transitions t JOIN actions a ON a.id = t.action_id WHERE a.run_id=$1 ORDER BY t.seq`,
      [runId],
    ),
    ctx.pool.query(`SELECT node_id, data, at FROM run_events WHERE run_id=$1 AND kind='approval.requested' ORDER BY seq`, [runId]),
    ctx.pool.query(`SELECT node_id, decision, decided_by, data, decided_at FROM approvals WHERE run_id=$1`, [runId]),
    ctx.pool.query(
      `SELECT node_id, attempt, turn, executor, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost::float8 AS cost, currency, cost_label, pricing_revision, premium_requests::float8 AS premium_requests, premium_multiplier::float8 AS premium_multiplier
       FROM usage_records WHERE run_id=$1 ORDER BY seq`,
      [runId],
    ),
    ctx.pool.query(`SELECT node_id, attempt, turn, tainted, items, total_tokens, token_source FROM context_manifests WHERE run_id=$1 ORDER BY node_id, attempt, turn`, [runId]),
    ctx.pool.query(`SELECT data FROM run_events WHERE run_id=$1 AND kind='run.planned' ORDER BY seq LIMIT 1`, [runId]),
  ]);
  return {
    run,
    plan: (planned.rows[0]?.data as RunPlanReport | undefined) ?? null,
    approvals: requests.rows.map((r) => {
      const d = decisions.rows.find((x) => x.node_id === r.node_id);
      return { node_id: r.node_id, requested_at: r.at, request: r.data, ...(d ? { decision: d.decision, decided_by: d.decided_by, decided_at: d.decided_at, data: d.data } : { decision: null }) };
    }),
    usage: summariseUsage(usage.rows),
    context_manifests: manifests.rows,
    attempts: attempts.rows,
    actions: actions.rows.map((a) => ({ ...a, transitions: transitions.rows.filter((t) => t.action_id === a.id) })),
  };
}

export async function runEvents(ctx: AppContext, workspaceId: string, runId: string, after = 0, limit = 500) {
  return (
    await ctx.pool.query(`SELECT seq, at, kind, node_id, data FROM run_events WHERE run_id=$1 AND workspace_id=$2 AND seq > $3 ORDER BY seq LIMIT $4`, [
      runId,
      workspaceId,
      after,
      limit,
    ])
  ).rows as Array<{ seq: number; at: Date; kind: string; node_id: string | null; data: Record<string, unknown> }>;
}

/** Usage completeness (spec section 11): the share of turns whose token usage is known. */
export function summariseUsage(rows: Array<Record<string, any>>) {
  const known = rows.filter((r) => r.input_tokens !== null && r.output_tokens !== null);
  const sum = (k: string) => (known.length ? known.reduce((n, r) => n + (r[k] ?? 0), 0) : null);
  const costs = rows.filter((r) => r.cost_label !== 'unavailable');
  return {
    turns: rows.length,
    completeness_pct: rows.length ? Math.round((known.length / rows.length) * 100) : null,
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    cost: costs.length === rows.length && rows.length ? { amount: costs.reduce((n, r) => n + r.cost, 0), currency: costs[0]!.currency, label: 'estimated', pricing_revision: costs[0]!.pricing_revision } : { amount: null, label: 'unavailable' },
    premium_requests: premiumRequests(rows),
    records: rows,
  };
}

/** What the interpreter workflow starts with for a stored run. */
export async function loadRunInput(ctx: AppContext, workspaceId: string, runId: string) {
  const run = (
    await ctx.pool.query(`SELECT r.id, r.inputs, r.snapshot, r.test, v.plan FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id=$1 AND r.workspace_id=$2`, [runId, workspaceId])
  ).rows[0] as { id: string; inputs: Record<string, unknown>; snapshot: RunSnapshot; test: boolean; plan: RunInput['plan'] };
  const input: RunInput = { runId: run.id, workspaceId, plan: run.plan, inputs: run.inputs, snapshot: run.snapshot, mockWrites: run.test };
  return input;
}


/** GitHub Copilot turns, per model: premium requests (prompts x multiplier) and their estimated cost. Null without Copilot turns. */
function premiumRequests(rows: Array<Record<string, any>>) {
  const copilot = rows.filter((r) => r.premium_requests !== null && r.premium_requests !== undefined);
  if (!copilot.length) return null;
  const models = new Map<string, { model: string; multiplier: number; premium_requests: number; cost: number; currency: string; assumed: boolean }>();
  for (const r of copilot) {
    const key = `${r.model}|${r.premium_multiplier}`;
    const m = models.get(key) ?? { model: r.model, multiplier: r.premium_multiplier, premium_requests: 0, cost: 0, currency: r.currency, assumed: /assumed/.test(r.pricing_revision ?? '') };
    m.premium_requests += r.premium_requests;
    m.cost += r.cost ?? 0;
    models.set(key, m);
  }
  const list = [...models.values()].map((m) => ({ ...m, premium_requests: Math.round(m.premium_requests * 1000) / 1000, cost: Math.round(m.cost * 1e6) / 1e6 }));
  const total = list.reduce((n, m) => n + m.premium_requests, 0);
  const cost = list.reduce((n, m) => n + m.cost, 0);
  // The price is the same for every Copilot turn unless profiles override it; report it only then.
  const prices = new Set(copilot.filter((r) => r.premium_requests > 0).map((r) => Math.round((r.cost / r.premium_requests) * 1e6) / 1e6));
  return { total: Math.round(total * 1000) / 1000, cost: Math.round(cost * 1e6) / 1e6, currency: copilot[0]!.currency, per_premium_request: prices.size === 1 ? [...prices][0]! : null, models: list };
}
