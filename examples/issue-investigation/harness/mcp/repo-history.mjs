#!/usr/bin/env node
// repo-history: a dependency-free stdio MCP server for the issue investigator. It answers questions
// about the history of the checkout the step works in (AZHI_WORKSPACE): recent commits on a path,
// blame of a line range, commits that added or removed a string, and one commit's message and diff.
// Read-only: it runs `git log`, `git blame` and `git show` and nothing else.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const cwd = process.env.AZHI_WORKSPACE || process.cwd();
const MAX = 40_000;
const LOG_FORMAT = '--format=%h %ad %an%x09%s';

function git(args) {
  const out = execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.length > MAX ? `${out.slice(0, MAX)}\n[output truncated at ${MAX} characters]` : out;
}

function path(p) {
  if (typeof p !== 'string' || !p || p.startsWith('-') || p.startsWith('/') || p.includes('..')) throw new Error('path must be a repository-relative file path');
  return p;
}

function limit(n, dflt, max) {
  const v = n === undefined ? dflt : Number(n);
  if (!Number.isInteger(v) || v < 1) throw new Error('limit must be a positive integer');
  return Math.min(v, max);
}

const tools = {
  'recent-commits': {
    description: 'Recent commits, newest first, as "SHA DATE AUTHOR<TAB>SUBJECT". Give a path to see only commits that touched it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    run: (a) => git(['log', '--no-color', '--date=short', LOG_FORMAT, `-n${limit(a.limit, 20, 50)}`, ...(a.path !== undefined ? ['--', path(a.path)] : [])]).trim() || '(no commits)',
  },
  blame: {
    description: 'Which commit last changed each line of a file, for lines start..end (at most 200 lines).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } }, required: ['path', 'start', 'end'], additionalProperties: false },
    run: (a) => {
      const start = limit(a.start, 1, 1e7);
      const end = limit(a.end, start, 1e7);
      if (end < start || end - start >= 200) throw new Error('end must be at least start, and at most 200 lines after it');
      return git(['blame', '--date=short', `-L${start},${end}`, 'HEAD', '--', path(a.path)]).trim();
    },
  },
  'search-history': {
    description: 'Commits that added or removed a string (git log -S), newest first. Use it to find when a line or name appeared or disappeared.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 3, maxLength: 200 }, path: { type: 'string' } }, required: ['text'], additionalProperties: false },
    run: (a) => {
      if (typeof a.text !== 'string' || a.text.length < 3 || a.text.length > 200 || /[\0\n]/.test(a.text)) throw new Error('text must be 3 to 200 characters on one line');
      return git(['log', '--no-color', '--date=short', LOG_FORMAT, '-n20', `-S${a.text}`, ...(a.path !== undefined ? ['--', path(a.path)] : [])]).trim() || '(no commit added or removed that text)';
    },
  },
  'show-commit': {
    description: "One commit: its message, the files it changed and its diff (truncated when large).",
    inputSchema: { type: 'object', properties: { sha: { type: 'string' } }, required: ['sha'], additionalProperties: false },
    run: (a) => {
      if (typeof a.sha !== 'string' || !/^[0-9a-f]{4,40}$/.test(a.sha)) throw new Error('sha must be a commit SHA (4 to 40 hex characters)');
      return git(['show', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', '--patch', '--date=short', '--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B', a.sha, '--']);
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
  if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'repo-history', version: '1.0.0' } } });
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
