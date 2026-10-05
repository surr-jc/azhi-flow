import type { ExecutionPlan } from '../compiler/plan.js';
import type { ApprovalNode } from '../definition/types.js';
import { postMessage } from '../gateway/tools/slack.js';
import { buildRunPlan } from '../plan/run-plan.js';
import { budgetStatus, describeBudget } from './budgets.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';
import { resolveSecret } from './secrets.js';
import { resolveVersion } from './workflows.js';

/**
 * Alerts (docs/mission-control-plan.md): derived from state the server already keeps, each with
 * a stable key. The notifier records every alert in alert_state, marks cleared ones resolved and
 * posts each new alert once to the workspace's Slack channel when one is configured.
 */
export interface Alert {
  key: string;
  level: 'critical' | 'warning' | 'info';
  kind: string;
  message: string;
  run_id?: string;
  workflow?: string;
  at?: string;
}

export interface AlertSettings {
  slack_channel?: string;
  /** The lowest level sent to Slack. Default: warning. */
  min_level?: 'critical' | 'warning';
  enabled?: boolean;
}

const OPEN_STATES = ['queued', 'running', 'waiting', 'cancelling'];
const LEVEL_RANK = { critical: 0, warning: 1, info: 2 } as const;

/** Approvals waiting for a decision: requested, not decided, run still open. */
export async function pendingApprovals(ctx: AppContext, workspaceId: string) {
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

export async function computeAlerts(ctx: AppContext, workspaceId: string, principal?: { userId: string; role: string }): Promise<Alert[]> {
  const ws = workspaceId;
  const alerts: Alert[] = [];
  const [failed, unknown, workers, waitingOffline, approvals, schedules, refused, budgets] = await Promise.all([
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
    ctx.pool.query(`SELECT seq, data, at FROM audit_events WHERE workspace_id=$1 AND kind='schedule.occurrence_refused' AND at >= now() - interval '24 hours' ORDER BY seq DESC LIMIT 20`, [ws]),
    budgetStatus(ctx, ws),
  ]);
  for (const r of failed.rows) {
    alerts.push({ key: `run:${r.id}`, level: 'critical', kind: `run.${r.state}`, message: `${r.slug} ${r.state.replace('_', ' ')}${r.error?.message ? `: ${r.error.message}` : ''}`, run_id: r.id, workflow: r.slug, at: r.ended_at });
  }
  for (const a of unknown.rows) {
    alerts.push({ key: `action:${a.id}`, level: 'critical', kind: 'action.outcome_unknown', message: `${a.tool} in ${a.slug}: the outcome of this write is unknown and needs a person to check it`, run_id: a.run_id, workflow: a.slug, at: a.updated_at });
  }
  const w = workers.rows[0];
  if (w.online === 0) alerts.push({ key: 'workers:none_online', level: w.total ? 'critical' : 'warning', kind: 'workers.none_online', message: w.total ? `No worker is online (${w.total} registered)` : 'No worker has registered yet' });
  if (waitingOffline.rows[0].n) alerts.push({ key: 'runs:worker_offline', level: 'critical', kind: 'runs.worker_offline', message: `${waitingOffline.rows[0].n} run(s) are waiting for an offline worker` });
  const soon = Date.now() + 60 * 60 * 1000;
  for (const a of approvals) {
    if (a.expires_at && new Date(a.expires_at).getTime() < soon) {
      alerts.push({ key: `approval:${a.run_id}:${a.node_id}`, level: 'warning', kind: 'approval.expiring', message: `Approval ${a.node_id} on ${a.workflow} expires within the hour`, run_id: a.run_id, workflow: a.workflow, at: a.expires_at });
    }
  }
  for (const b of budgets) {
    if (b.exceeded) {
      alerts.push({ key: `budget:${b.id}:${b.resets_at}`, level: 'critical', kind: 'budget.exceeded', message: `${describeBudget(b)} is used up (${b.currency} ${b.spent.toFixed(2)} of ${b.limit.toFixed(2)}); new runs are refused until ${b.resets_at}`, ...(b.workflow ? { workflow: b.workflow } : {}) });
    } else if (b.used_pct >= 80) {
      alerts.push({ key: `budget80:${b.id}:${b.resets_at}`, level: 'warning', kind: 'budget.near', message: `${describeBudget(b)} is ${b.used_pct}% used (${b.currency} ${b.spent.toFixed(2)} of ${b.limit.toFixed(2)})`, ...(b.workflow ? { workflow: b.workflow } : {}) });
    }
  }
  for (const r of refused.rows) {
    alerts.push({ key: `refused:${r.data.schedule}:${r.data.occurrence}`, level: 'critical', kind: 'schedule.occurrence_refused', message: `Scheduled run of ${r.data.workflow} was refused: ${r.data.reason}`, workflow: r.data.workflow, at: r.at });
  }
  // A scheduled workflow whose current plan has blockers is likely to fail at its next occurrence.
  for (const s of schedules.rows) {
    const v = await resolveVersion(ctx, ws, `${s.slug}@latest`);
    if (!v) {
      alerts.push({ key: `schedule:${s.id}:no_version`, level: 'warning', kind: 'schedule.no_version', message: `${s.slug} is scheduled but has no published version`, workflow: s.slug });
      continue;
    }
    const plan = await buildRunPlan(ctx, ws, v, principal);
    const blockers = plan.blockers.filter((b) => b.code !== 'budget_exceeded');
    if (blockers.length) {
      alerts.push({ key: `schedule:${s.id}:blocked`, level: 'warning', kind: 'schedule.plan_blocked', message: `${s.slug}: the run plan has blockers, so the next scheduled run is likely to fail (${blockers.map((b) => b.message).join('; ')})`, workflow: s.slug });
    }
  }
  return alerts.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

export async function alertSettings(ctx: AppContext, workspaceId: string): Promise<AlertSettings> {
  return ((await ctx.pool.query(`SELECT settings->'alerts' AS a FROM workspaces WHERE id=$1`, [workspaceId])).rows[0]?.a ?? {}) as AlertSettings;
}

/** Posts one message to the alerts channel with the workspace's Slack bot token. */
export async function sendSlackAlert(ctx: AppContext, workspaceId: string, channel: string, text: string, dedupeKey: string) {
  const token = await resolveSecret(ctx, workspaceId, 'slack-bot-token');
  if (!token) throw new Error("the secret 'slack-bot-token' is not set");
  return postMessage({ token: token.value, apiUrl: ctx.settings.slackApiUrl }, { channel, text, dedupeKey });
}

const ICON = { critical: ':red_circle:', warning: ':large_yellow_circle:', info: ':white_circle:' };

export function alertText(a: Alert, baseUrl?: string) {
  const link = a.run_id && baseUrl ? ` <${baseUrl.replace(/\/$/, '')}/ui/runs/${a.run_id}|${a.run_id}>` : a.run_id ? ` (${a.run_id})` : '';
  return `${ICON[a.level]} *Azhi Flow ${a.level}*: ${a.message}${link}`;
}

/**
 * One notifier pass for every workspace: record alerts, resolve cleared ones and send new ones
 * to Slack. A Slack failure is recorded on the alert and retried on the next pass.
 */
export async function notifyAlerts(ctx: AppContext, log: (m: string) => void = () => {}) {
  const workspaces = (await ctx.pool.query(`SELECT id, settings->'alerts' AS alerts FROM workspaces`)).rows as Array<{ id: string; alerts: AlertSettings | null }>;
  for (const wsRow of workspaces) {
    const alerts = await computeAlerts(ctx, wsRow.id);
    for (const a of alerts) {
      await ctx.pool.query(
        `INSERT INTO alert_state(workspace_id, key, level, kind, message, run_id, workflow) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (workspace_id, key) DO UPDATE SET level=$3, message=$5, last_seen=now(),
           first_seen=CASE WHEN alert_state.resolved_at IS NULL THEN alert_state.first_seen ELSE now() END,
           notified_at=CASE WHEN alert_state.resolved_at IS NULL THEN alert_state.notified_at ELSE NULL END,
           resolved_at=NULL`,
        [wsRow.id, a.key, a.level, a.kind, a.message, a.run_id ?? null, a.workflow ?? null],
      );
    }
    await ctx.pool.query(`UPDATE alert_state SET resolved_at=now() WHERE workspace_id=$1 AND resolved_at IS NULL AND NOT (key = ANY($2))`, [wsRow.id, alerts.map((a) => a.key)]);

    const s = wsRow.alerts ?? {};
    if (!s.slack_channel || s.enabled === false) continue;
    const maxRank = LEVEL_RANK[s.min_level ?? 'warning'];
    const due = (
      await ctx.pool.query(`SELECT key, level, kind, message, run_id, workflow, first_seen FROM alert_state WHERE workspace_id=$1 AND resolved_at IS NULL AND notified_at IS NULL ORDER BY first_seen LIMIT 20`, [wsRow.id])
    ).rows.filter((r) => LEVEL_RANK[r.level as Alert['level']] <= maxRank);
    for (const r of due) {
      try {
        await sendSlackAlert(ctx, wsRow.id, s.slack_channel, alertText(r, ctx.settings.publicUrl), `alert:${r.key}:${new Date(r.first_seen).toISOString()}`);
        await ctx.pool.query(`UPDATE alert_state SET notified_at=now(), notify_error=NULL WHERE workspace_id=$1 AND key=$2`, [wsRow.id, r.key]);
        await audit(ctx, wsRow.id, null, 'alert.sent', { key: r.key, channel: s.slack_channel });
      } catch (err) {
        await ctx.pool.query(`UPDATE alert_state SET notify_error=$3 WHERE workspace_id=$1 AND key=$2`, [wsRow.id, r.key, (err as Error).message]);
        log(`alerts: could not post ${r.key} to Slack: ${(err as Error).message}`);
      }
    }
  }
}

export function startAlertNotifier(ctx: AppContext, log: (m: string) => void = () => {}, intervalMs = 60_000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await notifyAlerts(ctx, log);
    } catch (err) {
      log(`alerts: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return { tick, stop: () => clearInterval(timer) };
}
