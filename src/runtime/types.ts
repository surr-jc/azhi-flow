import type { ExecutionPlan } from '../compiler/plan.js';

/** ADR-09: four live states, five terminal. */
export type RunState = 'queued' | 'running' | 'waiting' | 'cancelling' | 'succeeded' | 'delivery_failed' | 'failed' | 'cancelled' | 'expired';
export const TERMINAL_STATES: RunState[] = ['succeeded', 'delivery_failed', 'failed', 'cancelled', 'expired'];
export const LIVE_STATES: RunState[] = ['queued', 'running', 'waiting', 'cancelling'];

export interface RunFlags {
  waiting_reason?: { reason: 'approval' | 'external_event' | 'worker_offline'; node?: string; expires_at: string };
  termination_unconfirmed?: boolean;
  interrupted_sessions?: string[];
  usage_incomplete?: boolean;
}

export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface RunSnapshot {
  /** ADR-08: `now` in CEL. */
  reference_time: string;
  interpreter_build: string;
  package_hash: string;
  workflow_version_id: string;
  tool_revisions: Record<string, number>;
  trigger: 'manual' | 'schedule' | 'api' | 'test' | 'subworkflow';
  /** Set on a run started by a subworkflow node: the parent run and node, and the workflows above this one. */
  parent?: { run_id: string; node_id: string; chain: string[] };
  occurrence_id?: string;
  /** The deployment's gateway task queue; absent on older runs. */
  gateway_queue?: string;
  test_node?: { node: string; fixtures: Record<string, unknown> };
  /** Dataset refs (tags included) pinned to index revisions when the run was created. */
  dataset_revisions?: Record<string, number>;
  /** Whose access dataset reads are checked against. */
  principal?: { userId: string; role: string };
  settings?: Record<string, unknown>;
  /** Provider and model for agent steps whose profile says `name: default`: the run's choice, else the workflow's. */
  /** Set when the defaults were chosen for this run (not taken from the workflow), so subworkflows inherit them. */
  model_defaults_chosen?: boolean;
  model_defaults?: { provider?: 'anthropic' | 'openai' | 'github-copilot' | 'openai-chatgpt'; name?: string };
}

export interface RunInput {
  runId: string;
  workspaceId: string;
  plan: ExecutionPlan;
  inputs: Record<string, unknown>;
  snapshot: RunSnapshot;
  /** test-node / test runs: write tools are mocked. */
  mockWrites?: boolean;
}

export interface NodeError {
  class: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RunStatus {
  state: RunState;
  flags: RunFlags;
  nodes: Record<string, { status: NodeStatus; error?: NodeError; route?: string }>;
  error?: NodeError;
}
