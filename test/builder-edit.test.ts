import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapLocal } from '../src/api/auth.js';
import { applyChange, checkProposal, readWorkflow } from '../src/builder/builder.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { migrate } from '../src/db/migrate.js';
import { parse } from 'yaml';
import { registerTool } from '../src/server/catalog.js';
import { createContext } from '../src/server/context.js';
import { uploadPackage } from '../src/server/workflows.js';

/**
 * Changing an existing workflow with the builder chat: read_workflow loads the whole package (the
 * definition first, the harness skills, an index of anything not loaded), and a change sends only
 * the files that differ; every other file of the current version is kept.
 */
const dir = new URL('../examples/sdlc-universal/', import.meta.url).pathname;
const planner = 'profiles/planner@1.yaml';

describe('builder edits an existing workflow', () => {
  it('loads the whole package, and applies a change on top of the current version', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'azhi-builder-edit-'));
    const ctx = createContext({ databaseUrl: 'pglite://memory', dataDir });
    await migrate(ctx.pool);
    await bootstrapLocal(ctx);
    const ws = (await ctx.pool.query(`SELECT id FROM workspaces LIMIT 1`)).rows[0].id as string;
    for (const t of parse(readFileSync(`${dir}azhi.config.yaml`, 'utf8')).tools) await registerTool(ctx, ws, t, 'test');
    const pkg = packageFromDirectory(dir);
    const files = Object.fromEntries(pkg.manifest.files.map((f) => [f.path, pkg.read(f.path)!.toString('base64')]));
    const up = await uploadPackage(ctx, ws, { workflow: 'workflow.yaml', files }, 'test');
    expect(up.ok).toBe(true);

    const text = await readWorkflow(ctx, ws, 'sdlc-universal');
    // workflow.yaml is over 32 KB and must come first, before the profiles and the harness.
    expect(text.indexOf('=== workflow.yaml ===')).toBeGreaterThan(-1);
    expect(text.indexOf('=== workflow.yaml ===')).toBeLessThan(text.indexOf(`=== ${planner} ===`));
    expect(text).toContain('=== harness/skills/code-review/SKILL.md ===');
    expect(text).toContain('## Files');
    expect(text).not.toContain('size budget');
    expect(text.length).toBeLessThan(200_000);

    const changed = readFileSync(`${dir}${planner}`, 'utf8') + '# edited\n';
    const change = await applyChange(ctx, ws, 'sdlc-universal', { [planner]: changed }, ['profiles/preflight@1.yaml']);
    expect(change.ok).toBe(true);
    if (!change.ok) return;
    expect(change.files[planner]).toBe(changed);
    expect(change.files['workflow.yaml']).toBe(readFileSync(`${dir}workflow.yaml`, 'utf8'));
    expect(change.files['profiles/preflight@1.yaml']).toBeUndefined();
    expect(change.files['profiles/engineer@1.yaml']).toBeDefined();

    expect(await applyChange(ctx, ws, 'nope', {}, [])).toMatchObject({ ok: false });
    expect(await applyChange(ctx, ws, 'sdlc-universal', {}, ['workflow.yaml', 'missing.yaml'])).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining('missing.yaml')]) });

    // An existing id needs new_version_of; with it, the merged package is checked as a whole.
    const merged = change.files as Record<string, string>;
    expect(await checkProposal(ctx, ws, merged, undefined)).toMatchObject({ ok: false });
    const checked = await checkProposal(ctx, ws, merged, 'sdlc-universal');
    expect(JSON.stringify(checked)).not.toContain('already exists');
  }, 120_000);
});
