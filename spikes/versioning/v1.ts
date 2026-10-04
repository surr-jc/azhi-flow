import { condition, defineSignal, setHandler } from '@temporalio/workflow';

export const proceed = defineSignal('proceed');

/** Interpreter build v1. */
export async function interpret(): Promise<string> {
  let go = false;
  setHandler(proceed, () => void (go = true));
  await condition(() => go);
  return 'interpreter-v1';
}

export { agentLoop } from './agent-loop.js';
