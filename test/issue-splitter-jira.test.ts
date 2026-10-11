import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluateCel } from '../src/cel/evaluator.js';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';

/**
 * The Jira issue splitter (examples/issue-splitter-jira): the definition, the routing, the scripts that
 * build the issues, and above all that the additional-fields JSON a sub-task is created with is valid
 * JSON whatever the slice's labels and titles contain. None of it needs Temporal or OpenCode.
 */
const PKG = 'examples/issue-splitter-jira';
const pkg = packageFromDirectory(PKG);
const tools = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools;
const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;
const node = (id: string) => def.nodes.find((n) => n.id === id) as any;
const py = (script: string, input: unknown) => JSON.parse(execFileSync('python3', [join(PKG, 'scripts', script)], { input: JSON.stringify(input) }).toString());
const compiled = () => compile(def, { pkg, catalog: staticCatalog(tools) });

describe('Jira issue splitter: definition', () => {
  it('compiles, with the analyst tainted and every write gated', () => {
    const r = compiled();
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.plan!.taint.tainted['analyze']).toBeTruthy();
    for (const write of ['single_comment', 'single_label', 'single_create', 'parent_create', 'issue_1', 'issue_6', 'parent_comment', 'notify', 'stop_notify']) {
      const paths = r.plan!.taint.paths.filter((p) => p.write === write);
      expect(paths.length, write).toBeGreaterThan(0);
      expect(paths.every((p) => p.gate !== null), write).toBe(true);
    }
  });

  it('reads with a read-only server and a read token, and writes with a separate token and write mode', () => {
    const t = (id: string) => tools.find((x: any) => x.id === id);
    expect(t('jira.get-issue')).toMatchObject({ effect: 'read', credential: 'jira-api-token', transport: { env: { READ_ONLY_MODE: 'true', ENABLED_TOOLS: 'jira_get_issue' } } });
    expect(t('jira.create-issue')).toMatchObject({ effect: 'write-dedupable', credential: 'jira-write-token', transport: { tool: 'jira_create_issue', env: { READ_ONLY_MODE: 'false', ENABLED_TOOLS: 'jira_create_issue' } } });
    expect(t('jira.add-comment')).toMatchObject({ effect: 'write-dedupable', credential: 'jira-write-token' });
    expect(t('jira.update-labels')).toMatchObject({ effect: 'write-idempotent', credential: 'jira-write-token' });
  });

  it('every join runs only when one of its branches ran', () => {
    const r = compiled();
    const merges = r.plan!.nodes.filter((n) => (n.def as { merge?: string }).merge === 'any');
    expect(merges.map((n) => n.id).sort()).toEqual(['outcome', 'parent', 'ticket']);
    const early = ['source', 'jira_issue', 'intake_issue', 'ticket', 'analyze', 'scope_gate', 'weight', 'plan_review', 'stop_message', 'stop_notify'];
    for (const id of ['parent', 'outcome']) for (const e of early) expect(merges.find((n) => n.id === id)!.deps, `${id} -> ${e}`).not.toContain(e);
    expect(merges.find((n) => n.id === 'ticket')!.deps.sort()).toEqual(['intake_issue', 'text_pass']);
  });

  it('refers only to skills, agents, commands and profiles that exist', () => {
    for (const f of readdirSync(join(PKG, 'profiles'))) {
      const o = parse(readFileSync(join(PKG, 'profiles', f), 'utf8')).harness.opencode;
      for (const file of [o.agent, o.command, ...o.skills.map((s: string) => `${s}/SKILL.md`)]) expect(existsSync(join(PKG, file)), file).toBe(true);
    }
  });
});

const ticket = (over: Record<string, unknown> = {}) => ({ kind: 'issue', key: 'PAY-142', number: 0, project: 'PAY', title: 'Partial refunds', description: 'Lots', labels: ['backend'], url: 'u', comments: [], ...over });
const slice = (n: number, over: Record<string, unknown> = {}) => ({ title: `Slice ${n}`, summary: `Part ${n}.`, acceptance_criteria: [`criterion ${n}`], surface: `src/p${n}.ts:1`, depends_on: [], est_files: 2, touches_sensitive: false, weight: 'lite', ...over });
const analysis = (slices: unknown[]) => ({ summary: 'Big.', deliverables: ['a', 'b'], est_files: 8, risk: 'medium', single: { title: 'One', body: 'Body', acceptance_criteria: ['ok'] }, umbrella: { title: 'Umbrella', body: 'Tracks it' }, slices });
const plan = (over: Record<string, unknown>) => py('final_plan.py', { weight: 'split', ticket: ticket(), analysis: analysis([slice(1), slice(2, { depends_on: [1] })]), drop: '', ready_label: 'ready', split_label: 'azhi-split', ...over });
const scopeFor = (issues: unknown[]) => ({ inputs: { repo: 'a/b' }, nodes: { final_plan: { output: { issues } }, parent: { output: { key: 'PAY-142' } }, ticket: { output: { project: 'PAY' } } } });

