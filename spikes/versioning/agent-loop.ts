import { continueAsNew, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as acts from './activities.js';

const { modelTurn } = proxyActivities<typeof acts>({ startToCloseTimeout: '10s' });

export interface LoopState {
  turn: number;
  maxTurns: number;
  turnsPerExecution: number;
  transcriptDigest: string;
  executions: number;
}

/** One Activity per model turn; continue-as-new well before history limits. */
export async function agentLoop(state: LoopState): Promise<LoopState & { lastHistoryLength: number }> {
  let s = { ...state, executions: state.executions + 1 };
  for (let i = 0; i < s.turnsPerExecution && s.turn < s.maxTurns; i++) {
    const out = await modelTurn(s.turn, s.transcriptDigest);
    s = { ...s, turn: s.turn + 1, transcriptDigest: out };
  }
  if (s.turn < s.maxTurns) await continueAsNew<typeof agentLoop>(s);
  return { ...s, lastHistoryLength: workflowInfo().historyLength };
}
