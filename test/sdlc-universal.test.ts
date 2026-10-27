import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';

/** SDLC universal (examples/sdlc-universal): Jira, GitHub and Confluence intake, provider-neutral models, language-neutral gate. */
const PKG = 'examples/sdlc-universal';
const pkg = packageFromDirectory(PKG);
const config = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8'));
const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;
const python = process.platform === 'win32' ? 'python' : 'python3';

describe('SDLC universal: definition', () => {
  it('compiles, and every write is behind a gate', () => {
    const r = compile(def, { pkg, catalog: staticCatalog(config.tools) });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    const writes = new Set(r.plan!.taint.paths.map((p) => p.write));
    for (const write of ['push_branch', 'open_pr']) expect(writes.has(write), write).toBe(true);
    expect(r.plan!.taint.paths.filter((p) => p.gate === null)).toEqual([]);
  });

  it('reads Jira and GitHub, and takes an optional Confluence page', () => {
    const ids = (def.nodes as Array<{ id: string }>).map((n) => n.id);
    for (const id of ['jira_issue', 'github_issue', 'normalize', 'confluence_gate', 'confluence_page', 'intake']) expect(ids).toContain(id);
    expect((def.inputs as any).properties.source.enum).toEqual(['jira', 'github']);
    expect((def.inputs as any).required).not.toContain('confluence_page');
    const tools = config.tools.map((t: { id: string }) => t.id);
    expect(tools).toEqual(expect.arrayContaining(['jira.get-issue', 'confluence.get-page', 'github.get-issue']));
  });

  it('names no repository-specific command and no hard-coded channel', () => {
    const text = pkg.readText(pkg.manifest.workflow)! + readFileSync(`${PKG}/azhi.config.yaml`, 'utf8');
    for (const word of ['vitest', 'AZHI_TEST_DATABASE_URL', 'build:web', 'C0C6LTYB0MQ']) expect(text).not.toContain(word);
  });

  it('keeps each test command within the 1000 character limit', () => {
    const out = JSON.parse(execFileSync('node', [`${PKG}/scripts/build_gate_commands.mjs`], { encoding: 'utf8' }));
    for (const c of Object.values(out) as string[]) expect(c.length).toBeLessThanOrEqual(1000);
    const used = readFileSync(`${PKG}/workflow.yaml`, 'utf8').replace(/\s*\n\s*/g, ' ');
    for (const c of Object.values(out) as string[]) expect(used).toContain(c);
  });
});

describe('SDLC universal: profiles', () => {
  it('has a tier on every profile, and each tier has a model for every provider', () => {
    const models = JSON.parse(readFileSync(`${PKG}/models.json`, 'utf8'));
    for (const f of readdirSync(`${PKG}/profiles`)) {
      const tier = /^# tier: (\w+)$/m.exec(readFileSync(`${PKG}/profiles/${f}`, 'utf8'))?.[1];
      expect(tier, f).toBeTruthy();
      for (const p of ['anthropic', 'github-copilot', 'openai-chatgpt']) expect(models[p][tier!], `${p} ${tier}`).toBeTruthy();
    }
  });
});

describe('SDLC universal: gate', () => {
  const full = JSON.parse(execFileSync('node', [`${PKG}/scripts/build_gate_commands.mjs`], { encoding: 'utf8' }));
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'gate-'));
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(d, f, '..'), { recursive: true });
      writeFileSync(join(d, f), c);
    }
    return d;
  };
  const run = (cwd: string, mode: 'full' | 'static') => {
    try {
      return { code: 0, out: execSync(full[mode], { cwd, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e: any) {
      return { code: e.status as number, out: String(e.stdout) };
    }
  };

  it('runs the repository\'s own test script', () => {
    const d = dir({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "console.log(\'RAN\')"' } }) });
    const r = run(d, 'full');
    expect(r.code).toBe(0);
    expect(r.out).toContain('RAN');
  });

  it('uses .azhi/commands.json over detection', () => {
    const d = dir({ '.azhi/commands.json': JSON.stringify({ test: 'node -e "console.log(\'CUSTOM\')"' }) });
    const r = run(d, 'full');
    expect(r.code).toBe(0);
    expect(r.out).toContain('CUSTOM');
  });

  it('fails clearly when no command is found, and static needs a type-check or build', () => {
    expect(run(dir({ 'README.md': 'x' }), 'full').code).toBe(1);
    const d = dir({ 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }) });
    const r = run(d, 'static');
    expect(r.code).toBe(1);
    expect(r.out).toContain('no static command');
  });
});

describe('SDLC universal: merge_context.py', () => {
  const merge = (input: unknown) => JSON.parse(execFileSync(python, [`${PKG}/scripts/merge_context.py`], { input: JSON.stringify(input), encoding: 'utf8' }));
  const ticket = { source: 'jira', key: 'PAY-1', title: 'T', description: 'Do it', priority: 'high', reporter: 'a', status: 'open', labels: ['x'], url: 'u' };

  it('passes the ticket through when there is no page', () => {
    expect(merge({ ticket, page: null })).toEqual(ticket);
  });

  it('appends the page, strips hidden characters and keeps only the nine fields', () => {
    const page = JSON.stringify({ metadata: { title: 'Spec', content: { value: 'Body​ text‮' } } });
    const out = merge({ ticket, page });
    expect(out.description).toBe('Do it\n\n## Linked Confluence context\n\n### Spec\n\nBody text');
    expect(Object.keys(out).sort()).toEqual(['description', 'key', 'labels', 'priority', 'reporter', 'source', 'status', 'title', 'url']);
  });

  it('trims the page first so the description stays within 20,000 characters', () => {
    const out = merge({ ticket, page: { title: 'Big', content: 'x'.repeat(50000) } });
    expect(out.description.length).toBeLessThanOrEqual(20000);
    expect(out.description.startsWith('Do it')).toBe(true);
    expect(out.description).toContain('[truncated');
  });
});

describe('portable .claude layer', () => {
  const skills = readdirSync('.claude/skills').filter((d) => d !== 'README.md');

  it('has valid frontmatter in every skill (OpenCode drops a skill whose frontmatter is not valid YAML)', () => {
    for (const s of skills) {
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(`.claude/skills/${s}/SKILL.md`, 'utf8'))?.[1];
      const meta = parse(front ?? '') as Record<string, unknown>;
      expect(meta.name, s).toBe(s);
      expect(['opus', 'sonnet', 'haiku'], s).toContain(meta.model);
      expect(typeof meta.description, s).toBe('string');
    }
  });

  it('names a model for every tier of every OpenCode provider', () => {
    const models = JSON.parse(readFileSync('.claude/models.json', 'utf8'));
    for (const p of ['openai', 'github-copilot', 'anthropic']) for (const t of ['strong', 'balanced', 'light']) expect(models[p][t], `${p} ${t}`).toMatch(/^[\w-]+\/[\w.-]+$/);
  });
});
