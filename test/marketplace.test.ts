import { beforeEach, describe, expect, it } from 'vitest';
import { harnessGuides, renderClaudeCode, validateAsset } from '../src/server/assets.js';
import { BUILTIN_SOURCES, clearMarketplaceCache, locate, normaliseAgent, normaliseCommand, normaliseSkill, registryServerToItem, resolve, search, sourcesFor, splitFrontmatter, type MarketDeps } from '../src/server/marketplace.js';

const json = (o: unknown) => JSON.stringify(o);
function deps(routes: Record<string, string | number>): MarketDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    now: () => 1_700_000_000_000,
    fetch: (async (url: string) => {
      calls.push(url);
      const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
      if (!hit) return new Response('not found', { status: 404 });
      if (typeof hit[1] === 'number') return new Response('nope', { status: hit[1] });
      return new Response(hit[1], { status: 200 });
    }) as unknown as typeof fetch,
  };
}

beforeEach(() => clearMarketplaceCache());

describe('MCP Registry servers become portable MCP definitions', () => {
  it('maps a hosted server with a secret header to a remote definition and a need', () => {
    const r = registryServerToItem({ name: 'ai.smithery/obsidian', description: 'Vault', version: '0.4.0', remotes: [{ type: 'streamable-http', url: 'https://server.smithery.ai/obsidian/mcp', headers: [{ name: 'Authorization', value: 'Bearer {smithery_api_key}', isSecret: true, isRequired: true }] }] });
    expect(r.definition).toEqual({ transport: 'remote', url: 'https://server.smithery.ai/obsidian/mcp', headers: { Authorization: 'Bearer {env:SMITHERY_API_KEY}' }, enabled: true });
    expect(r.needs).toEqual([expect.objectContaining({ name: 'SMITHERY_API_KEY', secret: true })]);
    expect(r.item.runs_code).toBeUndefined();
    expect(validateAsset('mcp', r.item.slug, r.definition!)).toEqual([]);
  });

  it('maps an npm package to an npx command and flags that it runs code on a worker', () => {
    const r = registryServerToItem({ name: 'io.example/gcs', version: '0.1.5', packages: [{ registryType: 'npm', identifier: 'gcs-mcp', version: '0.1.5', transport: { type: 'stdio' }, runtimeArguments: [{ type: 'positional', value: '-y' }], environmentVariables: [{ name: 'GCS_BUCKET', isRequired: true }, { name: 'GCS_PRIVATE_KEY', isSecret: true }] }] });
    expect(r.definition).toMatchObject({ transport: 'local', command: ['npx', '-y', 'gcs-mcp@0.1.5'], environment: { GCS_BUCKET: '{env:GCS_BUCKET}', GCS_PRIVATE_KEY: '{env:GCS_PRIVATE_KEY}' } });
    expect(r.item.runs_code).toBe(true);
    expect(r.needs.map((n) => [n.name, n.secret, n.required])).toEqual([['GCS_BUCKET', false, true], ['GCS_PRIVATE_KEY', true, false]]);
    expect(r.warnings.join(' ')).toContain('Runs a program on a worker');
  });

  it('maps a container package, turning variables in its arguments into environment placeholders', () => {
    const r = registryServerToItem({ name: 'io.github.github/github-mcp-server', version: '2.0.2', packages: [{ registryType: 'oci', identifier: 'ghcr.io/github/github-mcp-server:2.0.2', transport: { type: 'stdio' }, runtimeArguments: [{ type: 'named', name: '-e', value: 'GITHUB_PERSONAL_ACCESS_TOKEN={token}', variables: { token: { isSecret: true } } }] }] });
    expect(r.definition!.command).toEqual(['docker', 'run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN={env:TOKEN}', 'ghcr.io/github/github-mcp-server:2.0.2']);
    expect(r.needs[0]).toMatchObject({ name: 'TOKEN', secret: true });
  });

  it('prefers a hosted URL over a package, and refuses what it cannot run', () => {
    const both = registryServerToItem({ name: 'a/b', remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp' }], packages: [{ registryType: 'npm', identifier: 'b', version: '1', transport: { type: 'stdio' } }] });
    expect(both.definition!.transport).toBe('remote');
    const none = registryServerToItem({ name: 'a/c', packages: [{ registryType: 'nuget', identifier: 'c', version: '1', transport: { type: 'stdio' } }] });
    expect(none.definition).toBeUndefined();
    expect(none.item.unsupported).toMatch(/npm, PyPI or Docker/);
  });
});

describe('agents, skills and commands from Markdown', () => {
  it('reads front matter and keeps the body as the prompt, saying what it does not carry over', () => {
    const a = normaliseAgent('---\nname: code-reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: sonnet\n---\nYou review code.', 'x');
    expect(a).toMatchObject({ name: 'code-reviewer', slug: 'code-reviewer', definition: { description: 'Reviews diffs', mode: 'subagent', prompt: 'You review code.' } });
    expect(a.warnings.join(' ')).toMatch(/tools/);
    expect(a.warnings.join(' ')).toMatch(/model/);
    expect(validateAsset('agent', a.slug, a.definition)).toEqual([]);
  });
  it('warns when a skill points at bundled files that are not imported', () => {
    const s = normaliseSkill('---\nname: pdf\ndescription: Work with PDFs\nlicense: Proprietary\n---\nRun scripts/extract.py first.', 'pdf');
    expect(s.definition).toMatchObject({ instructions: 'Run scripts/extract.py first.', license: 'Proprietary' });
    expect(s.warnings.join(' ')).toMatch(/bundled files/);
  });
  it('turns a command into a template', () => {
    const c = normaliseCommand('---\ndescription: Review a PR\nargument-hint: <pr>\n---\nReview $ARGUMENTS.', 'review-pr');
    expect(c.definition).toEqual({ description: 'Review a PR', template: 'Review $ARGUMENTS.' });
  });
  it('tolerates a file with no front matter', () => {
    expect(splitFrontmatter('Just text')).toEqual({ data: {}, body: 'Just text' });
  });
});

describe('GitHub plugin marketplaces', () => {
  const plugins = [
    { name: 'document-skills', description: 'Office documents', source: './', skills: ['./skills/pdf', './skills/docx'] },
    { name: 'devtools', description: 'Developer helpers', source: './plugins/devtools', category: 'dev' },
    { name: 'elsewhere', description: 'Lives in another repo', source: { source: 'github', repo: 'a/b' } },
    { name: 'amd', description: 'Skills elsewhere', source: { source: 'git-subdir', url: 'https://github.com/amd/skills.git', path: 'skills', ref: 'main', sha: 'abc123' }, skills: ['./local-ai'] },
  ];
  const tree = ['plugins/devtools/agents/debugger.md', 'plugins/devtools/commands/fix/bug.md', 'plugins/devtools/skills/tracing/SKILL.md', 'plugins/devtools/skills/tracing/references/notes.md', 'README.md'];

  it('finds explicit entries, and walks a plugin folder from the repository tree', () => {
    const { found, unlisted } = locate(plugins as any, tree);
    expect(found.map((f) => `${f.kind}:${f.path}`)).toEqual(['skill:skills/pdf/SKILL.md', 'skill:skills/docx/SKILL.md', 'agent:plugins/devtools/agents/debugger.md', 'command:plugins/devtools/commands/fix/bug.md', 'skill:plugins/devtools/skills/tracing/SKILL.md', 'skill:skills/local-ai/SKILL.md']);
    expect(found.at(-1)).toMatchObject({ repo: 'amd/skills', ref: 'abc123' });
    expect(unlisted).toEqual([]);
  });
  it('says which plugins it could not list when the tree is unavailable', () => {
    const { found, unlisted } = locate(plugins as any, undefined);
    expect(found).toHaveLength(3);
    expect(unlisted).toEqual(['devtools']);
  });

  const routes = {
    'https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json': json({ plugins: plugins.slice(0, 1) }),
    'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md': '---\nname: pdf\ndescription: Work with PDFs\n---\nUse pypdf.',
    'https://registry.modelcontextprotocol.io/v0.1/servers?': json({ servers: [{ server: { name: 'io.example/docs', description: 'Docs search', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://docs.example/mcp' }] }, _meta: {} }], metadata: { nextCursor: 'io.example/docs:1.0.0' } }),
    'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fdocs/versions/latest': json({ server: { name: 'io.example/docs', description: 'Docs search', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://docs.example/mcp' }] } }),
  };
  const sources = BUILTIN_SOURCES.filter((s) => ['mcp-registry', 'gh:anthropics/skills'].includes(s.id));

  it('searches skills by words in the name or description, case-insensitively', async () => {
    const r = await search(deps(routes), sources, { kind: 'skill', q: 'PDF' });
    expect(r.items.map((i) => i.name)).toEqual(['pdf']);
    expect(r.items[0]).toMatchObject({ source: 'gh:anthropics/skills', kind: 'skill', group: 'document-skills', id: 'gh:anthropics/skills::skill::skills/pdf/SKILL.md' });
    expect(r.warnings).toEqual([]);
  });
  it('pages the registry with its own cursor and passes the search words on', async () => {
    const d = deps(routes);
    const r = await search(d, sources, { kind: 'mcp', q: 'docs' });
    expect(r.items.map((i) => i.id)).toEqual(['mcp-registry::io.example/docs']);
    expect(r.next_cursor).toBe('io.example/docs:1.0.0');
    expect(d.calls[0]).toContain('search=docs');
  });
  it('reports a source that cannot be reached without failing the others', async () => {
    const r = await search(deps({ 'https://registry.modelcontextprotocol.io/v0.1/servers?': 503, 'https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json': json({ plugins }) }), sources, { kind: 'skill', q: '' });
    expect(r.items).toHaveLength(3);
    const mcp = await search(deps({ 'https://registry.modelcontextprotocol.io/v0.1/servers?': 503 }), sources, { kind: 'mcp', q: '' });
    expect(mcp.items).toEqual([]);
    expect(mcp.warnings[0]).toMatchObject({ source: 'mcp-registry' });
  });
  it('resolves an item to a definition with its source and a content hash, and never reads other hosts', async () => {
    const d = deps(routes);
    const r = await resolve(d, sources, 'gh:anthropics/skills::skill::skills/pdf/SKILL.md');
    expect(r.definition).toMatchObject({ description: 'Work with PDFs', instructions: 'Use pypdf.' });
    expect(r.provenance).toMatchObject({ source: 'gh:anthropics/skills::skill::skills/pdf/SKILL.md', url: 'https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md', fetched_at: '2023-11-14T22:13:20.000Z' });
    expect(r.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    const mcp = await resolve(d, sources, 'mcp-registry::io.example/docs');
    expect(mcp.definition).toMatchObject({ transport: 'remote', url: 'https://docs.example/mcp' });
    const ext = await resolve(deps({ 'https://raw.githubusercontent.com/amd/skills/abc123/skills/local-ai/SKILL.md': '---\nname: local-ai\n---\nRun locally.' }), sources, 'gh:anthropics/skills::skill::ext:amd/skills@abc123:skills/local-ai/SKILL.md');
    expect(ext.provenance.url).toBe('https://github.com/amd/skills/blob/abc123/skills/local-ai/SKILL.md');
    await expect(resolve(d, sources, 'gh:anthropics/skills::skill::ext:../x@main:y/SKILL.md')).rejects.toThrow(/unknown marketplace item/);
    await expect(resolve(d, sources, 'gh:anthropics/skills::skill::../../etc/passwd')).rejects.toThrow(/unknown marketplace item/);
    await expect(resolve(d, sources, 'gh:evil/repo::skill::x/SKILL.md')).rejects.toThrow(/not enabled/);
  });
  it('lets an admin add a repository, but only with a valid owner/name', () => {
    const all = sourcesFor({ enabled: true, sources: [{ repo: 'acme/agents', ref: 'main' }, { repo: 'not a repo', ref: 'main' }, { repo: 'anthropics/skills', ref: 'main' }] });
    expect(all.map((s) => s.id)).toContain('gh:acme/agents');
    expect(all.filter((s) => s.id === 'gh:anthropics/skills')).toHaveLength(1);
    expect(all.map((s) => s.id)).not.toContain('gh:not a repo');
  });
});

describe('exports for Claude Code', () => {
  it('writes .mcp.json and .claude files with environment references in Claude syntax', () => {
    const files = renderClaudeCode([
      { kind: 'mcp', slug: 'docs', definition: { transport: 'remote', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer {env:DOCS_KEY}' } } },
      { kind: 'mcp', slug: 'files', definition: { transport: 'local', command: ['npx', '-y', 'files-mcp@1'], environment: { ROOT: '{env:FILES_ROOT}' } } },
      { kind: 'agent', slug: 'reviewer', definition: { description: 'Reviews', prompt: 'Review.' } },
      { kind: 'skill', slug: 'pdf', definition: { description: 'PDFs', instructions: 'Use pypdf.' } },
      { kind: 'command', slug: 'ship', definition: { description: 'Ship', template: 'Ship $ARGUMENTS' } },
    ]);
    expect(JSON.parse(files['.mcp.json']!)).toEqual({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer ${DOCS_KEY}' } }, files: { command: 'npx', args: ['-y', 'files-mcp@1'], env: { ROOT: '${FILES_ROOT}' } } } });
    expect(files['.claude/agents/reviewer.md']).toContain('name: reviewer');
    expect(files['.claude/skills/pdf/SKILL.md']).toContain('Use pypdf.');
    expect(files['.claude/commands/ship.md']).toContain('Ship $ARGUMENTS');
  });
  it('gives per-harness steps, including the one-line claude mcp add command', () => {
    const g = harnessGuides({ kind: 'mcp', slug: 'docs', definition: { transport: 'remote', url: 'https://docs.example/mcp' } });
    expect(g.map((x) => x.harness)).toEqual(['opencode', 'claude-code']);
    expect(g[1]!.steps.join(' ')).toContain('claude mcp add --transport http docs https://docs.example/mcp');
    expect(Object.keys(g[0]!.files)).toContain('opencode.jsonc');
  });
});
