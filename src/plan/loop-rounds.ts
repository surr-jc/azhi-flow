import type { ExecutionPlan } from '../compiler/plan.js';

/**
 * What each round of a loop did, from the plan and the stored attempts, so a failed run has it too: the join only
 * exists once the rounds have settled. This is the record a person reads and that later analysis of runs can use.
 */
export interface RoundStep {
  step: string;
  node_id: string;
  /** The latest attempt's state, `skipped` when its round skipped it, or `not_run` when it has not been reached. */
  state: string;
}

export interface RoundUsage {
  /** Null when unknown: no record, or a record that did not report it. */
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  currency: string | null;
}

export interface LoopRound {
  round: number;
  /** How the gate ended the round; null until it has. */
  outcome: string | null;
  reason: string | null;
  steps: RoundStep[];
  usage: RoundUsage;
}

export interface LoopSummary {
  id: string;
  max_rounds: number;
  /** How the loop ended; null while it is still running or if it failed first. */
  outcome: string | null;
  rounds: LoopRound[];
}

interface AttemptRow {
  node_id: string;
  attempt: number;
  state: string;
  output?: unknown;
}

interface UsageRow {
  node_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  currency: string | null;
}

/** A total, or null as soon as one record does not know it. */
function total(values: Array<number | null>): number | null {
  if (!values.length || values.some((v) => v === null || v === undefined)) return null;
  return (values as number[]).reduce((a, b) => a + Number(b), 0);
}

function usageOf(rows: UsageRow[]): RoundUsage {
  const currencies = new Set(rows.map((r) => r.currency));
  const one = currencies.size === 1 ? [...currencies][0]! : null;
  return { input_tokens: total(rows.map((r) => r.input_tokens)), output_tokens: total(rows.map((r) => r.output_tokens)), cost: one ? total(rows.map((r) => r.cost)) : null, currency: one };
}

export function loopRounds(plan: ExecutionPlan, attempts: AttemptRow[], usage: UsageRow[]): LoopSummary[] {
  const latest = new Map<string, AttemptRow>();
  for (const a of attempts) if (!latest.has(a.node_id) || latest.get(a.node_id)!.attempt <= a.attempt) latest.set(a.node_id, a);

  // Reading a run must not fail on the plan it was made from, however incomplete.
  return (plan.nodes ?? []).flatMap((join) => {
    const def = join.def as { rounds?: unknown[]; reasons?: Record<string, string>; max_iterations?: number };
    if (join.type !== 'loop' || !def.rounds) return [];
    const members = plan.nodes.filter((n) => n.loop?.loop === join.id);
    const rounds: LoopRound[] = [];
    for (let round = 1; round <= def.rounds.length; round++) {
      const inRound = members.filter((n) => n.loop!.round === round);
      // A round not taken has rows too, each saying its step was skipped: it did not start.
      if (!inRound.some((n) => latest.has(n.id) && latest.get(n.id)!.state !== 'skipped')) continue;
      const gate = inRound.find((n) => n.loop!.step === 'gate');
      const decided = gate && latest.get(gate.id)?.state === 'succeeded' ? ((latest.get(gate.id)!.output as { route?: string } | null)?.route ?? null) : null;
      const ids = new Set(inRound.map((n) => n.id));
      rounds.push({
        round,
        outcome: decided,
        reason: decided ? (def.reasons?.[decided] ?? null) : null,
        steps: inRound.filter((n) => n.loop!.step !== 'gate').map((n) => ({ step: n.loop!.step, node_id: n.id, state: latest.get(n.id)?.state ?? 'not_run' })),
        usage: usageOf(usage.filter((u) => ids.has(u.node_id))),
      });
    }
    const last = rounds[rounds.length - 1]?.outcome ?? null;
    return [{ id: join.id, max_rounds: def.rounds.length, outcome: last === 'retry' ? null : last, rounds }];
  });
}
