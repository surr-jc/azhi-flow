import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { PYTHON } from './helpers/python.js';
import { describe, expect, it } from 'vitest';
import { evaluateCel } from '../src/cel/evaluator.js';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';

/**
 * The issue splitter example (examples/issue-splitter): the definition, the rules that decide single or
 * split, the routing, and the scripts that build the issues, none of which need Temporal or OpenCode.
 */
const PKG = 'examples/issue-splitter';
const pkg = packageFromDirectory(PKG);
const tools = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools;
const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;
const node = (id: string) => def.nodes.find((n) => n.id === id) as any;
const compiled = () => compile(def, { pkg, catalog: staticCatalog(tools) });
const config = { split_max_files: 5, split_sensitive_max_files: 2, ready_label: 'ready', split_label: 'azhi-split' };
const py = (script: string, input: unknown) => JSON.parse(execFileSync(PYTHON[0]!, [...PYTHON.slice(1), join(PKG, 'scripts', script)], { input: JSON.stringify(input) }).toString());
const scope = (over: Record<string, unknown> = {}) => ({ is_code: true, deliverables: ['toggle'], est_files: 2, touches_sensitive: false, slices: [{}, {}], ...over });
const weight = (a: unknown) => evaluateCel(node('weight').expression, { config, nodes: { analyze: { output: a } } });

describe('issue splitter: definition', () => {
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

  it('writes nothing before the approval, and routes by mode', () => {
    const r = compiled();
    const writes = ['single_comment', 'single_label', 'single_create', 'parent_create', 'issue_1', 'parent_comment'];
    for (const w of writes) expect(r.plan!.nodes.find((n) => n.id === w)!.route ?? r.plan!.nodes.find((n) => n.id === w)!.deps, w).toBeTruthy();
    expect(node('plan_review')).toMatchObject({ type: 'approval', role: 'author', on_expiry: 'reject' });
    expect(node('scope_gate').routes).toEqual({ plan: ['weight'], stop: ['stop_message'] });
    expect(node('mode').routes).toEqual({ single_existing: ['single_comment', 'single_label'], single_new: ['single_create'], split_existing: ['parent_existing'], split_new: ['parent_create'], none: [] });
    expect(def.nodes.filter((n) => /^issue_\d$/.test(n.id)).map((n) => n.id)).toEqual(['issue_1', 'issue_2', 'issue_3', 'issue_4', 'issue_5', 'issue_6']);
  });

  it('every join runs only when one of its branches ran: none depends on a step that runs before the approval or the branches', () => {
    const r = compiled();
    const merges = r.plan!.nodes.filter((n) => (n.def as { merge?: string }).merge === 'any');
    expect(merges.map((n) => n.id).sort()).toEqual(['outcome', 'parent', 'ticket']);
    const early = ['source', 'ticket', 'analyze', 'scope_gate', 'weight', 'plan_review', 'stop_message', 'stop_notify'];
    for (const id of ['parent', 'outcome']) for (const e of early) expect(merges.find((n) => n.id === id)!.deps, `${id} -> ${e}`).not.toContain(e);
    expect(merges.find((n) => n.id === 'ticket')!.deps.sort()).toEqual(['github_issue', 'text_pass']);
    expect(merges.find((n) => n.id === 'parent')!.deps.sort()).toEqual(['parent_create', 'parent_existing']);
  });

  it('refers only to skills, agents, commands and profiles that exist, each skill with its licence and source', () => {
    for (const f of readdirSync(join(PKG, 'profiles'))) {
      const o = parse(readFileSync(join(PKG, 'profiles', f), 'utf8')).harness.opencode;
      for (const file of [o.agent, o.command, ...o.skills.map((s: string) => `${s}/SKILL.md`)]) expect(existsSync(join(PKG, file)), file).toBe(true);
    }
    for (const dir of readdirSync(join(PKG, 'harness/skills'))) for (const f of ['SKILL.md', 'LICENSE', 'SOURCE.md']) expect(existsSync(join(PKG, 'harness/skills', dir, f)), `${dir}/${f}`).toBe(true);
  });
});

