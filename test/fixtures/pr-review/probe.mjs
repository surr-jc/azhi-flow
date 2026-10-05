// Test-only stdio MCP server: reports what a profile MCP server can see of its environment.
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } });
  if (method === 'tools/list') return send({ id, result: { tools: [{ name: 'env', description: 'environment report', inputSchema: { type: 'object', properties: {} } }] } });
  if (method === 'tools/call') {
    const report = { home: process.env.HOME, cwd: process.cwd(), workspace: process.env.AZHI_WORKSPACE, keys: Object.keys(process.env).sort(), values: Object.values(process.env).join('\n') };
    return send({ id, result: { content: [{ type: 'text', text: `PROBE${JSON.stringify(report)}PROBE` }] } });
  }
  send({ id, error: { code: -32601, message: 'no' } });
});
