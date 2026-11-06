/** Workflow definition types for schema_version 2.x (spec section 7). */

export type JsonSchema = Record<string, unknown>;

/** A value in a definition: a ref, a CEL expression, a CEL map, or a literal (possibly nested). */
export type ValueExpr = { ref: string } | { cel: string } | { map: string };
export type Value = ValueExpr | string | number | boolean | null | Value[] | { [k: string]: Value };

export type NodeType =
  | 'script'
  | 'agent'
  | 'tool'
  | 'retrieve'
  | 'condition'
  | 'parallel'
  | 'loop'
  | 'subworkflow'
  | 'approval'
  | 'report'
  | 'notify';

export type EffectClass = 'read' | 'write-idempotent' | 'write-dedupable' | 'write-unsafe';

interface NodeCommon {
  id: string;
  type: NodeType;
  description?: string;
  depends_on?: string[];
  /**
   * `any`: the node joins alternative branches (for example the routes of one condition). It runs
   * when its upstream nodes have settled and at least one succeeded; skipped upstream nodes do not
   * skip it. Expressions must only read outputs of nodes that ran (guard them with the condition).
   */
  merge?: 'any';
  timeout?: string;
  retry?: { max_attempts?: number };
}

export interface ToolNode extends NodeCommon {
  type: 'tool';
  tool: string;
  arguments?: Record<string, Value>;
  project?: string[];
  guard?: string;
}

export interface ScriptNode extends NodeCommon {
  type: 'script';
  runtime: 'python' | 'bun';
  entrypoint: string;
  lockfile?: string;
  input?: Value;
  /** Names from the workflow's `contexts`: their keys are added to `input` when the workflow is compiled. */
  context?: string[];
  output_schema?: string | JsonSchema;
  limits?: { time?: string; memory_mb?: number };
}

export interface AgentNode extends NodeCommon {
  type: 'agent';
  executor?: string;
  profile: string;
  input?: Value;
  /** Names from the workflow's `contexts`: their keys are added to `input` when the workflow is compiled. */
  context?: string[];
  datasets?: string[];
  tools?: string[];
  output_schema: string | JsonSchema;
  budget?: { max_output_tokens?: number; max_tool_calls?: number; max_cost_usd?: number };
  /** Cap on the bytes of input that reach the model: fail (default) or withhold the largest fields. */
  context_budget?: { max_item_bytes?: number; max_input_bytes?: number; on_exceed?: 'fail' | 'withhold' };
  requires?: { enforced_restrictions?: boolean };
  /** A git checkout the harness works in (OpenCode only): cloned fresh on the worker and deleted after. */
  workspace?: AgentWorkspace;
}

export interface AgentWorkspace {
  /** `owner/name`. */
  repo: Value;
  /** The ref to check out, for example `refs/pull/7/head`. */
  ref: Value;
  /** A second ref fetched as `refs/azhi/base`, so tools can diff against it. */
  base_ref?: Value;
  /**
   * A ref merged into `ref` before the step starts (`git merge --no-commit`), for example `refs/heads/main` into a
   * pull request's head. Conflicts are left as markers. Needs full history (no `depth`), and cannot be combined
   * with `base_ref` or `from`. A write-mode step's change is then measured from this ref's tip.
   */
  merge_ref?: Value;
  /**
   * Continue from an earlier change: a plain `{ref: nodes.<id>.output...}` to a workspace change (the `workspace`
   * field of a write-mode step, or anything shaped like it). The worker checks out the change's own `base_sha`
   * and applies its files as a local commit, so this step starts with the earlier files already in place.
   */
  from?: Value;
  /** Literal git host base URL. Default https://github.com. */
  host?: string;
  /** Workspace secret holding a read-only token, sent only to `host`. */
  credential?: string;
  /** Shallow fetch depth; full history when absent. */
  depth?: number;
  /**
   * `read` (default): the agent may only read the checkout. `write`: it may also edit files in it, and the
   * worker returns what changed as the node output's `workspace` field (base commit, changed files, diff,
   * test result). Nothing is pushed from the worker: a write tool after an approval does that.
   */
  mode?: 'read' | 'write';
  /** Write mode: a shell command the worker runs in the checkout after the agent submits (repository code runs on the worker). */
  test?: { command: string; timeout?: string; attempts?: number };
}

export interface RetrieveNode extends NodeCommon {
  type: 'retrieve';
  datasets: string[];
  query: Value;
  filters?: Record<string, Value>;
  top_k?: number;
}

export interface ConditionNode extends NodeCommon {
  type: 'condition';
  expression: string;
  routes: Record<string, string[]>;
  default?: string;
}

