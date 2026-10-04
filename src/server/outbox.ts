import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import type pg from 'pg';
import { TASK_QUEUES } from '../config/settings.js';
import { transaction } from '../db/pool.js';
import type { ExecutionPlan } from '../compiler/plan.js';
import type { RunInput, RunSnapshot } from '../runtime/types.js';
import type { AppContext } from './context.js';

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
      const rows = (await c.query(`SELECT id, workspace_id, kind, payload FROM outbox WHERE processed_at IS NULL ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
      for (const row of rows) {
        try {
          await deliver(ctx, client, row.workspace_id, row.kind, row.payload);
          await c.query(`UPDATE outbox SET processed_at=now(), attempts=attempts+1 WHERE id=$1`, [row.id]);
        } catch (err) {
          log(`outbox ${row.id} (${row.kind}) failed: ${(err as Error).message}`);
          await c.query(`UPDATE outbox SET attempts=attempts+1, last_error=$2 WHERE id=$1`, [row.id, (err as Error).message]);
        }
      }
      return rows.length;
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

async function deliver(ctx: AppContext, client: Client, workspaceId: string, kind: string, payload: { run_id: string }) {
  if (kind === 'run.start') {
    const run = (
      await ctx.pool.query(`SELECT r.id, r.inputs, r.snapshot, r.test, v.plan FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id=$1 AND r.workspace_id=$2`, [
        payload.run_id,
        workspaceId,
      ])
    ).rows[0] as { id: string; inputs: Record<string, unknown>; snapshot: RunSnapshot; test: boolean; plan: ExecutionPlan };
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
    return;
  }
  if (kind === 'run.cancel') {
    try {
      await client.workflow.getHandle(payload.run_id).cancel();
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) throw err;
      // Never started: cancel the queued run directly.
      await ctx.pool.query(`UPDATE runs SET state='cancelled', ended_at=now() WHERE id=$1 AND state='queued'`, [payload.run_id]);
    }
    return;
  }
  throw new Error(`unknown outbox kind ${kind}`);
}
