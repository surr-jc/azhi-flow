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

  it('runs the merge, the base snapshot and the head snapshot one after another, and triage after all three', () => {
    const { result } = load();
    const deps = (id: string) => result.plan!.nodes.find((n) => n.id === id)!.deps;
    expect(deps('merge_attempt')).toContain('eligible');
    expect(deps('base_run')).toEqual(expect.arrayContaining(['merge_attempt']));
    expect(deps('head_run')).toEqual(expect.arrayContaining(['base_run']));
    expect(deps('triage')).toEqual(expect.arrayContaining(['merge_attempt', 'head_run']));
    // On the skip route all three are skipped with merge_attempt; only the report runs.
    const wf = parse(readFileSync(`${PKG}/workflow.yaml`, 'utf8'));
    expect(wf.nodes.find((n: any) => n.id === 'eligible').routes).toEqual({ ok: ['merge_attempt'], skip: ['skip_report'] });
  });

  it('requires evidence for the prompt injection flag in both agent reports', () => {
    for (const name of ['review', 'resolution']) {
      const schema = JSON.parse(readFileSync(`${PKG}/schemas/${name}.json`, 'utf8'));
      expect(schema.required).toEqual(expect.arrayContaining(['prompt_injection_detected', 'prompt_injection_evidence']));
      const ev = schema.properties.prompt_injection_evidence;
      expect(ev).toMatchObject({ type: 'array', maxItems: 5 });
      expect(ev.items).toMatchObject({ type: 'object', required: ['where', 'text'], additionalProperties: false });
      expect(ev.items.properties.text.maxLength).toBe(500);
      expect(JSON.stringify(schema)).not.toMatch(/"(if|then|else|oneOf|anyOf|allOf)"/);
    }
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

  it('shows the approver the resolution that would ship, whichever attempt made it', () => {
    const wf = parse(readFileSync(`${PKG}/workflow.yaml`, 'utf8'));
    const payload = String((wf.nodes as any[]).find((n) => n.id === 'release_approval').payload.map);
    expect(payload).toContain("'diff': nodes.finalize.output.diff");
    expect(payload).toContain("'diff_truncated': nodes.finalize.output.diff_truncated");
    // A step that reads one attempt shows it even when another ships, and is skipped when that attempt did not run.
    expect(payload).not.toMatch(/nodes\.(resolve|compare|review|refute)_\d/);
  });

  it('pushes the resolution as a merge of the base tip and the head the merge was made from', () => {
    const wf = parse(readFileSync(`${PKG}/workflow.yaml`, 'utf8'));
    const push = (wf.nodes as any[]).find((n) => n.id === 'push_branch');
    expect(push.arguments.merge_parent).toEqual({ ref: 'nodes.triage.output.pr.head_sha' });
    expect(push.arguments.base_sha).toEqual({ ref: 'nodes.finalize.output.base_sha' });
    expect(String(push.guard)).toContain('args.merge_parent == nodes.triage.output.pr.head_sha');
    expect(String(push.guard)).toContain('args.base_sha == nodes.triage.output.pr.base_tip');
    // The tool registration accepts the argument, and triage takes head_sha from the merge it made.
    const tool = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools.find((t: any) => t.id === 'github.push-branch');
    expect(tool.input_schema.properties.merge_parent).toEqual({ type: 'string' });
    expect(tool.input_schema.required).not.toContain('merge_parent');
    expect(readFileSync(`${PKG}/scripts/triage.py`, 'utf8')).toMatch(/"head_sha": merge\.get\("head_sha"/);
  });
});