describe('issue splitter: rules and routing', () => {
  it('splits only when the analyst found slices and a rule says so', () => {
    expect(weight(scope())).toBe('single');
    expect(weight(scope({ deliverables: ['a', 'b'] }))).toBe('split');
    expect(weight(scope({ est_files: 6 }))).toBe('split');
    expect(weight(scope({ est_files: 5 }))).toBe('single');
    expect(weight(scope({ touches_sensitive: true, est_files: 3 }))).toBe('split');
    expect(weight(scope({ touches_sensitive: true, est_files: 2 }))).toBe('single');
    // The rules say split but there is nothing to split into: one issue, with a note at the approval.
    expect(weight(scope({ deliverables: ['a', 'b'], slices: [{}] }))).toBe('single');
    expect(weight(scope({ deliverables: ['a', 'b'], slices: [] }))).toBe('single');
  });

  it('stops anything that is not a code change', () => {
    const g = (is_code: boolean) => evaluateCel(node('scope_gate').expression, { nodes: { analyze: { output: { is_code } } } });
    expect([g(true), g(false)]).toEqual(['plan', 'stop']);
  });

  it('takes an issue number or reference, else the text', () => {
    const src = (inputs: Record<string, unknown>) => evaluateCel(node('source').expression, { inputs });
    expect(src({ repo: 'a/b', issue: '27' })).toBe('issue');
    expect(src({ repo: 'a/b', text: 'make it faster' })).toBe('text');
    expect(src({ repo: 'a/b', issue: '', text: 'x' })).toBe('text');
    const arg = (issue: string) => evaluateCel(node('github_issue').arguments.issue.cel, { inputs: { repo: 'acme/shop', issue } });
    expect(arg('27')).toBe('acme/shop#27');
    expect(arg('acme/shop#27')).toBe('acme/shop#27');
  });
});

const ticket = (over: Record<string, unknown> = {}) => ({ kind: 'issue', key: 'acme/shop#27', number: 27, title: 'Availability controls', description: 'Lots of work', labels: [], url: 'u', comments: [], ...over });
const slice = (n: number, deps: number[] = []) => ({ title: `Slice ${n}`, summary: `Does part ${n}.`, acceptance_criteria: [`criterion ${n}`], surface: `src/part${n}.ts:10`, depends_on: deps, est_files: 2, touches_sensitive: false, weight: n === 3 ? 'full' : 'lite' });
const analysis = (n = 3) => ({ summary: 'Big.', deliverables: ['a', 'b', 'c'], est_files: 8, risk: 'medium', single: { title: 'One issue', body: 'Body', acceptance_criteria: ['it works'] }, umbrella: { title: 'Umbrella', body: 'Tracks it' }, slices: Array.from({ length: n }, (_, i) => slice(i + 1, i === 1 ? [1] : [])) });
const plan = (over: Record<string, unknown>) => py('final_plan.py', { weight: 'split', ticket: ticket(), analysis: analysis(), drop: '', ready_label: 'ready', split_label: 'azhi-split', ...over });

