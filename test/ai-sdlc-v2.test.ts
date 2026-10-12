import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';

/** AI-SDLC v2 (examples/ai-sdlc-v2), the delivery workflow the marketplace offers: definition checks. */
const PKG = 'examples/ai-sdlc-v2';
const pkg = packageFromDirectory(PKG);
const tools = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools;
const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;

describe('AI-SDLC v2 example: definition', () => {
  it('compiles, and every write is behind a gate', () => {
    const r = compile(def, { pkg, catalog: staticCatalog(tools) });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    const writes = new Set(r.plan!.taint.paths.map((p) => p.write));
    for (const write of ['push_branch', 'open_pr']) expect(writes.has(write), write).toBe(true);
    expect(r.plan!.taint.paths.filter((p) => p.gate === null)).toEqual([]);
  });
});
