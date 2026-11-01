import type pg from 'pg';
import type { ExecutionPlan } from '../compiler/plan.js';
import type { AgentNode } from '../definition/types.js';
import { resolveValue } from '../runtime/values.js';
import type { AppContext } from './context.js';

/**
 * Per-repository run limit. Runs of any workflow, including several runs of the same one, go in
 * parallel; each harness step already works in its own fresh checkout, so parallel runs on one
 * repository never share a working tree. What the limit adds is a cap on how many top-level runs
 * may work on the same repository at once (default 2, a workspace setting; 0 means no limit).
 * A run over the limit stays queued and starts, in order, when a slot frees.
 *
 * A run's repositories are its agent steps' workspace repositories that can be worked out from the
 * run's inputs alone (`repo: inputs.repo`, a literal, or CEL over inputs). A repository named from
 * another step's output is only known mid-run and is not counted. Subworkflow runs share their
 * parent's slot.
 */

export const DEFAULT_MAX_RUNS_PER_REPO = 2;

export interface ConcurrencySettings {
  max_runs_per_repo: number;
}

/** The repositories a run will check out, as `host/owner/name` in lower case, from its inputs. */
export function runRepos(plan: Pick<ExecutionPlan, 'nodes' | 'config'>, inputs: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const n of plan.nodes) {
    const ws = n.type === 'agent' ? (n.def as AgentNode).workspace : undefined;
    if (!ws) continue;
    let repo: unknown;
    try {
      repo = resolveValue(ws.repo, { inputs, nodes: {}, config: plan.config });
    } catch {
      continue; // depends on something only known mid-run
    }
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) continue;
    const host = (ws.host ?? 'https://github.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    out.add(`${host}/${repo}`.toLowerCase());
  }
  return [...out].sort();
}

export async function concurrencySettings(ctx: AppContext, workspaceId: string): Promise<ConcurrencySettings & { source: 'workspace' | 'server' }> {
  const v = (await ctx.pool.query(`SELECT settings->'concurrency'->'max_runs_per_repo' AS m FROM workspaces WHERE id=$1`, [workspaceId])).rows[0]?.m;
  if (Number.isInteger(v) && v >= 0) return { max_runs_per_repo: v, source: 'workspace' };
  return { max_runs_per_repo: ctx.settings.maxRunsPerRepo, source: 'server' };
}

/** The OpenCode major every OpenCode step of the workspace runs on (1 or 2), or null to leave it to the worker's own default. */
export async function opencodeMajorSetting(ctx: AppContext, workspaceId: string): Promise<1 | 2 | null> {
  const v = (await ctx.pool.query(`SELECT settings->'harness'->'opencode_major' AS m FROM workspaces WHERE id=$1`, [workspaceId])).rows[0]?.m;
  return v === 1 || v === 2 ? v : null;
}

export type Admission = { ok: true } | { ok: false; repo: string; limit: number; holders: string[] };

/**
 * Decides whether a queued run may start now, and if so marks it as holding its repositories'
 * slots. Call inside a transaction: the advisory lock makes two dispatchers count one at a time.
 */
export async function admitRun(ctx: AppContext, c: pg.PoolClient, workspaceId: string, runId: string): Promise<Admission> {
  const run = (await c.query(`SELECT repos, parent_run_id FROM runs WHERE id=$1`, [runId])).rows[0] as { repos: string[]; parent_run_id: string | null } | undefined;
  if (!run || run.parent_run_id || !run.repos.length) return admitted(c, runId);
  const { max_runs_per_repo: limit } = await concurrencySettings(ctx, workspaceId);
  if (limit === 0) return admitted(c, runId);
  await c.query(`SELECT pg_advisory_xact_lock(727275)`);
  const busy = (
    await c.query(
      `SELECT repo, array_agg(r.id ORDER BY r.admitted_at) AS holders FROM runs r, unnest(r.repos) AS repo
       WHERE r.workspace_id=$1 AND r.id<>$2 AND r.admitted_at IS NOT NULL AND r.parent_run_id IS NULL
         AND r.state IN ('queued','running','waiting','cancelling') AND repo = ANY($3::text[])
       GROUP BY repo HAVING count(*) >= $4 ORDER BY repo LIMIT 1`,
      [workspaceId, runId, run.repos, limit],
    )
  ).rows[0] as { repo: string; holders: string[] } | undefined;
  if (busy) return { ok: false, repo: busy.repo, limit, holders: busy.holders };
  return admitted(c, runId);
}

async function admitted(c: pg.PoolClient, runId: string): Promise<Admission> {
  await c.query(`UPDATE runs SET admitted_at=COALESCE(admitted_at, now()) WHERE id=$1`, [runId]);
  return { ok: true };
}
