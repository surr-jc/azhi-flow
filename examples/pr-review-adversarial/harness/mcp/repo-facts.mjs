#!/usr/bin/env node
// repo-facts: a dependency-free stdio MCP server for the PR review agents. It answers questions
// about the checkout the step works in (AZHI_WORKSPACE): which files the pull request changes, the
// diff of one file and its size, against refs/azhi/base (the PR's base commit, fetched by the
// workspace), the names the change defines or edits, and where a name is used in the whole checkout.
// Read-only: it runs `git diff` and `git grep` and nothing else. A missing base or an empty diff is an
// error, never "(no changes)", so an agent cannot mistake a broken checkout for a pull request with
// nothing in it.
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
  } catch {
    throw new Error('no base commit in this checkout (refs/azhi/base is missing), so the pull request diff is unavailable');
  }
  const r = ['refs/azhi/base...HEAD'];
  if (!git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', ...r]).trim()) {
    throw new Error('the pull request shows no changes against its base (refs/azhi/base...HEAD is empty), so the diff is unavailable; do not review or guess the change');
  }
  return r;
}

const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
const MAX_REFS = 150;
// A name worth looking up: an identifier, kebab-case (a transport kind, a CLI flag's name), optionally dotted
// (config keys, object paths). Never starting with "-", so git cannot read it as an option.
const NAME = /^[A-Za-z_$][\w$-]*(\.[A-Za-z_$][\w$-]*)*$/;
// Lines that define a name, in the languages a pull request usually touches; config keys only in config files.
const DEFINES = [
  /\b(?:function\*?|class|interface|type|enum|def|func|fn|struct|trait|module)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/,
  /^\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{\s*$/,
];
const CONFIG_KEY = /^\s*(?:-\s+)?["']?([A-Za-z_][\w-]*)["']?\s*[:=]\s/;
const CONFIG_FILE = /\.(ya?ml|json|toml|ini|env)$/i;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else']);

function repoPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('-') || path.includes('..')) throw new Error('path must be a repository-relative file path');
  return path;
}

const tools = {
  'diff-stat': {
    description: 'Size of the pull request: added and deleted lines per changed file, and the totals. Read it first to plan the review.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => {
      const rows = git([...DIFF, '--numstat', ...range()]).trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
      const n = (v) => (v === '-' ? 0 : Number(v));
      const add = rows.reduce((s, r) => s + n(r[0]), 0);
      const del = rows.reduce((s, r) => s + n(r[1]), 0);
      return `${rows.map(([a, d, p]) => `+${a}\t-${d}\t${p}`).join('\n')}\nTOTAL\t${rows.length} file(s)\t+${add}\t-${del}`;
    },
  },
  'changed-symbols': {
    description: 'Names the pull request defines, changes or removes in each changed file (functions, classes, constants, config keys, and the function around each edited hunk). Look each one up with references to find what depends on it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => {
      const out = git([...DIFF, '-U0', ...range()]);
      const byFile = new Map();
      let file;
      let header = false;
      for (const line of out.split('\n')) {
        // A file starts at `diff --git`; its ---/+++ lines come before the first @@, so a removed line
        // that itself starts with "-- " is never taken for a header.
        const start = /^diff --git a\/.* b\/(.*)$/.exec(line);
        if (start) {
          file = start[1];
          header = true;
          byFile.set(file, new Set());
          continue;
        }
        if (!file || (header && !line.startsWith('@@'))) continue;
        header = false;
        const names = byFile.get(file);
        // git puts the enclosing function after the second @@ of a hunk header.
        const hunk = /^@@[^@]*@@\s*(.*)$/.exec(line);
        const text = hunk ? hunk[1] : /^[+-]/.test(line) ? line.slice(1) : '';
        for (const re of CONFIG_FILE.test(file) ? [...DEFINES, CONFIG_KEY] : DEFINES) {
          const m = re.exec(text);
          if (m && m[1].length > 1 && !KEYWORDS.has(m[1])) names.add(m[1]);
        }
      }
      const rows = [...byFile].filter(([, s]) => s.size).map(([f, s]) => `${f}\t${[...s].join(', ')}`);
      return rows.length ? rows.join('\n') : '(no named definitions in the changed lines; read the diffs instead)';
    },
  },
  references: {
    description: `Where a name is used anywhere in the checkout (code, tests, scripts, examples, config, docs), as PATH:LINE:TEXT, at most ${MAX_REFS} lines. The name is an identifier, a kebab-case value such as a transport kind (mcp-stdio), or a dotted key. Optional path limits the search to one file or folder.`,
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name'], additionalProperties: false },
    run: ({ name, path }) => {
      if (typeof name !== 'string' || name.length < 2 || name.length > 120 || !NAME.test(name)) throw new Error('name must be an identifier such as mcpToolValue or config.min_confidence');
      const args = ['grep', '-n', '-I', '-w', '-F', '-e', name, '--', ...(path === undefined ? [] : [repoPath(path)])];
      let out;
      try {
        out = git(args);
      } catch (e) {
        if (e.status === 1) return `(no references to ${name})`;
        throw e;
      }
      const lines = out.split('\n').filter(Boolean).map((l) => (l.length > 240 ? `${l.slice(0, 240)}…` : l));
      return lines.length > MAX_REFS ? `${lines.slice(0, MAX_REFS).join('\n')}\n[${lines.length - MAX_REFS} more; narrow with path]` : lines.join('\n');
    },
  },
  'changed-files': {
    description: 'Files the pull request changes, one per line as STATUS<TAB>PATH (A added, M modified, D deleted).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => git([...DIFF, '--name-status', ...range()]).trim(),
  },
  'file-diff': {
    description: 'The unified diff of one changed file (path relative to the repository root).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    run: ({ path }) => {
      const out = git([...DIFF, ...range(), '--', repoPath(path)]);
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