describe('Jira issue splitter: scripts', () => {
  it('normalizes an issue (taking its project from the key) and a text request (which names its project)', () => {
    const n = { key: 'PAY-142', title: 'T', description: 'D', labels: ['x'], url: 'u' };
    expect(py('ticket.py', { normalized: n, text: '', project: '' })).toMatchObject({ kind: 'issue', key: 'PAY-142', project: 'PAY', labels: ['x'] });
    expect(py('ticket.py', { normalized: null, text: 'Make refunds faster\nmore', project: 'PAY' })).toMatchObject({ kind: 'text', key: '', project: 'PAY', title: 'Make refunds faster' });
    expect(() => py('ticket.py', { normalized: null, text: 'x', project: '' })).toThrow();
    expect(() => py('ticket.py', { normalized: null, text: 'x', project: 'pay; DROP' })).toThrow();
    expect(() => py('ticket.py', { normalized: { ...n, key: 'not a key' }, text: '', project: '' })).toThrow();
  });

  it('builds sub-tasks with labels, order and dependencies', () => {
    const p = plan({});
    expect(p).toMatchObject({ mode: 'split_existing', label: 'PAY-142' });
    expect(p.issues.map((i: any) => i.title)).toEqual(['Slice 1', 'Slice 2']);
    expect(p.issues[1].body).toContain('Depends on slice 1: Slice 1. Do not start it before those are done.');
    expect(JSON.parse(p.issues[0].fields_tail.replace(/^/, '{"parent":"X"') )).toEqual({ parent: 'X', labels: ['azhi-split', 'ready'] });
    // Slice 2 waits for slice 1: not ready to start.
    expect(JSON.parse('{"parent":"X"' + p.issues[1].fields_tail)).toEqual({ parent: 'X', labels: ['azhi-split'] });
    expect(plan({ drop: '2' }).issues).toHaveLength(1);
    expect(plan({ drop: '1 2' })).toMatchObject({ mode: 'none' });
  });

  it('plans an umbrella first for text, and one issue for a small text request', () => {
    const t = ticket({ kind: 'text', key: '', title: 'Faster refunds' });
    const split = plan({ ticket: t });
    expect(split).toMatchObject({ mode: 'split_new', umbrella: { title: 'Umbrella' } });
    expect(JSON.parse(split.umbrella.fields)).toEqual({ labels: ['azhi-split'] });
    const single = plan({ weight: 'single', ticket: t });
    expect(single).toMatchObject({ mode: 'single_new', single: { title: 'One' } });
    expect(JSON.parse(single.single.fields)).toEqual({ labels: ['ready'] });
    expect(single.single.body).toContain('Original request');
  });

  it('keeps the labels an existing issue already has when it adds the ready label', () => {
    const p = plan({ weight: 'single' });
    expect(p.mode).toBe('single_existing');
    expect(JSON.parse(p.labels_fields)).toEqual({ labels: ['backend', 'ready'] });
    expect(JSON.parse(plan({ weight: 'single', ready_label: '' }).labels_fields)).toEqual({ labels: ['backend'] });
    expect(p.comment).toContain('This fits one pull request');
  });

  it('creates every sub-task with additional_fields that is valid JSON, whatever the slice contains', () => {
    const nasty = plan({ analysis: analysis([slice(1, { title: 'Say "hi" \\ and \n newline' }), slice(2)]), split_label: 'azhi-split' });
    for (let i = 0; i < nasty.issues.length; i++) {
      const fields = evaluateCel(node('issue_1').arguments.additional_fields.cel.replace(/issues\[0\]/g, `issues[${i}]`), scopeFor(nasty.issues)) as string;
      const parsed = JSON.parse(fields);
      expect(parsed).toEqual({ parent: 'PAY-142', labels: ['azhi-split', 'ready'] });
    }
    const desc = evaluateCel(node('issue_1').arguments.description.cel, scopeFor(nasty.issues)) as string;
    expect(desc.startsWith('Part of PAY-142\n\n')).toBe(true);
    expect(nasty.issues[0].title).toBe('Say "hi" \\ and \n newline');
    // With no labels at all the JSON is still valid.
    const bare = plan({ ready_label: '', split_label: '' });
    expect(JSON.parse(`{"parent":"X"${bare.issues[0].fields_tail}`)).toEqual({ parent: 'X' });
  });

  it('reads the key of a created issue however the server wraps it', () => {
    const wrapped = { message: 'ok', issue: { key: 'PAY-201', summary: 'S' } };
    expect(py('parent.py', { issue: '', created: wrapped, jira_url: 'https://x.atlassian.net/' })).toEqual({ key: 'PAY-201', url: 'https://x.atlassian.net/browse/PAY-201', created: true });
    expect(py('parent.py', { issue: '', created: JSON.stringify({ key: 'PAY-202' }), jira_url: 'https://x' }).key).toBe('PAY-202');
    expect(py('parent.py', { issue: 'PAY-142', created: null, jira_url: 'https://x' })).toMatchObject({ key: 'PAY-142', created: false });
    expect(() => py('parent.py', { issue: '', created: { message: 'no key' }, jira_url: 'https://x' })).toThrow();
    expect(() => py('parent.py', { issue: 'garbage', created: null, jira_url: 'https://x' })).toThrow();
  });

  it('says what was created', () => {
    const made = (n: number) => ({ message: 'ok', issue: { key: `PAY-${200 + n}`, summary: `Slice ${n}` } });
    const o = py('outcome.py', { mode: 'split_existing', label: 'PAY-142', dropped: [2], jira_url: 'https://x', parent: { key: 'PAY-142', created: false }, created: [made(1), made(3), null, null, null, null] });
    expect(o.message).toContain('Split PAY-142 into 2 sub-task(s) under PAY-142');
    expect(o.message).toContain('PAY-201 (https://x/browse/PAY-201) Slice 1');
    expect(o.message).toContain('Left out at the approval: slice 2.');
    expect(o.parent_comment).toContain('- PAY-203 Slice 3');
    expect(py('outcome.py', { mode: 'single_new', label: 'x', jira_url: 'https://x', parent: null, created: [], single: made(1) }).message).toContain('Created PAY-201');
  });
});
