import type { EffectClass, JsonSchema, NodeDef, WorkflowDefinition } from '../definition/types.js';

export const COMPILER_VERSION = '0.1.0';

export interface PlanNode {
  id: string;
  type: NodeDef['type'];
  /** All upstream node IDs: data refs, CEL references, depends_on and condition routes. */
  deps: string[];
  def: NodeDef;
  outputSchema?: JsonSchema;
  /** Resolved input schemas loaded from the package (script/agent output schemas). */
  timeoutMs: number;
  maxAttempts: number;
  tool?: { ref: string; effect: EffectClass; revision?: number; outputTrusted: boolean; safeForTainted: boolean };
  route?: { condition: string; route: string };
}

/** The compiler's execution plan: what the interpreter runs, pinned to one definition. */
export interface ExecutionPlan {
  format: 'azhi-plan/1';
  compiler: string;
  workflowId: string;
  definitionHash: string;
  packageHash?: string;
  inputsSchema?: JsonSchema;
  config: Record<string, unknown>;
  trigger?: WorkflowDefinition['trigger'];
  /** Topologically ordered. */
  nodes: PlanNode[];
}

export const REPORT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    markdown: { type: 'string' },
    summary: { type: 'string' },
    format: { type: 'string' },
    citations: { type: 'array', items: { type: 'object' } },
    as_of: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['markdown', 'summary'],
};

export const NOTIFY_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    action_id: { type: 'string' },
    delivered: { type: 'boolean' },
    receipt: { type: 'object' },
  },
};

export const CONDITION_OUTPUT_SCHEMA: JsonSchema = { type: 'object', properties: { route: { type: 'string' } } };

export const APPROVAL_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    decision: { enum: ['approved', 'rejected'] },
    by: { type: 'string' },
    at: { type: 'string' },
    data: { type: 'object' },
  },
};

export const RETRIEVE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    chunks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          citation_id: { type: 'string' },
          dataset: { type: 'string' },
          revision: { type: 'integer' },
          document: { type: 'string' },
          text: { type: 'string' },
          start: { type: 'integer' },
          end: { type: 'integer' },
          score: { type: 'number' },
        },
      },
    },
  },
};

export const DEFAULT_TIMEOUTS: Record<NodeDef['type'], number> = {
  tool: 60_000,
  script: 600_000,
  agent: 900_000,
  retrieve: 60_000,
  condition: 1_000,
  parallel: 3_600_000,
  loop: 3_600_000,
  subworkflow: 3_600_000,
  approval: 7 * 86_400_000,
  report: 60_000,
  notify: 60_000,
};
