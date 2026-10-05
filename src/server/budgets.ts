import type { AppContext } from './context.js';

/**
 * Spend limits (docs/mission-control-plan.md, operations). Spend is measured model cost from
 * usage_records in the current UTC day or month. Turns without pricing count as unknown, so the
 * spend is a lower bound; the limit applies to what is known.
 */
export interface BudgetStatus {
  id: string;
  workflow: string | null;
  period: 'day' | 'month';
  limit: number;
  currency: string;
  spent: number;
  unpriced_turns: number;
  used_pct: number;
  exceeded: boolean;
  resets_at: string;
}

export async function budgetStatus(ctx: AppContext, workspaceId: string, workflowId?: string): Promise<BudgetStatus[]> {
  const rows = (
    await ctx.pool.query(
      `SELECT b.id, w.slug AS workflow, b.period, b.limit_amount::float8 AS limit, b.currency,
         date_trunc(b.period, now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS since,
         (date_trunc(b.period, now() AT TIME ZONE 'UTC') + ('1 ' || b.period)::interval) AT TIME ZONE 'UTC' AS resets_at
       FROM budgets b LEFT JOIN workflows w ON w.id = b.workflow_id
       WHERE b.workspace_id=$1 AND ($2::text IS NULL OR b.workflow_id IS NULL OR b.workflow_id = $2)
       ORDER BY w.slug NULLS FIRST, b.period`,
      [workspaceId, workflowId ?? null],
    )
  ).rows;
  const out: BudgetStatus[] = [];
  for (const b of rows) {
    const s = (
      await ctx.pool.query(
        `SELECT COALESCE(SUM(u.cost), 0)::float8 AS spent, count(*) FILTER (WHERE u.cost_label = 'unavailable')::int AS unpriced
         FROM usage_records u JOIN runs r ON r.id = u.run_id JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
         WHERE u.workspace_id=$1 AND u.at >= $2 AND ($3::text IS NULL OR w.slug = $3)`,
        [workspaceId, b.since, b.workflow],
      )
    ).rows[0];
    out.push({
      id: b.id,
      workflow: b.workflow,
      period: b.period,
      limit: b.limit,
      currency: b.currency,
      spent: s.spent,
      unpriced_turns: s.unpriced,
      used_pct: Math.round((s.spent / b.limit) * 100),
      exceeded: s.spent >= b.limit,
      resets_at: new Date(b.resets_at).toISOString(),
    });
  }
  return out;
}

export const describeBudget = (b: BudgetStatus) => `${b.workflow ?? 'workspace'} ${b.period === 'day' ? 'daily' : 'monthly'} limit`;
