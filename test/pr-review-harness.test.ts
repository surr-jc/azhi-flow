import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The PR review example's harness pieces that need no model: the repo-facts MCP server the reviewers use to
 * size a change and find what uses it, and the triage script that applies the verifier's severity.
 */
const PKG = 'examples/pr-review';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-repofacts-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main', '.');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'src/value.js'), 'export function toolValue(r) {\n  return r.structured;\n}\n// -- old note\n');
  writeFileSync(join(dir, 'scripts/read.py'), 'from x import toolValue\nkey = toolValue(r)\n');
  writeFileSync(join(dir, 'config.yaml'), 'min_confidence: 80\n');
  writeFileSync(join(dir, 'tools.yaml'), 'transport: {kind: mcp-stdio}\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/azhi/base', 'HEAD');
  writeFileSync(join(dir, 'src/value.js'), 'export function toolValue(r) {\n  const wrapped = r.meta === true;\n  return wrapped ? r.structured.result : r.structured;\n}\n');
  writeFileSync(join(dir, 'config.yaml'), 'min_confidence: 70\nlite_max_lines: 150\n');
  git('commit', '-qam', 'change');
  return dir;
}

/** Calls repo-facts tools over stdio, as OpenCode does, and returns each result's text (or its error). */
async function call(cwd: string, calls: Array<[string, Record<string, unknown>?]>): Promise<string[]> {
  const p = spawn('node', [join(PKG, 'harness/mcp/repo-facts.mjs')], { env: { ...process.env, AZHI_WORKSPACE: cwd }, stdio: ['pipe', 'pipe', 'inherit'] });
  const out: string[] = [];
  return new Promise((resolve) => {
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const l of lines) {
        const m = JSON.parse(l);
        out[m.id - 1] = `${m.result.isError ? 'ERROR ' : ''}${m.result.content[0].text}`;
        if (out.filter((x) => x !== undefined).length === calls.length) {
          p.kill();
          resolve(out);
        }
      }
    });
    calls.forEach(([name, args], i) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args ?? {} } })}\n`));
  });
}

const python = ['python3', 'python', 'py'].find((c) => spawnSync(c, ['--version']).status === 0);

describe('PR review harness: repo-facts', () => {
  it('sizes the change, names what it defines and finds every user of a name', async () => {
    const [stat, symbols, refs, scoped, none, kind] = await call(repo(), [
      ['diff-stat'],
      ['changed-symbols'],
      ['references', { name: 'toolValue' }],
      ['references', { name: 'toolValue', path: 'scripts' }],
      ['references', { name: 'nowhere_used' }],
      // A kebab-case value (the setting that selects a producer) leads to the config that uses it.
      ['references', { name: 'mcp-stdio' }],
    ]);
    expect(kind).toBe('tools.yaml:1:transport: {kind: mcp-stdio}');
    expect(stat).toContain('+2\t-2\tsrc/value.js');
    expect(stat).toMatch(/TOTAL\t2 file\(s\)\t\+4\t-3$/);
    // Names from code and, in config files only, keys; a removed "-- old note" line is not a file header.
    expect(symbols).toContain('src/value.js\ttoolValue, wrapped');
    expect(symbols).toContain('config.yaml\tmin_confidence, lite_max_lines');
    expect(symbols).not.toContain('old note');
    expect(refs!.split('\n').sort()).toEqual(['scripts/read.py:1:from x import toolValue', 'scripts/read.py:2:key = toolValue(r)', 'src/value.js:1:export function toolValue(r) {']);
    expect(scoped!.split('\n')).toHaveLength(2);
    expect(none).toBe('(no references to nowhere_used)');
  });

  it('refuses a name or path that could be read as an option or leave the checkout', async () => {
    const [flag, up] = await call(repo(), [
      ['references', { name: '--open-files-in-pager' }],
      ['references', { name: 'toolValue', path: '../outside' }],
    ]);
    expect(flag).toMatch(/^ERROR name must be an identifier/);
    expect(up).toMatch(/^ERROR path must be a repository-relative file path/);
  });
});

describe.skipIf(!python)('PR review harness: triage', () => {
  const triage = (input: unknown) => JSON.parse(execFileSync(python!, [join(PKG, 'scripts/triage.py')], { input: JSON.stringify(input) }).toString());
  const finding = { id: 'T1', severity: 'major', path: 'src/mcp.ts', line: 185, title: 'No test for the remote path', detail: 'd', scenario: 's' };

  it("keeps a confirmed finding at the verifier's severity, and records what the reviewer said", () => {
    const r = triage({ reviews: [{ reviewer: 'tests', summary: '', findings: [finding] }], checks: [{ id: 'T1', verdict: 'confirmed', confidence: 95, severity: 'minor', evidence: 'The shared helper is tested through stdio.' }], min_confidence: 80 });
    expect(r.reviews[0].findings[0]).toMatchObject({ severity: 'minor', reported_severity: 'major', confidence: 95 });
    expect(r.stats).toMatchObject({ found: 1, kept: 1 });
  });

  it("keeps the reviewer's severity when the verifier gives none or agrees", () => {
    const none = triage({ reviews: [{ reviewer: 'tests', summary: '', findings: [finding] }], checks: [{ id: 'T1', verdict: 'confirmed', confidence: 90, evidence: 'e' }], min_confidence: 80 });
    const same = triage({ reviews: [{ reviewer: 'tests', summary: '', findings: [finding] }], checks: [{ id: 'T1', verdict: 'confirmed', confidence: 90, severity: 'major', evidence: 'e' }], min_confidence: 80 });
    for (const r of [none, same]) {
      expect(r.reviews[0].findings[0].severity).toBe('major');
      expect(r.reviews[0].findings[0]).not.toHaveProperty('reported_severity');
    }
  });
});
