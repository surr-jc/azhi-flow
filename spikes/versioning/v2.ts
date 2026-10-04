import { condition, defineSignal, setHandler, sleep } from '@temporalio/workflow';

export const proceed = defineSignal('proceed');

/**
 * Interpreter build v2: a non-deterministic change relative to v1 (an extra timer before waiting).
 * A v1 run replayed on this code would fail, which is why runs stay on the build that started them.
 */
export async function interpret(): Promise<string> {
  await sleep(1);
  let go = false;
  setHandler(proceed, () => void (go = true));
  await condition(() => go);
  return 'interpreter-v2';
}

export { agentLoop } from './agent-loop.js';
