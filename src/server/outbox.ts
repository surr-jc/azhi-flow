import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import type pg from 'pg';
import { TASK_QUEUES } from '../config/settings.js';
import { transaction } from '../db/pool.js';
import type { ExecutionPlan } from '../compiler/plan.js';
import type { RunInput, RunSnapshot } from '../runtime/types.js';
import type { AppContext } from './context.js';
import { admitRun } from './repo-slots.js';

/**
 * Delivers outbox entries to Temporal. Entries are committed with the rows that caused them,
 * so a crash between commit and delivery only delays a run; delivery is idempotent because the
 * workflow ID is the run ID.
 */
export function startOutboxDispatcher(ctx: AppContext, client: Client, log: (m: string) => void = () => {}) {
  let stopped = false;
  let wake: () => void = () => {};
  let listener: pg.PoolClient | undefined;

  const processBatch = (): Promise<number> =>
    transaction(ctx.pool, async (c) => {
      // Entries held back for a repository slot go first, oldest first, so a freed slot goes to the
      // run that has waited longest; they do not count as progress while they stay held.
      const pending = `SELECT id, workspace_id, kind, payload, held_at FROM outbox WHERE processed_at IS NULL`;
      const held = (await c.query(`${pending} AND held_at IS NOT NULL ORDER BY id FOR UPDATE SKIP LOCKED`)).rows;
      const fresh = (await c.query(`${pending} AND held_at IS NULL ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
      let progressed = 0;
      for (const row of [...held, ...fresh]) {
        try {
          const outcome = await deliver(ctx, client, c, row.workspace_id, row.kind, row.payload);
          if (outcome !== 'held') {
            await c.query(`UPDATE outbox SET processed_at=now(), attempts=attempts+1 WHERE id=$1`, [row.id]);
            progressed++;
          } else if (!row.held_at) {
            await c.query(`UPDATE outbox SET held_at=now() WHERE id=$1`, [row.id]);
            progressed++;
          }
        } catch (err) {
          log(`outbox ${row.id} (${row.kind}) failed: ${(err as Error).message}`);
          await c.query(`UPDATE outbox SET attempts=attempts+1, last_error=$2 WHERE id=$1`, [row.id, (err as Error).message]);
          progressed++;
        }
      }
      return progressed;
    });

  const loop = async () => {
    const l = await ctx.pool.connect();
    listener = l;
    await l.query('LISTEN azhi_outbox');
    l.on('notification', () => wake());
    while (!stopped) {
      try {
        const n = await processBatch();
        if (n > 0) continue;
      } catch (err) {
        log(`outbox: ${(err as Error).message}`);
      }
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 1000);
      });
    }
  };
  const done = loop();
  return {
    async stop() {
      stopped = true;
      wake();
      await done.catch(() => {});
      listener?.release();
    },
  };
}

async function deliver(ctx: AppContext, client: Client, c: pg.PoolClient, workspaceId: string, kind: string, payload: { run_id: string; by?: string }): Promise<'done' | 'held'> {
  if (kind === 'run.start') {
    const run = (
      await c.query(`SELECT r.id, r.state, r.inputs, r.snapshot, r.test, v.plan FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id=$1 AND r.workspace_id=$2`, [
        payload.run_id,
        workspaceId,
      ])
    ).rows[0] as { id: string; state: string; inputs: Record<string, unknown>; snapshot: RunSnapshot; test: boolean; plan: ExecutionPlan };
    // Cancelled while it waited for a repository slot: nothing to start.
    if (run.state === 'cancelled') return 'done';
    const admission = await admitRun(ctx, c, workspaceId, run.id);
    if (!admission.ok) {
      const said = (await c.query(`SELECT 1 FROM run_events WHERE run_id=$1 AND kind='run.held' LIMIT 1`, [run.id])).rowCount;
      if (!said) {
        await c.query(`INSERT INTO run_events(workspace_id, run_id, kind, data) VALUES ($1,$2,'run.held',$3)`, [
          workspaceId,
          run.id,
          JSON.stringify({ state: 'queued', reason: 'repo_limit', repo: admission.repo, limit: admission.limit, running: admission.holders }),
        ]);
      }
      return 'held';
    }
    const input: RunInput = { runId: run.id, workspaceId, plan: run.plan, inputs: run.inputs, snapshot: run.snapshot, mockWrites: run.test };
    try {
      await client.workflow.start('azhiRun', {
        workflowId: run.id,
        taskQueue: TASK_QUEUES.interpreter(run.snapshot.interpreter_build),
        args: [input],
        workflowExecutionTimeout: '30 days',
      });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    }
    return 'done';
  }
  if (kind === 'run.cancel') {
    // Cancel is a forced stop: the run and every child run end now, even if a step is hung and
    // would never acknowledge a graceful cancel.
    const tree = (
      await c.query(
        `WITH RECURSIVE tree AS (SELECT id FROM runs WHERE id=$1 UNION SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id) SELECT id FROM tree`,
        [payload.run_id],
      )
    ).rows.map((r) => r.id as string);
    for (const id of tree) {
      const handle = client.workflow.getHandle(id);
      // Ask politely first so running activities abort their sessions, then terminate regardless.
      await handle.cancel().catch(() => {});
      try {
        await handle.terminate(`cancelled by ${payload.by ?? 'user'}`);
      } catch (err) {
        // Never started, or already closed: the database below is the source of truth.
        if (!(err instanceof WorkflowNotFoundError) && !/already completed|not found/i.test((err as Error).message)) throw err;
      }
    }
    // A terminated workflow cannot record its own end, so settle the rows here.
    await c.query(`UPDATE node_attempts SET state='cancelled', ended_at=now() WHERE run_id = ANY($1) AND ended_at IS NULL`, [tree]);
    await c.query(
      `UPDATE runs SET state='cancelled', ended_at=COALESCE(ended_at, now()) WHERE id = ANY($1) AND state IN ('queued','running','waiting','cancelling')`,
      [tree],
    );
    for (const id of tree) {
      await c.query(`INSERT INTO run_events(workspace_id, run_id, kind, data) VALUES ($1,$2,'run.cancelled',$3)`, [
        workspaceId,
        id,
        JSON.stringify({ state: 'cancelled', forced: true, by: payload.by ?? null }),
      ]);
    }
    await c.query(`NOTIFY azhi_outbox`);
    return 'done';
  }
  throw new Error(`unknown outbox kind ${kind}`);
}