describe('issue splitter: scripts', () => {
  it('normalizes an issue and free text, and refuses an issue from another repository', () => {
    const issue = { repo: 'acme/shop', number: 27, title: 'T', body: 'B', labels: ['bug'], url: 'u', comments: [{ author: 'a', body: 'c' }] };
    expect(py('ticket.py', { repo: 'acme/shop', text: '', issue })).toMatchObject({ kind: 'issue', key: 'acme/shop#27', number: 27, title: 'T', description: 'B' });
    expect(py('ticket.py', { repo: 'acme/shop', text: '\n\n  Make checkout faster  \nmore detail', issue: null })).toMatchObject({ kind: 'text', key: '', number: 0, title: 'Make checkout faster' });
    expect(() => py('ticket.py', { repo: 'acme/other', text: '', issue })).toThrow();
    expect(() => py('ticket.py', { repo: 'acme/shop', text: '  ', issue: null })).toThrow();
  });

  it('builds the sub-issues of a split of an existing issue, in order, with dependencies and labels', () => {
    const p = plan({});
    expect(p).toMatchObject({ mode: 'split_existing', label: 'acme/shop#27', dropped: [] });
    expect(p.issues.map((i: any) => i.title)).toEqual(['Slice 1', 'Slice 2', 'Slice 3']);
    expect(p.issues[0].body).toContain('Independent: it can be built on its own.');
    expect(p.issues[1].body).toContain('Slice 2 of 3. Depends on slice 1: Slice 1. Do not start it before those are merged.');
    expect(p.issues[2].body).toContain('Suggested review path: full.');
    expect(p.issues[0].body).toContain('- criterion 1');
    expect(p.issues[0].labels).toEqual(['azhi-split', 'ready']);
    // A slice that waits for another is not ready to start, so it is not labelled ready (slice 3 is independent).
    expect(p.issues.map((i: any) => i.labels)).toEqual([['azhi-split', 'ready'], ['azhi-split'], ['azhi-split', 'ready']]);
  });

  it('leaves out the slices the approver dropped, and says when a dependency was dropped', () => {
    const p = plan({ drop: '1, 3, 9' });
    expect(p.dropped).toEqual([1, 3]);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0].body).toContain('slice 1: Slice 1 (left out of this plan)');
    expect(plan({ drop: '1,2,3' })).toMatchObject({ mode: 'none', issues: [] });
  });

  it('plans an umbrella first when the request was free text', () => {
    const p = plan({ ticket: ticket({ kind: 'text', key: '', number: 0, title: 'Make it faster' }) });
    expect(p).toMatchObject({ mode: 'split_new', label: 'Make it faster', umbrella: { title: 'Umbrella', labels: ['azhi-split'] } });
    expect(p.umbrella.body).toContain('Each slice is a sub-issue');
    expect(p.issues).toHaveLength(3);
  });

  it('comments and labels a single existing issue, or creates one from text', () => {
    const one = plan({ weight: 'single' });
    expect(one).toMatchObject({ mode: 'single_existing', labels: ['ready'], ticket_number: 27 });
    expect(one.comment).toContain('This fits one pull request');
    const text = plan({ weight: 'single', ticket: ticket({ kind: 'text', key: '', number: 0, title: 'Fix typo', description: 'Fix the typo' }) });
    expect(text).toMatchObject({ mode: 'single_new', single: { title: 'One issue', labels: ['ready'] } });
    expect(text.single.body).toContain('## Acceptance criteria');
    expect(plan({ weight: 'single', ready_label: '' }).labels).toEqual([]);
  });

  it('names the parent: the issue given, or the umbrella created', () => {
    expect(py('parent.py', { issue: '27', created: null, repo: 'acme/shop' })).toEqual({ number: 27, url: 'https://github.com/acme/shop/issues/27', created: false });
    expect(py('parent.py', { issue: 'acme/shop#41', created: null, repo: 'acme/shop' }).number).toBe(41);
    expect(py('parent.py', { issue: '', created: { number: 120, url: 'u' }, repo: 'acme/shop' })).toEqual({ number: 120, url: 'u', created: true });
    expect(() => py('parent.py', { issue: '', created: null, repo: 'acme/shop' })).toThrow();
  });

  it('says what was created, and what was not linked', () => {
    const made = (n: number, linked = true) => ({ number: 100 + n, title: `Slice ${n}`, url: `https://x/${100 + n}`, linked });
    const o = py('outcome.py', { mode: 'split_existing', label: 'acme/shop#27', dropped: [2], parent: { number: 27, created: false }, created: [made(1), made(3, false), null, null, null, null] });
    expect(o.message).toContain('Split acme/shop#27 into 2 issue(s) under #27');
    expect(o.message).toContain('Left out at the approval: slice 2.');
    expect(o.message).toContain('Not linked as sub-issues');
    expect(o.parent_comment).toContain('- #101 Slice 1');
    expect(o.parent_number).toBe(27);
    expect(py('outcome.py', { mode: 'single_existing', label: 'acme/shop#27', parent: null, created: [], labelled: { labels: ['ready'] } }).message).toContain('added the labels ready');
    expect(py('outcome.py', { mode: 'none', label: 'x', parent: null, created: [] }).message).toContain('every slice was left out');
  });
});
