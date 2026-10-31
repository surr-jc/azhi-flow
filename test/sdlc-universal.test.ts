import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
// The Jira tools are registered in the workspace (a gateway connection), not defined by this example; stand-ins let it compile.
const jiraCcp = ['jira-ccp_get_issue', 'jira-ccp_jira_search'].map((id) => ({ id, version: 1, description: id, effect: 'read', source: 'jira-ccp', input_schema: { type: 'object', properties: { issue_key: { type: 'string' }, include_all_fields: { type: 'boolean' }, fields: { type: 'array', items: { type: 'string' } } } }, output_schema: { type: 'object' }, transport: { kind: 'mcp-streamable-http', connection: 'jira-ccp', tool: id.replace('jira-ccp_', '') } }));
const python = process.platform === 'win32' ? 'python' : 'python3';

describe('SDLC universal: definition', () => {
  it('compiles, and every write is behind a gate', () => {
    const r = compile(def, { pkg, catalog: staticCatalog([...config.tools, ...jiraCcp] as never) });
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
    expect(tools).toEqual(expect.arrayContaining(['confluence.get-page', 'github.get-issue']));
    expect(tools).not.toContain('jira.get-issue');
    const jira = (def.nodes as Array<{ id: string; tool?: string; arguments?: Record<string, unknown> }>).find((n) => n.id === 'jira_issue')!;
    expect(jira.tool).toBe('jira-ccp_get_issue@1');
    // Without this the tool returns a trimmed field set that has no description.
    expect(jira.arguments!.include_all_fields).toBe(true);
  });

  it('names no repository-specific command and no hard-coded channel', () => {
    const text = pkg.readText(pkg.manifest.workflow)! + readFileSync(`${PKG}/azhi.config.yaml`, 'utf8');
    for (const word of ['vitest', 'AZHI_TEST_DATABASE_URL', 'build:web', 'C0C6LTYB0MQ']) expect(text).not.toContain(word);
  });

  it('asks for a typed acknowledgement at release, and pushes or opens nothing unless finalize said ship', () => {
    const nodes = Object.fromEntries(def.nodes.map((n: any) => [n.id, n]));
    expect(nodes.release_approval.decision_schema.required).toEqual(['acknowledged']);
    expect(nodes.release_approval.on_expiry).toBe('reject');
    for (const id of ['push_branch', 'open_pr']) expect(nodes[id].guard, id).toContain('nodes.finalize.output.ship');
  });

  it('audits every criterion rated met, in a fix-round-triggering way, and feeds finalize the audit of each round', () => {
    const nodes = Object.fromEntries(def.nodes.map((n: any) => [n.id, n]));
    for (const n of [1, 2]) {
      expect(nodes[`lite_audit_${n}`].profile).toBe('criteria-auditor@1');
      expect(nodes[`lite_audit_${n}`].output_schema).toBe('schemas/audit.json');
    }
    expect(nodes.lite_gate_1.expression).toContain("nodes.lite_audit_1.output.checks.exists(c, c.verdict == 'counterexample'");
    expect(JSON.stringify(nodes.finalize.input)).toContain('lite_audit_2.output.checks');
    for (const id of ['lite_fix', 'lite_fix_untested', 'lite_fix_static']) expect(JSON.stringify(nodes[id].input), id).toContain("'audit': nodes.lite_audit_1");
  });

  it('keeps each test command within the 8000 character limit (cmd.exe stops at 8191)', () => {
    const out = JSON.parse(execFileSync('node', [`${PKG}/scripts/build_gate_commands.mjs`], { encoding: 'utf8' }));
    for (const c of Object.values(out) as string[]) expect(c.length).toBeLessThanOrEqual(8000);
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

  /** What the gate would run, without running it. */
  const plan = (cwd: string, mode: 'full' | 'static' = 'full') => {
    const out = execSync(`${full[mode]} plan`, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return (JSON.parse(out) as { projects: Array<{ dir: string; stack: string; commands: string[] }> }).projects;
  };
  const dirs = (cwd: string, mode: 'full' | 'static' = 'full') => plan(cwd, mode).map((p) => `${p.dir.replace(/\\/g, '/')}:${p.stack}`).sort();

  it('finds every project of a repository with several stacks in subfolders, as the failing recovery-link repository was', () => {
    const d = dir({
      'backend/pom.xml': '<project/>',
      'backend/src/test/java/AppTest.java': '',
      'frontend/package.json': JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } }),
      'frontend-react/package.json': JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } }),
      'frontend-react/pnpm-lock.yaml': '',
      'mcp-server/pyproject.toml': '[project]\nname = "x"\n',
      'mcp-server/tests/test_a.py': '',
      'README.md': 'x',
    });
    expect(dirs(d)).toEqual(['backend:java/maven', 'frontend-react:node/pnpm', 'frontend:node/npm', 'mcp-server:python']);
    const maven = plan(d).find((p) => p.stack === 'java/maven')!;
    expect(maven.commands).toContain('mvn -B test');
    expect(plan(d, 'static').find((p) => p.stack === 'java/maven')!.commands).toEqual(['mvn -B -q compile', 'mvn -B -q -DskipTests package']);
  });

  it('detects the other build systems at the root', () => {
    const cases: Array<[Record<string, string>, string, string]> = [
      [{ 'build.gradle.kts': '' }, 'jvm/gradle', 'gradle test'],
      [{ 'App.csproj': '' }, 'dotnet', 'dotnet test --no-restore'],
      [{ 'go.mod': 'module x' }, 'go', 'go test ./...'],
      [{ 'Cargo.toml': '' }, 'rust', 'cargo test'],
      [{ Gemfile: '', Rakefile: '' }, 'ruby', 'bundle exec rake test'],
      [{ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }) }, 'php', 'composer test'],
      [{ 'mix.exs': '' }, 'elixir', 'mix test'],
      [{ Makefile: 'test:\n\techo ok\n' }, 'make', 'make test'],
      [{ 'pyproject.toml': '', 'uv.lock': '', tests: '' }, 'python', 'uv run pytest -q'],
    ];
    for (const [files, stack, test] of cases) {
      const p = plan(dir(files))[0];
      expect(p?.stack, stack).toBe(stack);
      expect(p?.commands, stack).toContain(test);
    }
  });

  it('uses the wrapper script of a Maven or Gradle project when it has one, and ignores the npm placeholder test', () => {
    const wrapped = plan(dir({ 'pom.xml': '', mvnw: '' }))[0]!;
    expect(wrapped.commands.some((c) => /mvnw/.test(c))).toBe(true);
    const placeholder = dir({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    expect(run(placeholder, 'full').out).toContain('no full command');
  });

  it('does not descend into build output, dependencies or hidden folders', () => {
    const d = dir({ 'node_modules/x/package.json': JSON.stringify({ scripts: { test: 'x' } }), '.cache/go.mod': '', 'target/pom.xml': '', 'svc/go.mod': 'module x' });
    expect(plan(d).map((p) => p.stack)).toEqual(['go']);
  });

  it('keeps going to a nested project when the root only has tooling', () => {
    const d = dir({ 'package.json': JSON.stringify({ scripts: { prepare: 'husky' } }), 'api/go.mod': 'module x' });
    expect(plan(d).map((p) => p.stack)).toEqual(['go']);
  });

  it('runs each project from its own folder and fails when any project fails, after running the rest', () => {
    const ok = `node -e "require('fs').writeFileSync('ran.txt','1')"`;
    const bad = `node -e "process.exit(3)"`;
    const d = dir({ '.azhi/commands.json': JSON.stringify({ projects: [{ dir: 'a', test: ok }, { dir: 'b', test: bad }, { dir: 'c', test: ok }] }), 'a/x': '', 'b/x': '', 'c/x': '' });
    const r = run(d, 'full');
    expect(r.code).toBe(1);
    expect(r.out).toContain('AZHI_GATE full failed: b test');
    expect(existsSync(join(d, 'a', 'ran.txt'))).toBe(true);
    expect(existsSync(join(d, 'c', 'ran.txt'))).toBe(true);
    expect(existsSync(join(d, 'ran.txt'))).toBe(false);
    const good = dir({ '.azhi/commands.json': JSON.stringify({ projects: [{ dir: 'a', test: ok }] }), 'a/x': '' });
    const g = run(good, 'full');
    expect(g.code).toBe(0);
    expect(g.out).toContain('AZHI_GATE full passed (1 project(s))');
  });

  it('refuses a configured folder outside the checkout', () => {
    const d = dir({ '.azhi/commands.json': JSON.stringify({ projects: [{ dir: '..', test: 'node -e 0' }, { dir: '/tmp', test: 'node -e 0' }] }) });
    expect(run(d, 'full').out).toContain('no full command');
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
