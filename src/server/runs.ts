import type { AgentNode, RetrieveNode } from '../definition/types.js';
import { pinDatasets } from '../knowledge/datasets.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type pg from 'pg';
import { tx } from '../db/pool.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { RunSnapshot } from '../runtime/types.js';
import { loadCatalog } from './catalog.js';
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
  interpreterBuild: string;
}

/**
 * Creates a run and its outbox entry in one transaction. The outbox dispatcher starts the
 * Temporal workflow, so a crash between the two never loses a run or starts one twice.
 * A schedule occurrence ID makes creation idempotent.
 */
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

  const datasetRefs = o.version.plan.nodes.flatMap((n) => (n.type === 'retrieve' ? (n.def as RetrieveNode).datasets : n.type === 'agent' ? ((n.def as AgentNode).datasets ?? []) : []));
  const datasetRevisions = datasetRefs.length ? await pinDatasets(ctx, workspaceId, datasetRefs) : undefined;
  // Dataset access is checked as the run's creator; scheduled runs act as the version's publisher.
  const principal = (
    await ctx.pool.query(
      `SELECT u.id AS "userId", u.role FROM users u WHERE u.id = coalesce((SELECT id FROM users WHERE id=$1), (SELECT published_by FROM workflow_versions WHERE id=$2))`,
      [o.createdBy, o.version.id],
    )
  ).rows[0] as { userId: string; role: string } | undefined;

  const runId = newId('run');
  const snapshot: RunSnapshot = {
    reference_time: (o.referenceTime ?? new Date()).toISOString(),
    interpreter_build: o.interpreterBuild,
    package_hash: o.version.package_hash,
    workflow_version_id: o.version.id,
    tool_revisions: toolRevisions,
    trigger: o.trigger,
    gateway_queue: ctx.settings.gatewayQueue,
    ...(datasetRevisions ? { dataset_revisions: datasetRevisions } : {}),
    ...(principal ? { principal } : {}),
    ...(o.occurrenceId ? { occurrence_id: o.occurrenceId } : {}),
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
    await c.query(`INSERT INTO outbox(workspace_id, kind, payload) VALUES ($1,'run.start',$2)`, [workspaceId, JSON.stringify({ run_id: runId })]);
    await c.query(`NOTIFY azhi_outbox`);
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
  const [attempts, actions, transitions, requests, decisions, usage, manifests] = await Promise.all([
    ctx.pool.query(`SELECT node_id, attempt, state, worker_id, started_at, ended_at, error, output FROM node_attempts WHERE run_id=$1 ORDER BY started_at, node_id, attempt`, [runId]),
    ctx.pool.query(`SELECT id, node_id, tool, effect, state, fence, receipt, error, target, created_at, updated_at FROM actions WHERE run_id=$1 ORDER BY created_at`, [runId]),
    ctx.pool.query(
      `SELECT t.action_id, t.state, t.fence, t.note, t.at FROM action_transitions t JOIN actions a ON a.id = t.action_id WHERE a.run_id=$1 ORDER BY t.seq`,
      [runId],
    ),
    ctx.pool.query(`SELECT node_id, data, at FROM run_events WHERE run_id=$1 AND kind='approval.requested' ORDER BY seq`, [runId]),
    ctx.pool.query(`SELECT node_id, decision, decided_by, data, decided_at FROM approvals WHERE run_id=$1`, [runId]),
    ctx.pool.query(
      `SELECT node_id, attempt, turn, executor, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost::float8 AS cost, currency, cost_label, pricing_revision
       FROM usage_records WHERE run_id=$1 ORDER BY seq`,
      [runId],
    ),
    ctx.pool.query(`SELECT node_id, attempt, turn, tainted, items, total_tokens, token_source FROM context_manifests WHERE run_id=$1 ORDER BY node_id, attempt, turn`, [runId]),
  ]);
  return {
    run,
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
    records: rows,
  };
}
