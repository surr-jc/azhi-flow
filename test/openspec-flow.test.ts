import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';
import { loadExample } from '../src/api/examples.js';

/** OpenSpec flow (examples/openspec-flow), the spec-driven delivery workflow: definition checks. */
const PKG = 'examples/openspec-flow';
const pkg = packageFromDirectory(PKG);
const tools = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools;
const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;

describe('OpenSpec flow example: definition', () => {
  it('compiles, and every write is behind a gate', () => {
    const r = compile(def, { pkg, catalog: staticCatalog(tools) });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    const writes = new Set(r.plan!.taint.paths.map((p) => p.write));
    for (const write of ['push_branch', 'open_pr']) expect(writes.has(write), write).toBe(true);
    expect(r.plan!.taint.paths.filter((p) => p.gate === null)).toEqual([]);
  });

  it('puts both approvals before the build and before the archive', () => {
    const byId = new Map(def.nodes.map((n) => [n.id, n as any]));
    expect(byId.get('proposal_approval').type).toBe('approval');
    expect(byId.get('apply').depends_on).toContain('proposal_approval');
    expect(byId.get('release_approval').type).toBe('approval');
    expect(byId.get('archive').depends_on).toContain('release_approval');
    expect(byId.get('push_branch').depends_on).toContain('release_approval');
  });

  it('is offered by the examples API and lets no agent hold a write credential', () => {
    const example = loadExample('openspec-flow');
    expect(example?.workflow.id).toBe('openspec-flow');
    for (const n of def.nodes) if (n.type === 'agent') expect(JSON.stringify(n)).not.toContain('github-write-token');
  });

  it('ships SKILL.md, LICENSE and SOURCE.md for every skill', () => {
    const dir = `${PKG}/harness/skills`;
    const skills = readdirSync(dir);
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) for (const f of ['SKILL.md', 'LICENSE', 'SOURCE.md']) expect(existsSync(`${dir}/${s}/${f}`), `${s}/${f}`).toBe(true);
  });
});
