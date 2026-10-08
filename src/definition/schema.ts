/**
 * JSON Schema (draft 2020-12) for the canonical workflow document, schema_version 2.x.
 * YAML is the authoring format; it is parsed to JSON and validated against this.
 */
const id = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', maxLength: 64 };
const duration = { type: 'string', pattern: '^(\\d+(\\.\\d+)?(ms|s|m|h|d))+$' };

const common = {
  id,
  type: { type: 'string' },
  description: { type: 'string' },
  depends_on: { type: 'array', items: id, uniqueItems: true },
  merge: { enum: ['any'] },
  timeout: duration,
  retry: { type: 'object', properties: { max_attempts: { type: 'integer', minimum: 1, maximum: 10 } }, additionalProperties: false },
};

const schemaRef = { oneOf: [{ type: 'string' }, { type: 'object' }] };

function node(type: string, props: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    properties: { ...common, ...props, type: { const: type } },
    required: ['id', 'type', ...required],
    additionalProperties: false,
  };
}

const toolProps = {
  tool: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*@\\d+$' },
  arguments: { type: 'object', additionalProperties: { $ref: '#/$defs/value' } },
  project: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$' } },
  guard: { type: 'string' },
};

const scriptProps = {
  runtime: { enum: ['python', 'bun'] },
  entrypoint: { type: 'string' },
  lockfile: { type: 'string' },
  input: { $ref: '#/$defs/value' },
  output_schema: schemaRef,
  limits: {
    type: 'object',
    properties: { time: duration, memory_mb: { type: 'integer', minimum: 16 } },
    additionalProperties: false,
  },
};

