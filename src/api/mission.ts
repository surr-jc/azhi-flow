import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { alertSettings, computeAlerts, pendingApprovals, sendSlackAlert } from '../server/alerts.js';
import { auditLog, canDecide, harnessSettings, nextSchedules, setScheduleEnabled, usageSummary, workflowSummaries, workflowVersions, workspaceOverview } from '../server/overview.js';
import { getDataset } from '../knowledge/datasets.js';
import { datasetAllows } from '../plan/run-plan.js';
import { budgetStatus } from '../server/budgets.js';
import { concurrencySettings } from '../server/repo-slots.js';
import { audit } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { requireRole } from './auth.js';

/**
 * Read endpoints for mission control (docs/mission-control-plan.md). They summarise state the
 * server already keeps; every write the web app makes goes through the existing endpoints, so
 * role checks, the run plan and the audit log apply unchanged. Nothing here returns a secret.
 */
function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

export function registerMissionRoutes(app: FastifyInstance, ctx: AppContext) {
  // One dataset: its documents (current and revoked) and published revisions, for those its ACL lets read.
  app.get('/v1/datasets/:name', async (req) => {
    const p = user(req);
    const d = await getDataset(ctx, p.workspaceId, (req.params as { name: string }).name);
    if (!d) throw new AzhiError(ErrorClass.invalidInput, 'dataset not found');
    if (!datasetAllows(d.acl, p)) throw new AzhiError(ErrorClass.authorization, `your role cannot read dataset ${d.name}`);
    const [documents, revisions] = await Promise.all([
      ctx.pool.query(`SELECT x.path, x.media_type, x.revoked, x.added_at, a.size FROM dataset_documents x LEFT JOIN artifacts a ON a.workspace_id=$2 AND a.hash = x.artifact WHERE x.dataset_id=$1 ORDER BY x.path`, [d.id, p.workspaceId]),
      ctx.pool.query(
        `SELECT r.revision, r.documents, r.chunks, r.embedder, r.published_at, COALESCE(array_agg(t.tag ORDER BY t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}') AS tags
         FROM dataset_revisions r LEFT JOIN dataset_tags t ON t.dataset_id = r.dataset_id AND t.revision = r.revision WHERE r.dataset_id=$1 GROUP BY r.dataset_id, r.revision ORDER BY r.revision DESC`,
        [d.id],
      ),
    ]);
    const last = revisions.rows[0]?.published_at as Date | undefined;
    return {
      name: d.name,
      trusted: d.trusted,
      acl: d.acl,
      documents: documents.rows.map((x) => ({ ...x, size: x.size === null ? null : Number(x.size), unpublished: !x.revoked && (!last || x.added_at > last) })),
      revisions: revisions.rows,
    };
  });

  app.get('/v1/overview', async (req) => workspaceOverview(ctx, user(req)));

  app.get('/v1/approvals', async (req) => {
    const p = user(req);
    return (await pendingApprovals(ctx, p.workspaceId)).map((a) => ({ ...a, can_decide: canDecide(p.role, a.role) }));
  });

  app.get('/v1/alerts', async (req) => {
    const p = user(req);
    return computeAlerts(ctx, p.workspaceId, { userId: p.userId, role: p.role });
  });

  app.get('/v1/workflows/summary', async (req) => workflowSummaries(ctx, user(req).workspaceId));

  app.get('/v1/workflows/:slug/versions', async (req) => workflowVersions(ctx, user(req).workspaceId, (req.params as { slug: string }).slug));

  app.get('/v1/schedules/summary', async (req) => nextSchedules(ctx, user(req).workspaceId));

  // Turning a schedule on or off; the cron and inputs stay as published (admin, audited).
  app.patch('/v1/schedules/:id', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const { id } = req.params as { id: string };
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    return setScheduleEnabled(ctx, p.workspaceId, id, enabled, p.userId);
  });

  app.get('/v1/usage/summary', async (req) => {
    const p = user(req);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
    return usageSummary(ctx, p.workspaceId, days);
  });

  app.get('/v1/audit', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() }).parse(req.query);
    return auditLog(ctx, p.workspaceId, q);
  });

  // Alert history: every alert raised, when it cleared, and whether Slack got it.
  app.get('/v1/alerts/history', async (req) => {
    const p = user(req);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return (
      await ctx.pool.query(
        `SELECT key, level, kind, message, run_id, workflow, first_seen, last_seen, resolved_at, notified_at, notify_error FROM alert_state WHERE workspace_id=$1 ORDER BY last_seen DESC LIMIT $2`,
        [p.workspaceId, limit],
      )
    ).rows;
  });

  app.get('/v1/settings/alerts', async (req) => {
    const p = user(req);
    const s = await alertSettings(ctx, p.workspaceId);
    const token = (await ctx.pool.query(`SELECT 1 FROM secrets WHERE workspace_id=$1 AND name='slack-bot-token' LIMIT 1`, [p.workspaceId])).rowCount;
    return { slack_channel: s.slack_channel ?? null, min_level: s.min_level ?? 'warning', enabled: s.enabled !== false, slack_token_set: Boolean(token) };
  });

  app.put('/v1/settings/alerts', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ slack_channel: z.string().trim().max(80).nullable(), min_level: z.enum(['critical', 'warning']).default('warning'), enabled: z.boolean().default(true) }).parse(req.body);
    const value = { ...(b.slack_channel ? { slack_channel: b.slack_channel } : {}), min_level: b.min_level, enabled: b.enabled };
    await ctx.pool.query(`UPDATE workspaces SET settings = jsonb_set(settings, '{alerts}', $2::jsonb) WHERE id=$1`, [p.workspaceId, JSON.stringify(value)]);
    await audit(ctx, p.workspaceId, p.userId, 'settings.alerts_changed', value);
    return value;
  });

  // Sends one test message so an admin can check the channel and the bot's access.
  app.post('/v1/settings/alerts/test', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const s = await alertSettings(ctx, p.workspaceId);
    if (!s.slack_channel) throw new AzhiError(ErrorClass.invalidInput, 'set an alerts channel first');
    try {
      const r = await sendSlackAlert(ctx, p.workspaceId, s.slack_channel, ':white_check_mark: Azhi Flow alerts will be posted in this channel.', newId('alerttest'));
      await audit(ctx, p.workspaceId, p.userId, 'alert.test_sent', { channel: s.slack_channel });
      return { ok: true, ...r };
    } catch (err) {
      throw new AzhiError(ErrorClass.invalidInput, `Slack did not accept the message: ${(err as Error).message}`);
    }
  });

  // Per-repository run limit: reading needs any user; changing it needs admin and is audited.
  app.get('/v1/settings/concurrency', async (req) => {
    const p = user(req);
    const s = await concurrencySettings(ctx, p.workspaceId);
    const repos = (
      await ctx.pool.query(
        `SELECT repo, array_agg(r.id ORDER BY r.admitted_at) FILTER (WHERE r.admitted_at IS NOT NULL) AS running,
           array_agg(r.id ORDER BY r.created_at) FILTER (WHERE r.admitted_at IS NULL) AS held
         FROM runs r, unnest(r.repos) AS repo
         WHERE r.workspace_id=$1 AND r.parent_run_id IS NULL AND r.state IN ('queued','running','waiting','cancelling')
         GROUP BY repo ORDER BY repo`,
        [p.workspaceId],
      )
    ).rows.map((r) => ({ repo: r.repo as string, running: (r.running ?? []) as string[], held: (r.held ?? []) as string[] }));
    return { ...s, server_default: ctx.settings.maxRunsPerRepo, repos };
  });

  app.put('/v1/settings/concurrency', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ max_runs_per_repo: z.number().int().min(0).max(64).nullable() }).parse(req.body);
    await ctx.pool.query(
      b.max_runs_per_repo === null
        ? `UPDATE workspaces SET settings = settings - 'concurrency' WHERE id=$1`
        : `UPDATE workspaces SET settings = jsonb_set(settings, '{concurrency}', $2::jsonb) WHERE id=$1`,
      b.max_runs_per_repo === null ? [p.workspaceId] : [p.workspaceId, JSON.stringify({ max_runs_per_repo: b.max_runs_per_repo })],
    );
    await audit(ctx, p.workspaceId, p.userId, 'settings.concurrency_changed', b);
    // A higher limit may free slots for held runs at once.
    await ctx.pool.query(`NOTIFY azhi_outbox`);
    return concurrencySettings(ctx, p.workspaceId);
  });

  // The OpenCode SDK major for every OpenCode step in the workspace: reading needs any user; changing it needs admin and is audited.
  app.get('/v1/settings/harness', async (req) => harnessSettings(ctx, user(req).workspaceId));

  app.put('/v1/settings/harness', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ opencode_major: z.union([z.literal(1), z.literal(2)]).nullable() }).parse(req.body);
    await ctx.pool.query(
      b.opencode_major === null
        ? `UPDATE workspaces SET settings = settings - 'harness' WHERE id=$1`
        : `UPDATE workspaces SET settings = jsonb_set(settings, '{harness}', $2::jsonb) WHERE id=$1`,
      b.opencode_major === null ? [p.workspaceId] : [p.workspaceId, JSON.stringify({ opencode_major: b.opencode_major })],
    );
    await audit(ctx, p.workspaceId, p.userId, 'settings.harness_changed', b);
    return harnessSettings(ctx, p.workspaceId);
  });

  // Spend limits: reading needs any user; changing them needs admin and is audited.
  app.get('/v1/budgets', async (req) => budgetStatus(ctx, user(req).workspaceId));

  app.put('/v1/budgets', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ workflow: z.string().nullable().default(null), period: z.enum(['day', 'month']), limit: z.number().positive().max(1_000_000) }).parse(req.body);
    let workflowId: string | null = null;
    if (b.workflow) {
      workflowId = (await ctx.pool.query(`SELECT id FROM workflows WHERE workspace_id=$1 AND slug=$2`, [p.workspaceId, b.workflow])).rows[0]?.id ?? null;
      if (!workflowId) throw new AzhiError(ErrorClass.invalidInput, `workflow ${b.workflow} not found`);
    }
    const r = await ctx.pool.query(
      `INSERT INTO budgets(id, workspace_id, workflow_id, period, limit_amount, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_id, workflow_id, period) DO UPDATE SET limit_amount=$5 RETURNING id`,
      [newId('bud'), p.workspaceId, workflowId, b.period, b.limit, p.userId],
    );
    await audit(ctx, p.workspaceId, p.userId, 'budget.changed', { id: r.rows[0].id, workflow: b.workflow, period: b.period, limit: b.limit });
    return (await budgetStatus(ctx, p.workspaceId)).find((x) => x.id === r.rows[0].id);
  });

  app.delete('/v1/budgets/:id', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const { id } = req.params as { id: string };
    const r = await ctx.pool.query(`DELETE FROM budgets WHERE id=$1 AND workspace_id=$2`, [id, p.workspaceId]);
    if (!r.rowCount) throw new AzhiError(ErrorClass.invalidInput, `budget ${id} not found`);
    await audit(ctx, p.workspaceId, p.userId, 'budget.removed', { id });
    return { ok: true };
  });
}

