/**
 * Spike 2: recovery test.
 *
 * Kill a worker with SIGKILL at each point of a ledgered write (after `planned`, after `dispatched`,
 * after the target received the write but before the receipt was recorded). A fresh worker must
 * resume the run and the target must hold exactly one message. The ledger history shows the path.
 *
 * Needs Temporal on AZHI_TEMPORAL_ADDRESS and PostgreSQL on AZHI_DATABASE_URL.
 * Run: npx tsx spikes/02-recovery.ts
 */
import { Client, Connection } from '@temporalio/client';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DATABASE_URL, TEMPORAL_ADDRESS } from './env.js';

const messages: Array<{ id: string; key: string; text: string }> = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (req.method === 'POST' && url.pathname === '/post') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { key, text } = JSON.parse(body);
      const msg = { id: `m${messages.length + 1}`, key, text };
      messages.push(msg);
      res.end(JSON.stringify({ id: msg.id }));
    });
    return;
  }
  if (url.pathname === '/find') {
    const m = messages.find((x) => x.key === url.searchParams.get('key'));
    res.end(JSON.stringify(m ? { id: m.id } : {}));
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((r) => server.listen(0, r));
const targetUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const pool = new pg.Pool({ connectionString: DATABASE_URL });
await pool.query(`CREATE TABLE IF NOT EXISTS spike_ledger(action_id text primary key, state text not null, fence int not null, receipt text)`);
await pool.query(`CREATE TABLE IF NOT EXISTS spike_ledger_history(seq serial primary key, action_id text, state text, fence int, at timestamptz default now())`);

const client = new Client({ connection: await Connection.connect({ address: TEMPORAL_ADDRESS }) });
const workerPath = fileURLToPath(new URL('./recovery/worker.ts', import.meta.url));

function startWorker(queue: string, crashAt?: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', workerPath], {
    env: { ...process.env, SPIKE_QUEUE: queue, SPIKE_TARGET_URL: targetUrl, SPIKE_CRASH_AT: crashAt ?? '' },
    stdio: 'inherit',
  });
}

let failed = false;
for (const crashAt of ['planned', 'dispatched', 'sent']) {
  const queue = `spike-recovery-${crashAt}-${Date.now()}`;
  const actionId = `act-${crashAt}-${Date.now()}`;
  const w1 = startWorker(queue, crashAt);
  const handle = await client.workflow.start('postOnce', { taskQueue: queue, workflowId: `wf-${actionId}`, args: [actionId, `hello ${crashAt}`] });
  await new Promise((r) => w1.once('exit', r));
  const w2 = startWorker(queue);
  const receipt = await handle.result();
  w2.kill('SIGTERM');
  const count = messages.filter((m) => m.key === actionId).length;
  const history = (await pool.query(`SELECT state, fence FROM spike_ledger_history WHERE action_id=$1 ORDER BY seq`, [actionId])).rows
    .map((r) => `${r.state}@${r.fence}`)
    .join(' -> ');
  const ok = count === 1;
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'}  crash at ${crashAt}: ${count} message(s), receipt ${receipt}, ledger ${history}`);
}
server.close();
await pool.end();
process.exit(failed ? 1 : 0);
