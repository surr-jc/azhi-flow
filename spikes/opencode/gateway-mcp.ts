/** A stand-in for the Azhi tool gateway's MCP bridge, exposing one read tool over stdio. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'azhi-gateway', version: '0.0.0' });
server.registerTool(
  'ci_list_runs',
  { description: 'List CI runs for a team (spike stub)', inputSchema: { team: z.string() } },
  async ({ team }) => ({ content: [{ type: 'text', text: JSON.stringify({ team, runs: [] }) }] }),
);
await server.connect(new StdioServerTransport());
