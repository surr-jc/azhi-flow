/**
 * Spike 3: interpreter versioning.
 *
 * Each interpreter build polls its own task queue (`<prefix>-<build>`). A run records the build
 * that started it and stays there; new runs go to the newest build; old builds keep running until
 * their runs drain. Also checks that an agent loop runs one Activity per turn and uses
 * continue-as-new to keep history small.
 *
 * Run: npx tsx spikes/03-versioning.ts
 */
import { Client, Connection } from '@temporalio/client';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEMPORAL_ADDRESS } from './env.js';

const prefix = `spike-interp-${Date.now()}`;
const workerPath = fileURLToPath(new URL('./versioning/worker.ts', import.meta.url));
const start = (build: string) =>
  spawn(process.execPath, ['--import', 'tsx', workerPath], {
    env: { ...process.env, SPIKE_BUILD: build, SPIKE_QUEUE_PREFIX: prefix },
    stdio: 'ignore',
  });

const client = new Client({ connection: await Connection.connect({ address: TEMPORAL_ADDRESS }) });
const results: string[] = [];
let ok = true;

const w1 = start('v1');
const runA = await client.workflow.start('interpret', { taskQueue: `${prefix}-v1`, workflowId: `${prefix}-A` });
await new Promise((r) => setTimeout(r, 3000));

// Deploy build v2 while run A is in flight. New runs are routed to v2.
const w2 = start('v2');
const runB = await client.workflow.start('interpret', { taskQueue: `${prefix}-v2`, workflowId: `${prefix}-B` });
await new Promise((r) => setTimeout(r, 3000));
await runA.signal('proceed');
await runB.signal('proceed');
const [a, b] = [await runA.result(), await runB.result()];
ok &&= a === 'interpreter-v1' && b === 'interpreter-v2';
results.push(`${a === 'interpreter-v1' ? 'PASS' : 'FAIL'}  in-flight run A stayed on its starting build (${a})`);
results.push(`${b === 'interpreter-v2' ? 'PASS' : 'FAIL'}  new run B started on the new build (${b})`);

// Run A has drained, so build v1 can be retired.
w1.kill('SIGTERM');

const loop = await client.workflow.execute('agentLoop', {
  taskQueue: `${prefix}-v2`,
  workflowId: `${prefix}-loop`,
  args: [{ turn: 0, maxTurns: 45, turnsPerExecution: 10, transcriptDigest: 'seed', executions: 0 }],
});
const loopOk = loop.turn === 45 && loop.executions === 5 && loop.lastHistoryLength < 100;
ok &&= loopOk;
results.push(
  `${loopOk ? 'PASS' : 'FAIL'}  agent loop: ${loop.turn} turns as ${loop.turn} activities over ${loop.executions} executions; last history length ${loop.lastHistoryLength}`,
);
w2.kill('SIGTERM');
console.log(results.join('\n'));
process.exit(ok ? 0 : 1);
