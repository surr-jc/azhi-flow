import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { audit } from '../server/catalog.js';
import { checkCall, TOOLS, type AssistantDeps, type Caller } from './tools.js';

/**
 * Azhi Flow as a Streamable HTTP MCP server (POST /v1/assistant/mcp), so Claude Code, Codex,
 * OpenCode and other agents can look up, start and watch workflows. It offers the assistant's own
 * tools (tools.ts), as the person whose API token the client sends: tools above their role are not
 * listed, and every call is checked again. Actions run when called (the MCP client asks its user),
 * except approvals, which stay with a person in mission control or Slack. Every call is audited.
 *
 * Stateless: a new server and transport per request, so nothing is kept between calls.
 */
const RANK = { viewer: 0, operator: 1, author: 2, admin: 3, owner: 4 } as const;

export async function handleMcp(d: AssistantDeps, p: Caller, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const offered = TOOLS.filter((t) => t.mcp !== false && RANK[p.role] >= RANK[t.role]);
  const server = new Server({ name: 'azhi-flow', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: offered.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema as { type: 'object' },
      annotations: t.effect === 'read' ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: t.name === 'cancel_run' || t.name === 'set_schedule_enabled' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const name = call.params.name;
    try {
      if (!offered.some((t) => t.name === name)) throw new Error(`tool ${name} is not offered to this token`);
      const { tool, args } = checkCall(p, name, call.params.arguments ?? {});
      const out = await tool.run(d, p, args);
      await audit(d.ctx, p.workspaceId, p.userId, 'mcp.call', { tool: name, effect: tool.effect, ok: true, ...(tool.effect === 'act' ? { args } : {}) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 1) ?? 'null' }] };
    } catch (e) {
      await audit(d.ctx, p.workspaceId, p.userId, 'mcp.call', { tool: name, ok: false, error: (e as Error).message.slice(0, 500) });
      return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
