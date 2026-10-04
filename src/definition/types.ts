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
  output_schema?: string | JsonSchema;
  limits?: { time?: string; memory_mb?: number };
}

export interface AgentNode extends NodeCommon {
  type: 'agent';
  executor?: string;
  profile: string;
  input?: Value;
  datasets?: string[];
  tools?: string[];
  output_schema: string | JsonSchema;
  budget?: { max_output_tokens?: number; max_tool_calls?: number; max_cost_usd?: number };
  requires?: { enforced_restrictions?: boolean };
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

export interface LoopNode extends NodeCommon {
  type: 'loop';
  max_iterations: number;
  exit: string;
}

export interface SubworkflowNode extends NodeCommon {
  type: 'subworkflow';
  workflow: string;
  input?: Value;
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
  nodes: NodeDef[];
}

export function isValueExpr(v: unknown): v is ValueExpr {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && (keys[0] === 'ref' || keys[0] === 'cel' || keys[0] === 'map') && typeof (v as any)[keys[0]] === 'string';
}
