#!/usr/bin/env node
// A stand-in for the Jira MCP server (mcp-atlassian) with the tools the issue splitter uses:
// jira_get_issue, jira_create_issue, jira_add_comment and jira_update_issue, for tests.
// Issues to read come from FAKE_JIRA_DATA (a JSON file of key -> issue). Writes go to FAKE_JIRA_STATE
// (a JSON file: issues, comments, updates). Reads need FAKE_JIRA_EXPECT_TOKEN, writes need
// FAKE_JIRA_EXPECT_WRITE_TOKEN and READ_ONLY_MODE not "true", as the real server behaves.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const state = () => (existsSync(env.FAKE_JIRA_STATE) ? JSON.parse(readFileSync(env.FAKE_JIRA_STATE, 'utf8')) : { issues: [], comments: [], updates: [] });
const save = (s) => writeFileSync(env.FAKE_JIRA_STATE, JSON.stringify(s));
const auth = (write) => {
  if (!env.JIRA_URL || !env.JIRA_USERNAME) throw new Error('JIRA_URL and JIRA_USERNAME are required');
  if (write && env.READ_ONLY_MODE === 'true') throw new Error('read-only mode: write tools are disabled');
  if (env.JIRA_API_TOKEN !== (write ? env.FAKE_JIRA_EXPECT_WRITE_TOKEN : env.FAKE_JIRA_EXPECT_TOKEN)) throw new Error('401 Unauthorized');
};
const obj = (props, required) => ({ type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])), required });
const tools = {
  jira_get_issue: {
    inputSchema: obj(['issue_key', 'fields'], ['issue_key']),
    run: ({ issue_key }) => {
      auth(false);
      const issue = JSON.parse(readFileSync(env.FAKE_JIRA_DATA, 'utf8'))[issue_key];
      if (!issue) throw new Error(`Issue ${issue_key} does not exist`);
      return JSON.stringify({ ...issue, url: `${env.JIRA_URL}/browse/${issue_key}` });
    },
  },
  jira_create_issue: {
    inputSchema: obj(['project_key', 'summary', 'issue_type', 'description', 'additional_fields'], ['project_key', 'summary', 'issue_type']),
    run: (a) => {
      auth(true);
      let extra = {};
      if (a.additional_fields) extra = JSON.parse(a.additional_fields);
      const s = state();
      const key = `${a.project_key}-${200 + s.issues.length}`;
      if (a.issue_type === 'Subtask' && !extra.parent) throw new Error('a Subtask needs a parent');
      s.issues.push({ key, summary: a.summary, issue_type: a.issue_type, description: a.description ?? '', parent: extra.parent ?? null, labels: extra.labels ?? [], project_key: a.project_key, write_token: env.JIRA_API_TOKEN });
      save(s);
      return JSON.stringify({ message: 'Issue created successfully', issue: { key, id: String(10000 + s.issues.length), summary: a.summary } });
    },
  },
  jira_add_comment: {
    inputSchema: obj(['issue_key', 'body'], ['issue_key', 'body']),
    run: (a) => {
      auth(true);
      const s = state();
      s.comments.push({ issue_key: a.issue_key, body: a.body });
      save(s);
      return JSON.stringify({ id: String(s.comments.length), body: a.body });
    },
  },
  jira_update_issue: {
    inputSchema: obj(['issue_key', 'fields', 'return_fields'], ['issue_key', 'fields']),
    run: (a) => {
      auth(true);
      const s = state();
      s.updates.push({ issue_key: a.issue_key, fields: JSON.parse(a.fields) });
      save(s);
      return JSON.stringify({ message: 'Issue updated successfully', issue: { key: a.issue_key } });
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
  if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-jira-write', version: '1.0.0' } } });
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: name, inputSchema: t.inputSchema })) } });
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
