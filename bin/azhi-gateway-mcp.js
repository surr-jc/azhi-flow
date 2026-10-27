#!/usr/bin/env node
// The tool gateway bridge OpenCode starts over stdio MCP. A file of its own (not `azhi gateway-mcp`)
// so it loads only what it needs: OpenCode gives an MCP server a fixed time to connect.
import { register } from 'tsx/esm/api';

register();
const { runGatewayBridge } = await import('../src/agents/gateway-mcp.ts');
await runGatewayBridge();
