import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import * as activities from './activities.js';
import { TEMPORAL_ADDRESS } from '../env.js';

const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
const worker = await Worker.create({
  connection,
  taskQueue: process.env.SPIKE_QUEUE!,
  workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
  activities,
});
console.log(`[worker ${process.pid}] started crashAt=${process.env.SPIKE_CRASH_AT ?? 'none'}`);
await worker.run();
