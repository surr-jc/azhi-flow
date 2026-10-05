#!/usr/bin/env node
// A stand-in for a Jira MCP server (the `jira_get_issue` tool of mcp-atlassian), for tests.
// Issues come from FAKE_JIRA_DATA (a JSON file of key -> issue, in mcp-atlassian's flattened
// shape). It checks the site, user and token the gateway passes, and appends each call with the
// environment names it saw to FAKE_JIRA_LOG.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const tools = {
  jira_get_issue: {
    description: 'Get one Jira issue by key',
    inputSchema: { type: 'object', properties: { issue_key: { type: 'string' }, fields: { type: 'string' } }, required: ['issue_key'] },
    run: ({ issue_key }) => {
      if (env.FAKE_JIRA_LOG) appendFileSync(env.FAKE_JIRA_LOG, `${JSON.stringify({ issue_key, env: Object.keys(env).sort(), url: env.JIRA_URL, user: env.JIRA_USERNAME, read_only: env.READ_ONLY_MODE })}\n`);
      if (!env.JIRA_URL || !env.JIRA_USERNAME) throw new Error('JIRA_URL and JIRA_USERNAME are required');
      if (env.JIRA_API_TOKEN !== env.FAKE_JIRA_EXPECT_TOKEN) throw new Error('401 Unauthorized');
      const issue = JSON.parse(readFileSync(env.FAKE_JIRA_DATA, 'utf8'))[issue_key];
      if (!issue) throw new Error(`Issue ${issue_key} does not exist`);
      return JSON.stringify({ ...issue, url: `${env.JIRA_URL}/browse/${issue_key}` });
    },
  },
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined) return;
  if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-jira', version: '1.0.0' } } });
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
  if (method === 'tools/call') {
    const t = tools[params?.name];
    if (!t) return send({ id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${params?.name}` }] } });
    try {
      return send({ id, result: { content: [{ type: 'text', text: t.run(params.arguments ?? {}) }] } });
    } catch (e) {
      return send({ id, result: { isError: true, content: [{ type: 'text', text: String(e.message) }] } });
    }
  }
  send({ id, error: { code: -32601, message: `method not found: ${method}` } });
});
