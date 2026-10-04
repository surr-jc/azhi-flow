import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ExecutionPlan } from '../compiler/plan.js';
import type { ApprovalNode } from '../definition/types.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { buildRunPlan } from '../plan/run-plan.js';
import { audit } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { resolveVersion } from '../server/workflows.js';
import { requireRole } from './auth.js';

/**
 * Read endpoints for mission control (docs/mission-control-plan.md). They summarise state the
 * server already keeps; every write the web app makes goes through the existing endpoints, so
 * role checks, the run plan and the audit log apply unchanged. Nothing here returns a secret.
 */
const OPEN_STATES = ['queued', 'running', 'waiting', 'cancelling'];

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

/** Approvals waiting for a decision: requested, not decided, run still open. */
async function pendingApprovals(ctx: AppContext, workspaceId: string) {
  const rows = (
    await ctx.pool.query(
      `SELECT e.run_id, e.node_id, e.data AS request, e.at AS requested_at, r.state, r.test, w.slug AS workflow, v.version, v.plan
       FROM run_events e JOIN runs r ON r.id = e.run_id JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
       WHERE e.workspace_id=$1 AND e.kind='approval.requested' AND r.state = ANY($2)
         AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = e.run_id AND a.node_id = e.node_id)
       ORDER BY e.at`,
      [workspaceId, OPEN_STATES],
    )
  ).rows;
  return rows.map((r) => {
    const def = ((r.plan as ExecutionPlan).nodes.find((n) => n.id === r.node_id)?.def ?? {}) as ApprovalNode;
    return {
      run_id: r.run_id,
      node_id: r.node_id,
      workflow: r.workflow,
      version: r.version,
      run_state: r.state,
      test: r.test,
      requested_at: r.requested_at,
      request: r.request,
      role: def.role ?? 'operator',
      decision_schema: def.decision_schema ?? null,
      expires_at: (r.request as { expires_at?: string }).expires_at ?? null,
    };
  });
}

async function nextSchedules(ctx: AppContext, workspaceId: string, limit?: number) {
  return (
    await ctx.pool.query(
      `SELECT s.id, w.slug AS workflow, s.cron, s.timezone, s.inputs, s.enabled, s.next_occurrence_at, s.created_at,
         (SELECT row_to_json(x) FROM (SELECT r.id, r.state, r.created_at FROM runs r WHERE r.occurrence_id LIKE s.id || '@%' ORDER BY r.created_at DESC LIMIT 1) x) AS last_run
       FROM schedules s JOIN workflows w ON w.id = s.workflow_id WHERE s.workspace_id=$1
       ORDER BY s.enabled DESC, s.next_occurrence_at NULLS LAST ${limit ? `LIMIT ${Number(limit)}` : ''}`,
      [workspaceId],
    )
  ).rows;
}

async function spend(ctx: AppContext, workspaceId: string, since: string) {
  const r = (
    await ctx.pool.query(
      `SELECT count(*)::int AS turns, count(*) FILTER (WHERE cost_label = 'unavailable')::int AS unpriced,
         COALESCE(SUM(cost), 0)::float8 AS cost, MAX(currency) AS currency,
         SUM(input_tokens)::float8 AS input_tokens, SUM(output_tokens)::float8 AS output_tokens
       FROM usage_records WHERE workspace_id=$1 AND at >= now() - $2::interval`,
      [workspaceId, since],
    )
  ).rows[0];
  // Unknown is not zero (spec section 11): with unpriced turns the total is a lower bound.
  return { turns: r.turns, unpriced_turns: r.unpriced, amount: r.turns ? r.cost : 0, currency: r.currency ?? 'USD', complete: r.unpriced === 0, input_tokens: r.input_tokens, output_tokens: r.output_tokens };
}

