import { readFileSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJson, sha256 } from '../lib/hash.js';
import { ApiClient } from '../worker/api-client.js';
import { MAX_REPAIRS, MAX_REPEATED_FAILURES } from './limits.js';
import { SUBMIT_TOOL } from './providers.js';

/**
 * The gateway bridged to a harness as a stdio MCP server (spec section 9: harnesses reach the
 * gateway as an MCP server). It holds only a run-scoped token: every tool call goes through
 * POST /v1/gateway/call, where authorisation, the ledger and the taint rule apply. It also
 * offers `submit_output`, validates the result against the node's output schema, and keeps a
 * small state file the adapter reads afterwards (output, tool calls, repairs, failures).
 *
 * Configured by the adapter through environment variables, never by the package.
 */
export interface BridgeTool {
  name: string;
  ref: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface BridgeState {
  output?: unknown;
  toolCalls: number;
  repairs: number;
  failures: Record<string, number>;
  /** Set when the bridge stops the node: budget, repeated failures or repairs exhausted. */
  stopped?: { class: string; message: string };
  calls: Array<{ tool: string; ok: boolean }>;
}

export async function runGatewayBridge(env: NodeJS.ProcessEnv = process.env) {
  const tools = JSON.parse(env.AZHI_BRIDGE_TOOLS ?? '[]') as BridgeTool[];
  const outputSchema = JSON.parse(env.AZHI_BRIDGE_OUTPUT_SCHEMA ?? '{"type":"object"}') as Record<string, unknown>;
  const stateFile = env.AZHI_BRIDGE_STATE!;
  const maxToolCalls = env.AZHI_BRIDGE_MAX_TOOL_CALLS ? Number(env.AZHI_BRIDGE_MAX_TOOL_CALLS) : undefined;
  const api = new ApiClient(env.AZHI_URL!, env.AZHI_RUN_TOKEN!);
  const wrapped = outputSchema.type !== 'object';
  const submitSchema = wrapped ? { type: 'object', properties: { value: outputSchema }, required: ['value'] } : outputSchema;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(outputSchema);

  const load = (): BridgeState => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      return { toolCalls: 0, repairs: 0, failures: {}, calls: [] };
    }
  };
  const save = (s: BridgeState) => writeFileSync(stateFile, JSON.stringify(s));
  save(load());

  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });
  const server = new Server({ name: 'azhi', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema as { type: 'object' } })),
      { name: SUBMIT_TOOL, description: 'Return the final result of this node. Call exactly once.', inputSchema: submitSchema as { type: 'object' } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const s = load();
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (s.stopped) return text(`stopped: ${s.stopped.message}`, true);

    if (req.params.name === SUBMIT_TOOL) {
      const value = wrapped ? args.value : args;
      if (validate(value)) {
        s.output = value;
        save(s);
        return text('accepted');
      }
      s.repairs++;
      const failed = (validate.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message }));
      if (s.repairs > MAX_REPAIRS) s.stopped = { class: 'contract_violation', message: `output still invalid after ${MAX_REPAIRS} repair attempts: ${JSON.stringify(failed)}` };
      save(s);
      return text(JSON.stringify({ error: 'contract_violation', failed_fields: failed }), true);
    }

    const tool = tools.find((t) => t.name === req.params.name);
    s.toolCalls++;
    if (maxToolCalls !== undefined && s.toolCalls > maxToolCalls) {
      s.stopped = { class: 'budget_exceeded', message: `tool calls exceed the budget of ${maxToolCalls}` };
      save(s);
      return text(s.stopped.message, true);
    }
    if (!tool) {
      save(s);
      return text(JSON.stringify({ error: 'authorization', message: `tool ${req.params.name} is not allowed for this node` }), true);
    }
    try {
      const r = await api.post<{ output: unknown }>('/v1/gateway/call', { tool: tool.ref, args });
      s.calls.push({ tool: tool.ref, ok: true });
      save(s);
      return text(JSON.stringify(r.output));
    } catch (err) {
      const body = (err as { body?: { error?: string; message?: string; details?: unknown } }).body;
      const message = JSON.stringify({ error: body?.error ?? 'transient', message: body?.message ?? (err as Error).message });
      const sig = sha256(canonicalJson({ tool: tool.ref, args, error: body?.error }));
      s.failures[sig] = (s.failures[sig] ?? 0) + 1;
      s.calls.push({ tool: tool.ref, ok: false });
      if (s.failures[sig]! > MAX_REPEATED_FAILURES) s.stopped = { class: 'contract_violation', message: `the agent repeated a failing call to ${tool.ref} after ${MAX_REPEATED_FAILURES} correction attempts: ${message}` };
      save(s);
      return text(message, true);
    }
  });

  await server.connect(new StdioServerTransport());
}
