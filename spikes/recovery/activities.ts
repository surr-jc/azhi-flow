import { Context } from '@temporalio/activity';
import pg from 'pg';
import { DATABASE_URL } from '../env.js';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const target = () => process.env.SPIKE_TARGET_URL!;
const crashAt = () => process.env.SPIKE_CRASH_AT ?? '';

function maybeCrash(point: string) {
  if (crashAt() === point) {
    console.log(`[worker ${process.pid}] crashing at ${point}`);
    process.kill(process.pid, 'SIGKILL');
  }
}

async function transition(actionId: string, state: string, fence: number, receipt?: string) {
  // Fencing: a stale attempt (lower generation) can never overwrite a newer one.
  const r = await pool.query(
    `UPDATE spike_ledger SET state=$2, fence=$3, receipt=COALESCE($4, receipt) WHERE action_id=$1 AND fence <= $3`,
    [actionId, state, fence, receipt ?? null],
  );
  if (r.rowCount !== 1) throw new Error(`fenced out: ${actionId} attempt ${fence}`);
  await pool.query(`INSERT INTO spike_ledger_history(action_id, state, fence) VALUES ($1,$2,$3)`, [actionId, state, fence]);
}

export async function ledgeredPost(actionId: string, text: string): Promise<string> {
  const fence = Context.current().info.attempt;
  setInterval(() => Context.current().heartbeat(), 500).unref();

  const existing = await pool.query(`SELECT state, receipt FROM spike_ledger WHERE action_id=$1`, [actionId]);
  const row = existing.rows[0] as { state: string; receipt: string | null } | undefined;
  if (row?.state === 'confirmed') return row.receipt!;

  if (!row) {
    await pool.query(`INSERT INTO spike_ledger(action_id, state, fence) VALUES ($1,'planned',$2)`, [actionId, fence]);
    await pool.query(`INSERT INTO spike_ledger_history(action_id, state, fence) VALUES ($1,'planned',$2)`, [actionId, fence]);
  } else if (row.state === 'dispatched') {
    // We sent (or may have sent) but never saw a receipt: the outcome is unknown.
    await transition(actionId, 'outcome_unknown', fence);
  }

  const current = (await pool.query(`SELECT state FROM spike_ledger WHERE action_id=$1`, [actionId])).rows[0].state;
  if (current === 'outcome_unknown') {
    // write-dedupable: query the target for the dedupe key before any retry.
    const found = await fetch(`${target()}/find?key=${encodeURIComponent(actionId)}`).then((r) => r.json() as Promise<{ id?: string }>);
    if (found.id) {
      await transition(actionId, 'confirmed', fence, found.id);
      return found.id;
    }
  }

  maybeCrash('planned');
  await transition(actionId, 'dispatched', fence);
  maybeCrash('dispatched');
  const res = await fetch(`${target()}/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: actionId, text }),
  }).then((r) => r.json() as Promise<{ id: string }>);
  maybeCrash('sent');
  await transition(actionId, 'confirmed', fence, res.id);
  return res.id;
}
