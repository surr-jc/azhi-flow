#!/usr/bin/env node
// repo-facts: a dependency-free stdio MCP server for the PR review agents. It answers questions
// about the checkout the step works in (AZHI_WORKSPACE): which files the pull request changes and
// the diff of one file, against refs/azhi/base (the PR's base branch, fetched by the workspace).
// Read-only: it runs `git diff` and nothing else.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const cwd = process.env.AZHI_WORKSPACE || process.cwd();
const MAX = 40_000;

function git(args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

function range() {
  try {
    git(['rev-parse', '--verify', '-q', 'refs/azhi/base']);
    return ['refs/azhi/base...HEAD'];
  } catch {
    return ['HEAD~1', 'HEAD'];
  }
}

const tools = {
  'changed-files': {
    description: 'Files the pull request changes, one per line as STATUS<TAB>PATH (A added, M modified, D deleted).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', ...range()]).trim() || '(no changes)',
  },
  'file-diff': {
    description: 'The unified diff of one changed file (path relative to the repository root).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    run: ({ path }) => {
      if (typeof path !== 'string' || !path || path.startsWith('-') || path.includes('..')) throw new Error('path must be a repository-relative file path');
      const out = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...range(), '--', path]);
      return out.length > MAX ? `${out.slice(0, MAX)}\n[diff truncated at ${MAX} characters]` : out || '(no diff for this path)';
    },
  },
};

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined) return; // notifications
  if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'repo-facts', version: '1.0.0' } } });
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
  if (method === 'tools/call') {
    const t = tools[params?.name];
    if (!t) return send({ id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${params?.name}` }] } });
    try {
      return send({ id, result: { content: [{ type: 'text', text: t.run(params.arguments ?? {}) }] } });
    } catch (e) {
      return send({ id, result: { isError: true, content: [{ type: 'text', text: String(e.stderr || e.message).slice(0, 2000) }] } });
    }
  }
  send({ id, error: { code: -32601, message: `method not found: ${method}` } });
});
