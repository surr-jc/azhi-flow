#!/usr/bin/env node
// The tool gateway bridge OpenCode starts over stdio MCP. A file of its own (not `azhi gateway-mcp`)
// so it loads only what it needs: OpenCode gives an MCP server a fixed time to connect.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Packaged app: compiled JavaScript sits next to this file; a source checkout goes through tsx.
if (existsSync(fileURLToPath(new URL('../src/agents/gateway-mcp.js', import.meta.url)))) {
  const { runGatewayBridge } = await import('../src/agents/gateway-mcp.js');
  await runGatewayBridge();
} else {
  const { register } = await import('tsx/esm/api');
  register();
  const { runGatewayBridge } = await import('../src/agents/gateway-mcp.ts');
  await runGatewayBridge();
}
