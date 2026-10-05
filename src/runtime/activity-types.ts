import type { HarnessInput, HarnessResult } from '../worker/harness-activity.js';
import type { AgentBeginInput, AgentState, AgentTurnInput, AgentTurnResult } from '../agents/model-agent.js';
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
  /** Interpreter-level attempt number (workers are re-selected between attempts). */
  attempt: number;
}

export interface WorkerSelection {
  online: number;
  accepted: Array<{ id: string; queue: string }>;
  refused: Array<{ id: string; reason: string }>;
}

export interface GatewayActivities {
  recordRun(runId: string, workspaceId: string, patch: RecordRunPatch): Promise<void>;
  recordNode(runId: string, workspaceId: string, nodeId: string, status: string, data?: { output?: unknown; error?: NodeError; route?: string }): Promise<void>;
  toolNode(input: ToolNodeInput): Promise<{ output: unknown; observation: { source: string; observed_at: string } & Record<string, unknown>; action?: { id: string; reused: boolean } }>;
  notifyNode(input: NotifyNodeInput): Promise<{ action_id: string; delivered: boolean; receipt: unknown }>;
  reportNode(input: ReportNodeInput): Promise<unknown>;
  /** Online workers that can run this script: capable of the runtime and trusting the package signer. */
  checkWorkers(workspaceId: string, packageHash: string, runtime: string): Promise<WorkerSelection>;
  issueRunToken(workspaceId: string, runId: string, nodeId: string, tools: string[], creds?: string[]): Promise<string>;
  /** Model agent: builds the context and the first manifest items (attempt row goes running). */
  agentBegin(input: AgentBeginInput): Promise<AgentState>;
  /** Model agent: one model turn plus its gateway tool calls. */
  agentTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
  /** Harness executors: builds the same context as the model agent, for a worker to run. */
  harnessPrepare(input: AgentBeginInput & { executor?: string }): Promise<HarnessPlan>;
  /** Harness executors: records usage, the context manifest and the attempt outcome. */
  harnessRecord(input: HarnessRecordInput): Promise<void>;
  /** Records the failure of an agent node on its attempt row. */
  agentFailed(runId: string, workspaceId: string, nodeId: string, error: NodeError): Promise<void>;
  /** Hybrid retrieval over pinned dataset revisions, with citations. */
  retrieveNode(input: RetrieveNodeInput): Promise<{ chunks: unknown[] }>;
  /** Records what approvers are asked to decide: the concrete message and payload. */
  requestApproval(runId: string, workspaceId: string, nodeId: string, request: ApprovalRequest): Promise<void>;
  /** The interpreter is the single writer of decisions, so a late signal can't race an expiry. */
  recordApproval(runId: string, workspaceId: string, nodeId: string, decision: ApprovalDecision & { recorded: 'approved' | 'rejected' | 'expired' }): Promise<void>;
}

export interface ApprovalRequest {
  message: unknown;
  payload: unknown;
  role: string;
  expires_at: string;
  on_expiry: 'fail' | 'reject';
}

export interface ApprovalDecision {
  decision: 'approved' | 'rejected';
  by: string;
  at: string;
  data: Record<string, unknown>;
}

/** Signal sent by the API after it has checked the approver's role and the decision schema. */
export interface ApprovalSignal extends ApprovalDecision {
  node: string;
}

export interface ExecActivities {
  runScript(input: ScriptNodeInput): Promise<unknown>;
  /** Harness executors (OpenCode, Claude Agent SDK, Codex) run on workers. */
  runHarness(input: HarnessInput): Promise<HarnessResult>;
}

export interface RetrieveNodeInput {
  runId: string;
  workspaceId: string;
  nodeId: string;
  pinned: Array<{ ref: string; revision: number }>;
  query: string;
  topK?: number;
  principal?: { userId: string; role: string };
}

export interface HarnessPlan {
  system: string;
  prompt: string;
  tools: Array<{ name: string; ref: string; description: string; input_schema: Record<string, unknown> }>;
  outputSchema: Record<string, unknown>;
  model: string;
  credential: string;
  providerUrl: string;
  provider: 'anthropic' | 'openai';
}

export interface HarnessRecordInput {
  runId: string;
  workspaceId: string;
  nodeId: string;
  packageHash: string;
  profile: string;
  executor: string;
  tainted?: string;
  result: HarnessResult;
}
