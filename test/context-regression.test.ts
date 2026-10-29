import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionFile } from '../src/definition/load.js';

/**
 * Workflows that do not use the context-sharing keys must keep compiling to the same plan, byte
 * for byte. The goldens were taken from the compiler before the feature; refresh them on purpose
 * only (`UPDATE_CONTEXT_GOLDEN=1 npx vitest run test/context-regression.test.ts`).
 */
const GOLDEN = 'test/golden/context-regression';

function workflows(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return workflows(p);
    return e.name === 'workflow.yaml' ? [p.split('\\').join('/')] : [];
  });
}

const files = [...workflows('examples'), ...workflows('test/fixtures')].sort();

describe('context-sharing regression baseline', () => {
  it('finds the packages it guards', () => {
    expect(files.length).toBeGreaterThanOrEqual(19);
  });

  for (const file of files) {
    it(`${file} compiles to the baseline plan`, () => {
      const loaded = loadDefinitionFile(file);
      const result = loaded.definition ? compile(loaded.definition) : { ok: false, diagnostics: loaded.diagnostics, plan: undefined };
      // The compiler is pure over the definition, so the same text gives the same JSON on any machine.
      const text = `${JSON.stringify({ ok: result.ok, diagnostics: result.diagnostics, plan: result.plan }, null, 2)}\n`;
      const golden = join(GOLDEN, `${file.replace(/\/workflow\.yaml$/, '').split('/').join('__')}.json`);
      if (process.env.UPDATE_CONTEXT_GOLDEN === '1') {
        mkdirSync(dirname(golden), { recursive: true });
        writeFileSync(golden, text);
      }
      expect(existsSync(golden), `${golden} is missing; take the baseline before changing the compiler`).toBe(true);
      expect(text).toBe(readFileSync(golden, 'utf8'));
    });
  }
});
