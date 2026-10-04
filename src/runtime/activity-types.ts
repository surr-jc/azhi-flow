/** Activity signatures shared by the interpreter workflow and the processes that implement them. */
import type { NodeError, RunFlags, RunState } from './types.js';

export interface RecordRunPatch {
  state?: RunState;
  flags?: RunFlags;
  error?: NodeError | null;
  event?: { kind: string; node?: string; data?: Record<string, unknown> };
}

export interface ToolNodeInput {
  runId: string;
  workspaceId: string;
  nodeId: string;
  tool: string;
  revision?: number;
  args: Record<string, unknown>;
  project?: string[];
  allowed: string[];
  ordinal?: number;
  mock?: boolean;
}

export interface NotifyNodeInput {
  runId: string;
  workspaceId: string;
  nodeId: string;
  channel: 'slack';
  destination: string;
  text: string;
  mock?: boolean;
}

export interface ReportNodeInput {
  runId: string;
  workspaceId: string;
  nodeId: string;
  packageHash: string;
  template: string;
  format: 'markdown' | 'html' | 'csv';
  input: unknown;
  summary?: unknown;
  asOf: Record<string, string>;
}

export interface ScriptNodeInput {
  runId: string;
  workspaceId: string;
  nodeId: string;
  packageHash: string;
  runtime: 'python' | 'bun';
  entrypoint: string;
  lockfile?: string;
  input: unknown;
  outputSchema?: Record<string, unknown> | string;
  limits: { timeMs: number; memoryMb?: number };
  runToken: string;
}

export interface GatewayActivities {
  recordRun(runId: string, workspaceId: string, patch: RecordRunPatch): Promise<void>;
  recordNode(runId: string, workspaceId: string, nodeId: string, status: string, data?: { output?: unknown; error?: NodeError; route?: string }): Promise<void>;
  toolNode(input: ToolNodeInput): Promise<{ output: unknown; observation: { source: string; observed_at: string } & Record<string, unknown>; action?: { id: string; reused: boolean } }>;
  notifyNode(input: NotifyNodeInput): Promise<{ action_id: string; delivered: boolean; receipt: unknown }>;
  reportNode(input: ReportNodeInput): Promise<unknown>;
  checkWorkers(workspaceId: string, queue: string): Promise<{ online: number }>;
  issueRunToken(workspaceId: string, runId: string, nodeId: string, tools: string[]): Promise<string>;
}

export interface ExecActivities {
  runScript(input: ScriptNodeInput): Promise<unknown>;
}
