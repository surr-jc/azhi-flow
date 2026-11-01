import { AzhiError, ErrorClass } from '../lib/errors.js';
import { pendingApprovals } from './alerts.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';
import { opencodeMajorSetting } from './repo-slots.js';

/**
 * Workspace summaries behind mission control's read endpoints (src/api/mission.ts) and the
 * assistant's tools (src/assistant/tools.ts), so both read the same numbers. Nothing here
 * returns a secret.
 */
const OPEN_STATES = ['queued', 'running', 'waiting', 'cancelling'];
const FAILED_STATES = ['failed', 'delivery_failed', 'expired'];

const RANK: Record<string, number> = { viewer: 0, operator: 1, author: 2, admin: 3, owner: 4 };
export const canDecide = (role: string, required: string) => (RANK[role] ?? -1) >= (RANK[required] ?? 1);

export async function nextSchedules(ctx: AppContext, workspaceId: string, limit?: number) {
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
         SUM(input_tokens)::float8 AS input_tokens, SUM(output_tokens)::float8 AS output_tokens, SUM(credits)::float8 AS credits
       FROM usage_records WHERE workspace_id=$1 AND at >= now() - $2::interval`,
      [workspaceId, since],
    )
  ).rows[0];
  // Unknown is not zero (spec section 11): with unpriced turns the total is a lower bound.
  return { turns: r.turns, unpriced_turns: r.unpriced, amount: r.turns ? r.cost : 0, currency: r.currency ?? 'USD', complete: r.unpriced === 0, input_tokens: r.input_tokens, output_tokens: r.output_tokens, credits: r.credits };
}

export async function workspaceOverview(ctx: AppContext, p: { workspaceId: string; role: string }) {
  const ws = p.workspaceId;
  const [open, recent, workers, approvals, today, week, schedules, byDay, byWorkflow] = await Promise.all([
    ctx.pool.query(`SELECT state, count(*)::int AS n FROM runs WHERE workspace_id=$1 AND state = ANY($2) GROUP BY state`, [ws, OPEN_STATES]),
    ctx.pool.query(`SELECT state, count(*)::int AS n FROM runs WHERE workspace_id=$1 AND ended_at >= now() - interval '24 hours' GROUP BY state`, [ws]),
    ctx.pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE last_heartbeat > now() - interval '30 seconds')::int AS online FROM workers WHERE workspace_id=$1`, [ws]),
    pendingApprovals(ctx, ws),
    spend(ctx, ws, '24 hours'),
    spend(ctx, ws, '7 days'),
    nextSchedules(ctx, ws, 5),
    // Runs started per UTC day over 28 days, so the app can compare the last 14 with the 14 before.
    ctx.pool.query(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS started, count(*) FILTER (WHERE ended_at IS NOT NULL)::int AS ended,
         count(*) FILTER (WHERE state='succeeded')::int AS succeeded, count(*) FILTER (WHERE state = ANY($2))::int AS failed
       FROM runs WHERE workspace_id=$1 AND created_at >= now() - interval '28 days' GROUP BY 1 ORDER BY 1`,
      [ws, FAILED_STATES],
    ),
    ctx.pool.query(
      `SELECT w.slug AS workflow, count(*)::int AS runs, count(*) FILTER (WHERE r.state='succeeded')::int AS succeeded
       FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
       WHERE r.workspace_id=$1 AND r.created_at >= now() - interval '14 days' GROUP BY 1 ORDER BY runs DESC, workflow`,
      [ws],
    ),
  ]);
  const counts = (rows: Array<{ state: string; n: number }>) => Object.fromEntries(rows.map((r) => [r.state, r.n]));
  return {
    open: counts(open.rows),
    last_24h: counts(recent.rows),
    workers: workers.rows[0],
    approvals: { pending: approvals.length, mine: approvals.filter((a) => canDecide(p.role, a.role)).length },
    spend: { today, week },
    schedules: schedules.filter((s) => s.enabled),
    runs_by_day: byDay.rows,
    runs_by_workflow: byWorkflow.rows,
  };
}

export async function workflowSummaries(ctx: AppContext, workspaceId: string) {
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
      [workspaceId],
    )
  ).rows;
}

export async function workflowVersions(ctx: AppContext, workspaceId: string, slug: string) {
  return (
    await ctx.pool.query(
      `SELECT v.id, v.version, v.draft, v.package_hash, v.signature IS NOT NULL AS signed, v.created_at, v.published_by
       FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE w.workspace_id=$1 AND w.slug=$2 ORDER BY v.version DESC`,
      [workspaceId, slug],
    )
  ).rows;
}

export async function usageSummary(ctx: AppContext, workspaceId: string, days: number) {
  const [byDay, byWorkflow] = await Promise.all([
    ctx.pool.query(
      `SELECT to_char(u.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS turns, count(*) FILTER (WHERE u.cost_label='unavailable')::int AS unpriced,
         COALESCE(SUM(u.cost),0)::float8 AS cost, SUM(u.input_tokens)::float8 AS input_tokens, SUM(u.output_tokens)::float8 AS output_tokens, SUM(u.credits)::float8 AS credits
       FROM usage_records u WHERE u.workspace_id=$1 AND u.at >= now() - make_interval(days => $2) GROUP BY 1 ORDER BY 1`,
      [workspaceId, days],
    ),
    ctx.pool.query(
      `SELECT w.slug AS workflow, count(DISTINCT u.run_id)::int AS runs, count(*)::int AS turns, count(*) FILTER (WHERE u.cost_label='unavailable')::int AS unpriced,
         COALESCE(SUM(u.cost),0)::float8 AS cost, SUM(u.input_tokens)::float8 AS input_tokens, SUM(u.output_tokens)::float8 AS output_tokens, SUM(u.credits)::float8 AS credits
       FROM usage_records u JOIN runs r ON r.id = u.run_id JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
       WHERE u.workspace_id=$1 AND u.at >= now() - make_interval(days => $2) GROUP BY 1 ORDER BY cost DESC`,
      [workspaceId, days],
    ),
  ]);
  return { days, by_day: byDay.rows, by_workflow: byWorkflow.rows };
}

export async function auditLog(ctx: AppContext, workspaceId: string, q: { limit: number; before?: number }) {
  return (
    await ctx.pool.query(
      `SELECT seq::int AS seq, actor, kind, data, at FROM audit_events WHERE workspace_id=$1 AND ($2::bigint IS NULL OR seq < $2) ORDER BY seq DESC LIMIT $3`,
      [workspaceId, q.before ?? null, q.limit],
    )
  ).rows;
}

/** The OpenCode SDK major for every OpenCode step in the workspace, and the versions online workers have. */
export async function harnessSettings(ctx: AppContext, workspaceId: string) {
  const online = (
    await ctx.pool.query(`SELECT name, capabilities FROM workers WHERE workspace_id=$1 AND task_queue LIKE 'azhi-exec-%' AND last_heartbeat > now() - interval '30 seconds' ORDER BY name`, [workspaceId])
  ).rows as Array<{ name: string; capabilities: { opencodeMajors?: Record<string, { version: string }>; runtimes?: { opencode?: { version: string; major?: number } } } }>;
  const versions = (c: (typeof online)[number]['capabilities']) => ({
    1: c.opencodeMajors?.['1']?.version ?? (c.runtimes?.opencode && (c.runtimes.opencode.major ?? 1) === 1 ? c.runtimes.opencode.version : null),
    2: c.opencodeMajors?.['2']?.version ?? (c.runtimes?.opencode?.major === 2 ? c.runtimes.opencode.version : null),
  });
  return { opencode_major: await opencodeMajorSetting(ctx, workspaceId), workers: online.map((w) => ({ name: w.name, opencode: versions(w.capabilities) })) };
}

/** Turning a schedule on or off; the cron and inputs stay as published. The caller checks the role. */
export async function setScheduleEnabled(ctx: AppContext, workspaceId: string, id: string, enabled: boolean, actor: string) {
  const r = await ctx.pool.query(`UPDATE schedules SET enabled=$3 WHERE id=$1 AND workspace_id=$2 RETURNING id, enabled`, [id, workspaceId, enabled]);
  if (!r.rowCount) throw new AzhiError(ErrorClass.invalidInput, `schedule ${id} not found`);
  await audit(ctx, workspaceId, actor, 'schedule.changed', { id, enabled });
  return r.rows[0] as { id: string; enabled: boolean };
}