export const workflowSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://azhi.dev/schema/workflow-2.0.json',
  title: 'Azhi Flow workflow definition',
  type: 'object',
  properties: {
    schema_version: { type: 'string', pattern: '^2\\.\\d+(\\.\\d+)?$' },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', maxLength: 80 },
    name: { type: 'string' },
    description: { type: 'string' },
    trigger: {
      type: 'object',
      properties: {
        schedule: {
          type: 'object',
          properties: { cron: { type: 'string' }, timezone: { type: 'string' } },
          required: ['cron', 'timezone'],
          additionalProperties: false,
        },
        manual: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    inputs: { type: 'object' },
    config: { type: 'object' },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'type'],
        properties: { type: { enum: ['script', 'agent', 'tool', 'retrieve', 'condition', 'parallel', 'loop', 'subworkflow', 'approval', 'report', 'notify'] } },
        allOf: [
          { if: { properties: { type: { const: 'tool' } } }, then: { $ref: '#/$defs/tool' } },
          { if: { properties: { type: { const: 'script' } } }, then: { $ref: '#/$defs/script' } },
          { if: { properties: { type: { const: 'agent' } } }, then: { $ref: '#/$defs/agent' } },
          { if: { properties: { type: { const: 'retrieve' } } }, then: { $ref: '#/$defs/retrieve' } },
          { if: { properties: { type: { const: 'condition' } } }, then: { $ref: '#/$defs/condition' } },
          { if: { properties: { type: { const: 'parallel' } } }, then: { $ref: '#/$defs/parallel' } },
          { if: { properties: { type: { const: 'loop' } } }, then: { $ref: '#/$defs/loop' } },
          { if: { properties: { type: { const: 'subworkflow' } } }, then: { $ref: '#/$defs/subworkflow' } },
          { if: { properties: { type: { const: 'approval' } } }, then: { $ref: '#/$defs/approval' } },
          { if: { properties: { type: { const: 'report' } } }, then: { $ref: '#/$defs/report' } },
          { if: { properties: { type: { const: 'notify' } } }, then: { $ref: '#/$defs/notify' } },
        ],
      },
    },
  },
  required: ['schema_version', 'id', 'nodes'],
  additionalProperties: false,
  $defs: {
    value: {
      oneOf: [
        { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
        { type: 'object', properties: { cel: { type: 'string' } }, required: ['cel'], additionalProperties: false },
        { type: 'object', properties: { map: { type: 'string' } }, required: ['map'], additionalProperties: false },
        {
          type: 'object',
          not: {
            anyOf: [{ required: ['ref'] }, { required: ['cel'] }, { required: ['map'] }],
          },
          additionalProperties: { $ref: '#/$defs/value' },
        },
        { type: 'array', items: { $ref: '#/$defs/value' } },
        { type: ['string', 'number', 'boolean', 'null'] },
      ],
    },
    tool: node('tool', toolProps, ['tool']),
    script: node('script', scriptProps, ['runtime', 'entrypoint']),
    agent: node(
      'agent',
      {
        executor: { type: 'string' },
        profile: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*@\\d+$' },
        input: { $ref: '#/$defs/value' },
        datasets: { type: 'array', items: { type: 'string' } },
        tools: { type: 'array', items: { type: 'string' } },
        output_schema: schemaRef,
        budget: {
          type: 'object',
          properties: {
            max_output_tokens: { type: 'integer', minimum: 1 },
            max_tool_calls: { type: 'integer', minimum: 0 },
            max_cost_usd: { type: 'number', minimum: 0 },
          },
          additionalProperties: false,
        },
        requires: { type: 'object', properties: { enforced_restrictions: { type: 'boolean' } }, additionalProperties: false },
        workspace: {
          type: 'object',
          properties: {
            repo: { $ref: '#/$defs/value' },
            ref: { $ref: '#/$defs/value' },
            base_ref: { $ref: '#/$defs/value' },
            host: { type: 'string', pattern: '^https?://' },
            credential: { type: 'string' },
            depth: { type: 'integer', minimum: 1 },
            mode: { enum: ['read', 'write'] },
            test: {
              type: 'object',
              properties: {
                command: { type: 'string', minLength: 1, maxLength: 1000 },
                timeout: duration,
                attempts: { type: 'integer', minimum: 1, maximum: 5 },
              },
              required: ['command'],
              additionalProperties: false,
            },
          },
          required: ['repo', 'ref'],
          additionalProperties: false,
        },
      },
      ['profile', 'output_schema'],
    ),
    retrieve: node(
      'retrieve',
      {
        datasets: { type: 'array', items: { type: 'string' }, minItems: 1 },
        query: { $ref: '#/$defs/value' },
        filters: { type: 'object', additionalProperties: { $ref: '#/$defs/value' } },
        top_k: { type: 'integer', minimum: 1, maximum: 50 },
      },
      ['datasets', 'query'],
    ),
    condition: node(
      'condition',
      {
        expression: { type: 'string' },
        routes: { type: 'object', additionalProperties: { type: 'array', items: id }, minProperties: 1 },
        default: { type: 'string' },
      },
      ['expression', 'routes'],
    ),
    parallel: node(
      'parallel',
      {
        for_each: { $ref: '#/$defs/value' },
        node: {
          type: 'object',
          properties: { type: { enum: ['tool', 'script'] } },
          required: ['type'],
        },
        max_concurrency: { type: 'integer', minimum: 1, maximum: 64 },
        max_items: { type: 'integer', minimum: 1, maximum: 10000 },
        join: { enum: ['all', 'any'] },
      },
      ['for_each', 'node'],
    ),
    loop: node(
      'loop',
      {
        node: { type: 'object', properties: { type: { enum: ['tool', 'script'] } }, required: ['type'] },
        initial: { $ref: '#/$defs/value' },
        max_iterations: { type: 'integer', minimum: 1, maximum: 1000 },
        exit: { type: 'string' },
        on_max: { enum: ['fail', 'continue'] },
      },
      ['node', 'max_iterations', 'exit'],
    ),
    subworkflow: node('subworkflow', { workflow: { type: 'string' }, input: { $ref: '#/$defs/value' } }, ['workflow']),
    approval: node('approval', {
      role: { enum: ['owner', 'admin', 'author', 'operator'] },
      message: { $ref: '#/$defs/value' },
      payload: { $ref: '#/$defs/value' },
      decision_schema: { type: 'object' },
      expires_in: duration,
      on_expiry: { enum: ['fail', 'reject'] },
    }),
    report: node(
      'report',
      {
        template: { type: 'string' },
        format: { enum: ['markdown', 'html', 'csv'] },
        input: { $ref: '#/$defs/value' },
        summary: { $ref: '#/$defs/value' },
      },
      ['template'],
    ),
    notify: node(
      'notify',
      {
        channel: { enum: ['slack'] },
        destination: { $ref: '#/$defs/value' },
        message: { $ref: '#/$defs/value' },
        guard: { type: 'string' },
      },
      ['channel', 'destination', 'message'],
    ),
  },
} as const;