export function registerMissionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/overview', async (req) => {
    const p = user(req);
    const ws = p.workspaceId;
    const [open, recent, workers, approvals, today, week, schedules] = await Promise.all([
      ctx.pool.query(`SELECT state, count(*)::int AS n FROM runs WHERE workspace_id=$1 AND state = ANY($2) GROUP BY state`, [ws, OPEN_STATES]),
      ctx.pool.query(`SELECT state, count(*)::int AS n FROM runs WHERE workspace_id=$1 AND ended_at >= now() - interval '24 hours' GROUP BY state`, [ws]),
      ctx.pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE last_heartbeat > now() - interval '30 seconds')::int AS online FROM workers WHERE workspace_id=$1`, [ws]),
      pendingApprovals(ctx, ws),
      spend(ctx, ws, '24 hours'),
      spend(ctx, ws, '7 days'),
      nextSchedules(ctx, ws, 5),
    ]);
    const counts = (rows: Array<{ state: string; n: number }>) => Object.fromEntries(rows.map((r) => [r.state, r.n]));
    return {
      open: counts(open.rows),
      last_24h: counts(recent.rows),
      workers: workers.rows[0],
      approvals: { pending: approvals.length, mine: approvals.filter((a) => canDecide(p.role, a.role)).length },
      spend: { today, week },
      schedules: schedules.filter((s) => s.enabled),
    };
  });

  app.get('/v1/approvals', async (req) => {
    const p = user(req);
    return (await pendingApprovals(ctx, p.workspaceId)).map((a) => ({ ...a, can_decide: canDecide(p.role, a.role) }));
  });

  app.get('/v1/alerts', async (req) => {
    const p = user(req);
    return computeAlerts(ctx, p);
  });

  app.get('/v1/workflows/summary', async (req) => {
    const p = user(req);
    return (
      await ctx.pool.query(
        `SELECT w.slug, w.created_at,
           (SELECT row_to_json(x) FROM (SELECT v.id, v.version, v.draft, v.signature IS NOT NULL AS signed, v.created_at, v.definition->>'name' AS name, v.definition->>'description' AS description
              FROM workflow_versions v WHERE v.workflow_id = w.id ORDER BY v.version DESC LIMIT 1) x) AS latest,
           (SELECT row_to_json(x) FROM (SELECT v.id, v.version, v.signature IS NOT NULL AS signed, v.created_at
              FROM workflow_versions v WHERE v.workflow_id = w.id AND NOT v.draft ORDER BY v.version DESC LIMIT 1) x) AS published,
           (SELECT row_to_json(x) FROM (SELECT s.id, s.cron, s.timezone, s.enabled, s.next_occurrence_at FROM schedules s WHERE s.workflow_id = w.id LIMIT 1) x) AS schedule,
           (SELECT row_to_json(x) FROM (SELECT r.id, r.state, r.created_at FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id
              WHERE v.workflow_id = w.id ORDER BY r.created_at DESC LIMIT 1) x) AS last_run
         FROM workflows w WHERE w.workspace_id=$1 ORDER BY w.slug`,
        [p.workspaceId],
      )
    ).rows;
  });

  app.get('/v1/workflows/:slug/versions', async (req) => {
    const p = user(req);
    const { slug } = req.params as { slug: string };
    return (
      await ctx.pool.query(
        `SELECT v.id, v.version, v.draft, v.package_hash, v.signature IS NOT NULL AS signed, v.created_at, v.published_by
         FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE w.workspace_id=$1 AND w.slug=$2 ORDER BY v.version DESC`,
        [p.workspaceId, slug],
      )
    ).rows;
  });

  app.get('/v1/schedules/summary', async (req) => nextSchedules(ctx, user(req).workspaceId));

  // Turning a schedule on or off; the cron and inputs stay as published (admin, audited).
  app.patch('/v1/schedules/:id', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const { id } = req.params as { id: string };
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const r = await ctx.pool.query(`UPDATE schedules SET enabled=$3 WHERE id=$1 AND workspace_id=$2 RETURNING id, enabled`, [id, p.workspaceId, enabled]);
    if (!r.rowCount) throw new AzhiError(ErrorClass.invalidInput, `schedule ${id} not found`);
    await audit(ctx, p.workspaceId, p.userId, 'schedule.changed', { id, enabled });
    return r.rows[0];
  });

  app.get('/v1/usage/summary', async (req) => {
    const p = user(req);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
    const [byDay, byWorkflow] = await Promise.all([
      ctx.pool.query(
        `SELECT date_trunc('day', u.at) AS day, count(*)::int AS turns, count(*) FILTER (WHERE u.cost_label='unavailable')::int AS unpriced,
           COALESCE(SUM(u.cost),0)::float8 AS cost, SUM(u.input_tokens)::float8 AS input_tokens, SUM(u.output_tokens)::float8 AS output_tokens
         FROM usage_records u WHERE u.workspace_id=$1 AND u.at >= now() - make_interval(days => $2) GROUP BY 1 ORDER BY 1`,
        [p.workspaceId, days],
      ),
      ctx.pool.query(
        `SELECT w.slug AS workflow, count(DISTINCT u.run_id)::int AS runs, count(*)::int AS turns, count(*) FILTER (WHERE u.cost_label='unavailable')::int AS unpriced,
           COALESCE(SUM(u.cost),0)::float8 AS cost, SUM(u.input_tokens)::float8 AS input_tokens, SUM(u.output_tokens)::float8 AS output_tokens
         FROM usage_records u JOIN runs r ON r.id = u.run_id JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
         WHERE u.workspace_id=$1 AND u.at >= now() - make_interval(days => $2) GROUP BY 1 ORDER BY cost DESC`,
        [p.workspaceId, days],
      ),
    ]);
    return { days, by_day: byDay.rows, by_workflow: byWorkflow.rows };
  });

  app.get('/v1/audit', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() }).parse(req.query);
    return (
      await ctx.pool.query(
        `SELECT seq::int AS seq, actor, kind, data, at FROM audit_events WHERE workspace_id=$1 AND ($2::bigint IS NULL OR seq < $2) ORDER BY seq DESC LIMIT $3`,
        [p.workspaceId, q.before ?? null, q.limit],
      )
    ).rows;
  });
}

const RANK: Record<string, number> = { viewer: 0, operator: 1, author: 2, admin: 3, owner: 4 };
const canDecide = (role: string, required: string) => (RANK[role] ?? -1) >= (RANK[required] ?? 1);

export interface Alert {
  level: 'critical' | 'warning' | 'info';
  kind: string;
  message: string;
  run_id?: string;
  workflow?: string;
  at?: string;
}

/** Alerts derived from state the server already keeps (docs/mission-control-plan.md). */
async function computeAlerts(ctx: AppContext, p: { workspaceId: string; userId: string; role: string }): Promise<Alert[]> {
  const ws = p.workspaceId;
  const alerts: Alert[] = [];
  const [failed, unknown, workers, waitingOffline, approvals, schedules] = await Promise.all([
    ctx.pool.query(
      `SELECT r.id, r.state, r.ended_at, r.error, w.slug FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
       WHERE r.workspace_id=$1 AND NOT r.test AND r.state IN ('failed','delivery_failed','expired') AND r.ended_at >= now() - interval '24 hours' ORDER BY r.ended_at DESC LIMIT 20`,
      [ws],
    ),
    ctx.pool.query(
      `SELECT a.id, a.run_id, a.tool, a.updated_at, w.slug FROM actions a JOIN runs r ON r.id = a.run_id JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
       WHERE r.workspace_id=$1 AND a.state='outcome_unknown' ORDER BY a.updated_at DESC LIMIT 20`,
      [ws],
    ),
    ctx.pool.query(`SELECT count(*) FILTER (WHERE last_heartbeat > now() - interval '30 seconds')::int AS online, count(*)::int AS total FROM workers WHERE workspace_id=$1`, [ws]),
    ctx.pool.query(`SELECT count(*)::int AS n FROM runs WHERE workspace_id=$1 AND state='waiting' AND flags->'waiting_reason'->>'reason' = 'worker_offline'`, [ws]),
    pendingApprovals(ctx, ws),
    ctx.pool.query(`SELECT s.id, w.slug FROM schedules s JOIN workflows w ON w.id = s.workflow_id WHERE s.workspace_id=$1 AND s.enabled`, [ws]),
  ]);
  for (const r of failed.rows) {
    alerts.push({ level: 'critical', kind: `run.${r.state}`, message: `${r.slug} ${r.state.replace('_', ' ')}${r.error?.message ? `: ${r.error.message}` : ''}`, run_id: r.id, workflow: r.slug, at: r.ended_at });
  }
  for (const a of unknown.rows) {
    alerts.push({ level: 'critical', kind: 'action.outcome_unknown', message: `${a.tool} in ${a.slug}: the outcome of this write is unknown and needs a person to check it`, run_id: a.run_id, workflow: a.slug, at: a.updated_at });
  }
  const w = workers.rows[0];
  if (w.online === 0) alerts.push({ level: w.total ? 'critical' : 'warning', kind: 'workers.none_online', message: w.total ? `No worker is online (${w.total} registered)` : 'No worker has registered yet' });
  if (waitingOffline.rows[0].n) alerts.push({ level: 'critical', kind: 'runs.worker_offline', message: `${waitingOffline.rows[0].n} run(s) are waiting for an offline worker` });
  const soon = Date.now() + 60 * 60 * 1000;
  for (const a of approvals) {
    if (a.expires_at && new Date(a.expires_at).getTime() < soon) {
      alerts.push({ level: 'warning', kind: 'approval.expiring', message: `Approval ${a.node_id} on ${a.workflow} expires within the hour`, run_id: a.run_id, workflow: a.workflow, at: a.expires_at });
    }
  }
  // A scheduled workflow whose current plan has blockers is likely to fail at its next occurrence.
  for (const s of schedules.rows) {
    const v = await resolveVersion(ctx, ws, `${s.slug}@latest`);
    if (!v) {
      alerts.push({ level: 'warning', kind: 'schedule.no_version', message: `${s.slug} is scheduled but has no published version`, workflow: s.slug });
      continue;
    }
    const plan = await buildRunPlan(ctx, ws, v, { userId: p.userId, role: p.role });
    if (!plan.ok) {
      alerts.push({ level: 'warning', kind: 'schedule.plan_blocked', message: `${s.slug}: the run plan has blockers, so the next scheduled run is likely to fail (${plan.blockers.map((b) => b.message).join('; ')})`, workflow: s.slug });
    }
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.level] - rank[b.level]);
}
