import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapLocal } from '../src/api/auth.js';
import { checkProposal, contextNotes } from '../src/builder/builder.js';
import { migrate } from '../src/db/migrate.js';
import { createContext, type AppContext } from '../src/server/context.js';

/** The workflow builder and shared contexts: the skill teaches them, and a draft that uses one compiles and says what it does. */
const skill = readFileSync('src/builder/skill.md', 'utf8').replace(/\r\n/g, '\n');
const section = (title: string) => {
  const from = skill.indexOf(`## ${title}`);
  const next = skill.indexOf('\n## ', from + 1);
  return skill.slice(from, next < 0 ? undefined : next);
};

describe('builder skill', () => {
  it('teaches contexts: when to use one, the object input, small contexts, branches, merge steps and the notes pattern', () => {
    const s = section('Sharing context between steps');
    expect(s).toContain('`contexts:`');
    expect(s).toContain('`context: [name]`');
    expect(s).toMatch(/object `input`/);
    expect(s).toContain('{cel: ...}');
    expect(s).toContain('context_taints');
    expect(s).toContain('context_may_skip');
    expect(s).toContain('`merge: any`');
    expect(s).toContain('`notes` string');
  });

  it('stays short, because the skill is sent on every turn', () => {
    expect(section('Sharing context between steps').trim().split('\n').length).toBeLessThanOrEqual(22);
  });

  it('lists the keys in the reference and the diagnostics in the compiler rules, and says to keep them when editing', () => {
    expect(skill).toMatch(/contexts:\s+# optional/);
    expect(section('Rules the compiler enforces (design for them)')).toMatch(/unknown_context[\s\S]*context_collision[\s\S]*context_input_shape[\s\S]*context_on_merge/);
    expect(skill).toContain("Keep a workflow's\n   `contexts:` block");
  });
});

describe('contextNotes', () => {
  it('has one line per step that takes keys from a context, naming the context', () => {
    expect(
      contextNotes([
        { id: 'a', inputParts: [{ key: 'title', source: 'context:brief' }, { key: 'items', source: 'context:brief' }, { key: 'mine', source: 'input' }, { key: 'note', source: 'context:extra' }] },
        { id: 'b', inputParts: [{ key: 'own', source: 'input' }] },
        { id: 'c' },
      ]),
    ).toEqual(["step 'a' takes title, items from shared context 'brief'; note from shared context 'extra'"]);
  });
});

describe('a draft with a shared context', () => {
  let ctx: AppContext;
  let ws: string;
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'azhi-ctx-builder-'));
    ctx = createContext({ databaseUrl: 'pglite://memory', dataDir });
    await migrate(ctx.pool);
    await bootstrapLocal(ctx);
    ws = (await ctx.pool.query(`SELECT id FROM workspaces LIMIT 1`)).rows[0].id as string;
  });

  const files = (contexts: string, nodes: string): Record<string, string> => ({
    'workflow.yaml': `schema_version: "2.0"
id: ctx-draft
name: Ctx draft
${contexts}
nodes:
  - id: intake
    type: script
    runtime: python
    entrypoint: scripts/intake.py
    output_schema: schemas/ticket.json
  - id: gate
    type: condition
    expression: "'a'"
    routes: {a: [branch], b: []}
    default: a
  - id: branch
    type: script
    runtime: python
    entrypoint: scripts/intake.py
    output_schema: schemas/ticket.json
${nodes}`,
    'scripts/intake.py': 'print("{}")\n',
    'schemas/ticket.json': '{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"}}}',
    'schemas/verdict.json': '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
    'profiles/reviewer@1.yaml': 'model: {provider: anthropic, name: default, credential: anthropic-api-key}\ninstructions: Review.\n',
  });
  const review = (id: string, extra: string) => `  - id: ${id}
    type: agent
    profile: reviewer@1
    output_schema: schemas/verdict.json
${extra}`;

  it('compiles, lists the steps\' input parts for the draft panel, and has a note per step', async () => {
    const r = await checkProposal(ctx, ws, files('contexts:\n  ticket:\n    title: {ref: nodes.intake.output.title}\n    body: {ref: nodes.intake.output.body}\n', review('r1', '    context: [ticket]\n') + review('r2', '    context: [ticket]\n    input:\n      focus: security\n')), undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nodes = r.nodes as Array<{ id: string; inputParts?: unknown; def: { input?: object } }>;
    expect(nodes.find((n) => n.id === 'r2')!.inputParts).toEqual([
      { key: 'title', source: 'context:ticket' },
      { key: 'body', source: 'context:ticket' },
      { key: 'focus', source: 'input' },
    ]);
    expect(nodes.find((n) => n.id === 'intake')!.inputParts).toBeUndefined();
    expect(contextNotes(r.nodes)).toEqual(["step 'r1' takes title, body from shared context 'ticket'", "step 'r2' takes title, body from shared context 'ticket'"]);
    expect(r.warnings.filter((w) => w.code === 'unused_context')).toEqual([]);
  });

  it('carries the coupling warnings to the model, with the step they are about', async () => {
    const r = await checkProposal(ctx, ws, files('contexts:\n  b:\n    v: {ref: nodes.branch.output.title}\n', review('r1', '    context: [b]\n')), undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.find((w) => w.code === 'context_may_skip')).toMatchObject({ node: 'r1', message: expect.stringContaining("wait on 'branch'") });
  });

  it('refuses a draft that names a context it does not define, so a patch that drops contexts: is caught', async () => {
    const r = await checkProposal(ctx, ws, files('', review('r1', '    context: [ticket]\n')), undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('unknown_context');
  });
});
