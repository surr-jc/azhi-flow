import { proxyActivities } from '@temporalio/workflow';
import type * as acts from './activities.js';

const { ledgeredPost } = proxyActivities<typeof acts>({
  startToCloseTimeout: '20s',
  heartbeatTimeout: '2s',
  retry: { maximumAttempts: 5, initialInterval: '200ms', backoffCoefficient: 2 },
});

export async function postOnce(actionId: string, text: string): Promise<string> {
  return ledgeredPost(actionId, text);
}