export interface ParallelNode extends NodeCommon {
  type: 'parallel';
  for_each: Value;
  node: Omit<ToolNode, 'id'> | Omit<ScriptNode, 'id'>;
  max_concurrency?: number;
  max_items?: number;
  join?: 'all' | 'any';
}

/**
 * Repeats one tool or script step, one iteration after another. The body sees `state` (the
 * previous iteration's output, `initial` for the first) and `iteration` (0-based). After each
 * iteration `exit` (CEL, with `state` set to that iteration's output and `iteration` to the number
 * completed) decides whether to stop. Output: `{state, iterations, count, exited}`.
 */
export interface LoopNode extends NodeCommon {
  type: 'loop';
  node: Omit<ToolNode, 'id'> | Omit<ScriptNode, 'id'>;
  initial?: Value;
  max_iterations: number;
  exit: string;
  /** What reaching max_iterations without the exit condition does. Default: fail. */
  on_max?: 'fail' | 'continue';
}

export interface LoopExitRule {
  /** CEL over the round's steps and its state. The first rule that holds ends the loop; none means another round. */
  when: string;
  outcome: 'done' | 'stop' | 'no_progress';
  /** Fixed text written by the author: it never carries ticket or repository text. */
  reason?: string;
}

/**
 * Repeats several steps, agents included, as a loop the compiler writes out: every round becomes ordinary steps and a
 * gate, and this node becomes the join later steps read (see compiler/loops.ts). It never reaches the interpreter.
 */
export interface LoopBlockNode extends NodeCommon {
  type: 'loop';
  max_iterations: number;
  on_max?: 'fail' | 'continue';
  /** The state of round 1. Inside the body, `state.<key>` is replaced by its value for that round. */
  initial?: Record<string, Value>;
  body: NodeDef[];
  /** Per round (1-based), per step: fields that replace the step's own, for example a stronger profile. */
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  exit: LoopExitRule[];
  /** The state of the next round, reading this round's steps. A key left out keeps its value. */
  next?: Record<string, Value>;
}

/** What a LoopBlockNode compiles to, once its rounds have settled. Only the compiler writes one. */
export interface LoopJoinNode extends NodeCommon {
  type: 'loop';
  merge: 'any';
  depends_on: string[];
  max_iterations: number;
  on_max?: 'fail' | 'continue';
  reasons: Record<string, string>;
  /** `required`: the steps no route inside the round can skip, so a round that ran must have run them. */
  rounds: Array<{ gate: string; required: string[]; steps: Record<string, Value> }>;
}

export interface SubworkflowNode extends NodeCommon {
  type: 'subworkflow';
  workflow: string;
  input?: Value;
  /** `continue`: a child that does not succeed completes this node with its state and error instead of failing the run. Default `fail`. */
  on_failure?: 'fail' | 'continue';
}

export interface ApprovalNode extends NodeCommon {
  type: 'approval';
  role?: string;
  message?: Value;
  payload?: Value;
  decision_schema?: JsonSchema;
  expires_in?: string;
  on_expiry?: 'fail' | 'reject';
}

export interface ReportNode extends NodeCommon {
  type: 'report';
  template: string;
  format?: 'markdown' | 'html' | 'csv';
  input?: Value;
  /** Names from the workflow's `contexts`: their keys are added to `input` when the workflow is compiled. */
  context?: string[];
  summary?: Value;
}

export interface NotifyNode extends NodeCommon {
  type: 'notify';
  channel: 'slack';
  destination: Value;
  message: Value;
  guard?: string;
}

export type NodeDef =
  | ToolNode
  | ScriptNode
  | AgentNode
  | RetrieveNode
  | ConditionNode
  | ParallelNode
  | LoopNode
  | LoopBlockNode
  | LoopJoinNode
  | SubworkflowNode
  | ApprovalNode
  | ReportNode
  | NotifyNode;

export interface WorkflowDefinition {
  schema_version: string;
  id: string;
  name?: string;
  description?: string;
  trigger?: {
    schedule?: { cron: string; timezone: string };
    manual?: boolean;
  };
  inputs?: JsonSchema;
  config?: Record<string, unknown>;
  /**
   * Named sets of upstream values several steps need. A step lists `context: [name]`; the compiler adds the
   * bundle's keys to the step's `input`, so a bundle is only a way to write the same input once.
   */
  contexts?: Record<string, Record<string, Value>>;
  /** Provider and model for every agent step whose profile says `name: default`; a run may override it. Steps that name a model keep it. */
  model_defaults?: { provider?: 'anthropic' | 'openai' | 'github-copilot' | 'openai-chatgpt'; name?: string };
  nodes: NodeDef[];
}

export function isValueExpr(v: unknown): v is ValueExpr {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && (keys[0] === 'ref' || keys[0] === 'cel' || keys[0] === 'map') && typeof (v as any)[keys[0]] === 'string';
}
