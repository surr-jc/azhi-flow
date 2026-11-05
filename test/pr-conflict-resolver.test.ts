import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { staticCatalog } from '../src/gateway/types.js';
import { loadExample } from '../src/api/examples.js';

/**
 * The PR conflict resolver example (examples/pr-conflict-resolver): it compiles against its own tool registrations,
 * the marketplace lists it, no agent step holds a write credential, and every write tool is guarded.
 */
const PKG = 'examples/pr-conflict-resolver';
const load = () => {
  const pkg = packageFromDirectory(PKG);
  const tools = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools;
  return { pkg, tools, result: compile(loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!, { pkg, catalog: staticCatalog(tools) }) };
};

describe('pr-conflict-resolver example', () => {
  it('compiles with no error', () => {
    const { result } = load();
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is listed by the marketplace with its steps and tools', () => {
    const e = loadExample('pr-conflict-resolver')!;
    expect(e.name).toBe('Pull request conflict resolver');
    expect(e.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['pr', 'merge_attempt', 'triage', 'resolve_1', 'compare_1', 'review_1', 'refute_1', 'resolve_2', 'finalize', 'release_approval', 'push_branch']));
    expect((e.config.tools ?? []).map((t) => t.id)).toEqual(['github.get-pull-request', 'github.push-branch', 'github.create-pull-request', 'github.comment-on-pr']);
  });

  it('keeps writes behind an approval and a guard, and every agent on a read-only token', () => {
    const wf = parse(readFileSync(`${PKG}/workflow.yaml`, 'utf8'));
    const nodes: any[] = wf.nodes;
    for (const n of nodes.filter((x) => x.type === 'agent')) expect(n.workspace.credential).toBe('github-read-token');
    const writes = nodes.filter((n) => n.type === 'tool' && /push-branch|create-pull-request|comment-on-pr/.test(n.tool));
    expect(writes.map((n) => n.id)).toEqual(['push_branch', 'open_pr', 'announce', 'give_up']);
    for (const n of writes) expect(String(n.guard)).toMatch(/args\.repo == inputs\.repo/);
    expect(nodes.find((n) => n.id === 'push_branch').depends_on).toEqual(['release_approval']);
    expect(nodes.find((n) => n.id === 'ship_gate').routes.ship).toEqual(['release_approval']);
  });
});
