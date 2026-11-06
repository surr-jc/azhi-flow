import type pg from 'pg';
import type { EffectClass } from '../definition/types.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { canonicalJson, sha256 } from '../lib/hash.js';

/**
 * The action ledger (spec section 8). Every external write is a logical action with its own ID,
 * tracked across attempts as planned -> dispatched -> confirmed | failed | outcome_unknown.
 * Crash recovery reconciles instead of guessing. Each transition is fenced by the attempt
 * generation, so a stale attempt can never commit after a newer one took over.
 */
export type ActionState = 'planned' | 'dispatched' | 'confirmed' | 'failed' | 'outcome_unknown';

export interface ActionRow {
  id: string;
  state: ActionState;
  fence: number;
  idempotency_key: string;
  receipt: unknown;
  created_at: Date;
}

export interface LedgerScope {
  pool: pg.Pool;
  workspaceId: string;
  runId: string;
  nodeId: string;
  /** Fencing generation: the Temporal activity attempt. */
  fence: number;
}

export interface WriteOperation {
  tool: string;
  effect: Exclude<EffectClass, 'read'>;
  /** The intended operation: a change here produces a new action ID. */
  operation: unknown;
  target?: Record<string, unknown>;
  /** Distinguishes several writes with identical operations in one node (for example parallel items). */
  ordinal?: number;
}

export interface WriteHandlers<R> {
  send(idempotencyKey: string): Promise<R>;
  /** For write-dedupable: find the write on the target by its dedupe key. */
  lookup?(idempotencyKey: string, since: Date): Promise<R | null>;
}

/** Errors from `send` carry whether the target definitely did not apply the write. */
export class SendError extends Error {
  constructor(
    message: string,
    readonly definite: boolean,
    readonly errorClass: ErrorClass = ErrorClass.transient,
  ) {
    super(message);
  }
}

export function actionIdFor(runId: string, nodeId: string, op: WriteOperation): string {
  return `act_${sha256(canonicalJson([runId, nodeId, op.tool, op.operation, op.ordinal ?? 0])).slice(0, 32)}`;
}

/**
 * The oldest action for this same write in the runs this one resumes, if it may have reached the target and has no
 * settled state. A resumed run is a new run with its own action IDs, so this is the only link back to that write.
 */
async function unresolvedInResumedRuns(scope: LedgerScope, op: WriteOperation) {
  const runs = await scope.pool.query(
    `WITH RECURSIVE chain(id) AS (
       SELECT snapshot->'resume'->>'from_run' FROM runs WHERE id=$1 AND workspace_id=$2
       UNION ALL
       SELECT r.snapshot->'resume'->>'from_run' FROM runs r JOIN chain c ON r.id = c.id
     ) SELECT id FROM chain WHERE id IS NOT NULL`,
    [scope.runId, scope.workspaceId],
  );
  if (!runs.rows.length) return undefined;
  const ids = runs.rows.map((r) => actionIdFor(r.id as string, scope.nodeId, op));
  const found = await scope.pool.query(
    `SELECT id, run_id, idempotency_key, created_at FROM actions WHERE id = ANY($1) AND state IN ('dispatched','outcome_unknown') ORDER BY created_at LIMIT 1`,
    [ids],
  );
  return found.rows[0] as { id: string; run_id: string; idempotency_key: string; created_at: Date } | undefined;
}

export interface LedgerResult<R> {
  actionId: string;
  receipt: R;
  /** True when this call found the write already confirmed or reconciled it from the target. */
  reused: boolean;
}

