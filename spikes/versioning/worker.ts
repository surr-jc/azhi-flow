import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import * as activities from './activities.js';
import { TEMPORAL_ADDRESS } from '../env.js';

const build = process.env.SPIKE_BUILD!;
const worker = await Worker.create({
  connection: await NativeConnection.connect({ address: TEMPORAL_ADDRESS }),
  taskQueue: `${process.env.SPIKE_QUEUE_PREFIX}-${build}`,
  workflowsPath: fileURLToPath(new URL(`./${build}.ts`, import.meta.url)),
  activities,
});
await worker.run();
