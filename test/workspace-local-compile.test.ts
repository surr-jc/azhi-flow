import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { runRepos } from '../src/server/repo-slots.js';

/** `workspace.local`: a named local folder instead of a repository to clone. The name is a literal, and nothing of a clone goes with it. */
const wf = (workspace: string, executor = 'opencode') => `
schema_version: "2.0"
id: local
nodes:
  - id: build
    type: agent
    executor: ${executor}
    profile: builder@1
    output_schema: {type: object, properties: {summary: {type: string}}}
    workspace:
${workspace}
`;

const codes = (text: string) => {
  const loaded = loadDefinitionText(text);
  expect(loaded.diagnostics).toEqual([]);
  const r = compile(loaded.definition!);
  return { ...r, codes: r.diagnostics.map((d) => `${d.severity}:${d.code}`) };
};

describe('workspace.local', () => {
  it('compiles with only a folder name, and says that the folder is not isolated', () => {
    const r = codes(wf('      local: shop\n      mode: write'));
    expect(r.ok).toBe(true);
    expect(r.codes.filter((c) => c.startsWith('error'))).toEqual([]);
    expect(r.codes).toContain('warning:workspace_local_folder');
  });

  it('takes a ref and a base ref', () => {
    const r = codes(wf('      local: shop\n      ref: main\n      base_ref: {ref: inputs.base}'));
    expect(r.codes.filter((c) => c.startsWith('error'))).toEqual([]);
  });

  it('cannot be combined with anything a clone needs', () => {
    for (const extra of ['repo: acme/shop', 'credential: read', 'host: https://ghe.example.com', 'depth: 1', 'merge_ref: refs/heads/main', 'from: {ref: nodes.other.output.workspace}']) {
      const r = codes(wf(`      local: shop\n      ref: HEAD\n      ${extra}`));
      expect(r.codes, extra).toContain('error:workspace_local');
    }
  });

  it('needs the OpenCode executor', () => {
    expect(codes(wf('      local: shop', 'claude-agent-sdk')).codes).toContain('error:workspace_unsupported');
  });

  it('is a literal name: a value, a path or an upper-case name is not accepted', () => {
    for (const local of ['{ref: inputs.folder}', 'C:/code/shop', '/home/me/shop', 'Shop', '../shop']) {
      expect(loadDefinitionText(wf(`      local: ${local}`)).diagnostics.length, local).toBeGreaterThan(0);
    }
  });

  it('still needs repo and ref when there is no local folder', () => {
    expect(loadDefinitionText(wf('      ref: HEAD')).diagnostics.length).toBeGreaterThan(0);
    expect(loadDefinitionText(wf('      repo: acme/shop')).diagnostics.length).toBeGreaterThan(0);
  });

  it('holds no per-repository slot', () => {
    expect(runRepos({ config: {}, nodes: [{ type: 'agent', def: { workspace: { local: 'shop' } } }] } as any, {})).toEqual([]);
  });
});