export async function ledgeredWrite<R>(scope: LedgerScope, op: WriteOperation, handlers: WriteHandlers<R>): Promise<LedgerResult<R>> {
  const id = actionIdFor(scope.runId, scope.nodeId, op);
  const transition = async (state: ActionState, note?: string, extra: { receipt?: unknown; error?: unknown } = {}) => {
    const r = await scope.pool.query(
      `UPDATE actions SET state=$2, fence=$3, receipt=COALESCE($4, receipt), error=$5, updated_at=now()
       WHERE id=$1 AND fence <= $3`,
      [id, state, scope.fence, extra.receipt === undefined ? null : JSON.stringify(extra.receipt), extra.error === undefined ? null : JSON.stringify(extra.error)],
    );
    if (r.rowCount !== 1) {
      throw new AzhiError(ErrorClass.needsOperator, `action ${id} was taken over by a newer attempt; this attempt (${scope.fence}) is stale`);
    }
    await scope.pool.query(`INSERT INTO action_transitions(action_id, state, fence, note) VALUES ($1,$2,$3,$4)`, [id, state, scope.fence, note ?? null]);
  };

  // The run this one resumes may have applied this write. Its key is what the target knows the write by, so it carries over.
  const earlier = await unresolvedInResumedRuns(scope, op);
  if (earlier && op.effect === 'write-unsafe') {
    throw new AzhiError(ErrorClass.needsOperator, `write-unsafe action ${earlier.id} in run ${earlier.run_id}, which this run resumes, has an unknown outcome; an operator must reconcile it before this write can go ahead`, { action_id: earlier.id, run_id: earlier.run_id });
  }

  const inserted = await scope.pool.query(
    `INSERT INTO actions(id, workspace_id, run_id, node_id, tool, effect, operation_hash, idempotency_key, target, state, fence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned',$10) ON CONFLICT (id) DO NOTHING`,
    [id, scope.workspaceId, scope.runId, scope.nodeId, op.tool, op.effect, sha256(canonicalJson(op.operation)), earlier?.idempotency_key ?? id, JSON.stringify(op.target ?? {}), scope.fence],
  );
  if (inserted.rowCount === 1) {
    await scope.pool.query(`INSERT INTO action_transitions(action_id, state, fence) VALUES ($1,'planned',$2)`, [id, scope.fence]);
  }
  crashPoint('ledger.planned');
  const row = (await scope.pool.query(`SELECT id, state, fence, idempotency_key, receipt, created_at FROM actions WHERE id=$1`, [id])).rows[0] as ActionRow;
  if (row.fence > scope.fence) throw new AzhiError(ErrorClass.needsOperator, `action ${id} belongs to a newer attempt (${row.fence})`);

  if (row.state === 'confirmed') return { actionId: id, receipt: row.receipt as R, reused: true };

  let state = row.state;
  if (state === 'dispatched') {
    // A previous attempt sent (or was about to send) and never recorded a receipt.
    await transition('outcome_unknown', `attempt ${row.fence} ended without a receipt`);
    state = 'outcome_unknown';
  }

  if (state === 'outcome_unknown' || state === 'failed' || earlier) {
    if (op.effect === 'write-unsafe') {
      throw new AzhiError(ErrorClass.needsOperator, `write-unsafe action ${id} is ${state}; an operator must reconcile it before any retry`, { action_id: id });
    }
    if ((state === 'outcome_unknown' || earlier) && op.effect === 'write-dedupable') {
      if (!handlers.lookup) throw new AzhiError(ErrorClass.needsOperator, `tool ${op.tool} is write-dedupable but has no lookup`);
      // The write can only be as old as the first send, which may be long before this row.
      const found = await handlers.lookup(row.idempotency_key, new Date((earlier?.created_at ?? row.created_at).getTime() - 60_000));
      if (found) {
        await transition('confirmed', earlier ? `reconciled: found on target by the dedupe key of ${earlier.id} in run ${earlier.run_id}` : 'reconciled: found on target by dedupe key', { receipt: found });
        return { actionId: id, receipt: found, reused: true };
      }
    }
    // write-idempotent resends with the same key; write-dedupable resends after a miss.
  }

  await transition('dispatched');
  crashPoint('ledger.dispatched');
  let receipt: R;
  try {
    receipt = await handlers.send(row.idempotency_key);
    crashPoint('ledger.sent');
  } catch (err) {
    const definite = err instanceof SendError && err.definite;
    const cls = err instanceof SendError ? err.errorClass : err instanceof AzhiError ? err.errorClass : ErrorClass.transient;
    await transition(definite ? 'failed' : 'outcome_unknown', (err as Error).message, { error: { message: (err as Error).message, class: cls } });
    throw new AzhiError(cls, (err as Error).message, { action_id: id, definite });
  }
  await transition('confirmed', undefined, { receipt });
  return { actionId: id, receipt, reused: false };
}

/**
 * Crash-suite fault injection: with AZHI_FAULT=<point> the process kills itself at that point,
 * exactly as a power loss would. Never set in production.
 */
function crashPoint(point: string) {
  if (process.env.AZHI_FAULT === point) process.kill(process.pid, 'SIGKILL');
}
