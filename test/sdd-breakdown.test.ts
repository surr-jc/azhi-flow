import { Ajv2020 } from 'ajv/dist/2020.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluateCel } from '../src/cel/evaluator.js';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';
import { loadExample } from '../src/api/examples.js';

/**
 * SDD Breakdown (examples/sdd-breakdown), the no-tracker counterpart of issue-splitter: the package compiles, writes
 * nothing but Slack notices, and its scripts turn the approved plan into the Stories a parent reads. The scripts run
 * as the worker runs them and their output is checked against the schema the package declares for them.
 */
const PKG = 'examples/sdd-breakdown';
const pkg = packageFromDirectory(PKG);
const tools = (parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools ?? []) as Array<{ id: string; effect: string }>;
const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;
const node = (id: string) => def.nodes.find((n) => n.id === id) as any;

const PY: string[] = (() => {
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    const r = spawnSync(cmd[0]!, [...cmd.slice(1), '-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return cmd;
  }
  throw new Error('no Python 3 found (tried python3, python, py -3)');
})();
const ajv = new Ajv2020({ allErrors: true, strict: false });
/** Runs a script as the worker does and checks its output against the schema the package declares for it: the engine refuses an output its schema does not allow. */
const run = (script: string, input: unknown) => {
  const out = JSON.parse(
    execFileSync(PY[0]!, [...PY.slice(1), join(PKG, 'scripts', script)], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }).toString(),
  );
  const schemaPath = join(PKG, 'schemas', script.replace(/\.py$/, '.json'));
  if (existsSync(schemaPath)) {
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
    if (!validate(out)) throw new Error(`${script} printed ${JSON.stringify(out).slice(0, 300)}, which ${schemaPath} refuses: ${ajv.errorsText(validate.errors)}`);
  }
  return out;
};

describe('SDD Breakdown: definition', () => {
  it('compiles with its tools with no error diagnostics, and every write is behind a gate', () => {
    const r = compile(def, { pkg, catalog: staticCatalog(tools as never) });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.plan!.taint.tainted['analyze']).toBeTruthy();
    // The only writes are the guarded Slack notices.
    expect([...new Set(r.plan!.taint.paths.map((p) => p.write))].sort()).toEqual(['notify', 'stop_notify']);
    expect(r.plan!.taint.paths.filter((p) => p.gate === null)).toEqual([]);
    for (const id of ['notify', 'stop_notify']) expect(node(id).guard, id).toBe('args.channel == config.channel');
  });

  it('carries no tool that writes: no step calls a tool, and any tool the package lists only reads', () => {
    expect(def.nodes.filter((n) => n.type === 'tool')).toEqual([]);
    expect(tools.filter((t) => t.effect !== 'read')).toEqual([]);
    expect(tools.map((t) => t.id)).toEqual([]);
  });

  it('has the steps of the brief, in order, with `stories` as the output', () => {
    expect(def.nodes.map((n) => [n.id, n.type])).toEqual([
      ['ticket', 'script'],
      ['analyze', 'agent'],
      ['scope_gate', 'condition'],
      ['stop_message', 'report'],
      ['stop_notify', 'notify'],
      ['weight', 'condition'],
      ['plan_review', 'approval'],
      ['final_plan', 'script'],
      ['stories', 'script'],
      ['notify_gate', 'condition'],
      ['notice', 'script'],
      ['notify', 'notify'],
    ]);
    expect(node('analyze')).toMatchObject({ profile: 'scope-analyst@1', executor: 'opencode' });
    expect(node('analyze').workspace.credential).toBe('github-read-token');
    expect(node('plan_review')).toMatchObject({ role: 'author', expires_in: '72h', on_expiry: 'reject' });
    expect(node('plan_review').decision_schema.properties.drop).toMatchObject({ type: 'string', pattern: '^[0-9, ]*$' });
    expect(node('scope_gate').routes).toEqual({ plan: ['weight'], stop: ['stop_message'] });
    expect(node('stories')).toMatchObject({ type: 'script', merge: 'any', output_schema: 'schemas/stories.json' });
  });

  it('`stories` joins only the two ways to an answer, so a rejected plan skips it', () => {
    const r = compile(def, { pkg, catalog: staticCatalog(tools as never) });
    const stories = r.plan!.nodes.find((n) => n.id === 'stories')!;
    expect([...stories.deps].sort()).toEqual(['final_plan', 'stop_message']);
    // Nothing that always runs, and nothing before the approval except the stop route.
    for (const early of ['ticket', 'analyze', 'scope_gate', 'weight', 'plan_review']) expect(stories.deps).not.toContain(early);
    // The Slack message is posted once: not for a stop (already told), only after the Stories.
    expect(node('notify_gate').routes).toEqual({ yes: ['notice'], no: [] });
    expect(evaluateCel(node('notify_gate').expression, { nodes: { stories: { output: { status: 'not_code' } } } })).toBe('no');
    for (const status of ['ok', 'none']) expect(evaluateCel(node('notify_gate').expression, { nodes: { stories: { output: { status } } } })).toBe('yes');
  });

  it('takes the epic text, an optional epic number and release, and no issue', () => {
    const props = (def as any).inputs.properties;
    expect(Object.keys(props).sort()).toEqual(['base_branch', 'epic', 'release', 'repo', 'text']);
    expect((def as any).inputs.required).toEqual(['repo', 'text']);
    expect(props.text).toMatchObject({ minLength: 1, maxLength: 20000 });
    expect(props.epic).toMatchObject({ type: 'integer', minimum: 1 });
    const release = new RegExp(props.release.pattern);
    for (const ok of ['', 'v1', 'r2026-11', 'a'.repeat(61)]) expect(release.test(ok), ok).toBe(true);
    for (const bad of ['-v1', 'V1', 'a b', 'a'.repeat(62)]) expect(release.test(bad), bad).toBe(false);
  });

  it('refers only to skills, agents, commands and profiles that exist, each skill with its licence and source', () => {
    for (const f of readdirSync(join(PKG, 'profiles'))) {
      const o = parse(readFileSync(join(PKG, 'profiles', f), 'utf8')).harness.opencode;
      for (const file of [o.agent, o.command, ...o.skills.map((s: string) => `${s}/SKILL.md`)]) expect(existsSync(join(PKG, file)), file).toBe(true);
    }
    for (const dir of readdirSync(join(PKG, 'harness/skills'))) for (const f of ['SKILL.md', 'LICENSE', 'SOURCE.md']) expect(existsSync(join(PKG, 'harness/skills', dir, f)), `${dir}/${f}`).toBe(true);
  });

  it('is an installable example with one required setting and no tools', () => {
    const ex = loadExample('sdd-breakdown')!;
    expect(ex.id).toBe('sdd-breakdown');
    expect((ex.config.settings ?? []).map((s: any) => [s.name, s.required])).toEqual([['slack_channel', true]]);
    expect(ex.config.tools ?? []).toEqual([]);
  });

  it('keeps LF line endings in every file of the package', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    for (const f of walk(PKG)) expect(readFileSync(f).includes(13), f).toBe(false);
  });
});

describe('SDD Breakdown: rules and routing', () => {
  const config = { split_max_files: 5, split_sensitive_max_files: 2 };
  const scope = (over: Record<string, unknown> = {}) => ({ is_code: true, deliverables: ['toggle'], est_files: 2, touches_sensitive: false, slices: [{}, {}], ...over });
  const weight = (a: unknown) => evaluateCel(node('weight').expression, { config, nodes: { analyze: { output: a } } });

  it('splits only when the analyst found slices and a rule says so', () => {
    expect(weight(scope())).toBe('single');
    expect(weight(scope({ deliverables: ['a', 'b'] }))).toBe('split');
    expect(weight(scope({ est_files: 6 }))).toBe('split');
    expect(weight(scope({ touches_sensitive: true, est_files: 3 }))).toBe('split');
    expect(weight(scope({ deliverables: ['a', 'b'], slices: [{}] }))).toBe('single');
  });

  it('stops anything that is not a code change', () => {
    const g = (is_code: boolean) => evaluateCel(node('scope_gate').expression, { nodes: { analyze: { output: { is_code } } } });
    expect([g(true), g(false)]).toEqual(['plan', 'stop']);
  });

  it('echoes the epic and release when given, and null otherwise', () => {
    const e = node('stories').input.map as string;
    expect(e).toContain("has(inputs.epic) ? inputs.epic : null");
    expect(e).toContain("has(inputs.release) && inputs.release != '' ? inputs.release : null");
  });
});

const ticket = (over: Record<string, unknown> = {}) => ({ kind: 'text', key: '', number: 0, title: 'Availability controls', description: 'Lots of work', labels: [], url: '', comments: [], ...over });
const slice = (n: number, deps: number[] = [], over: Record<string, unknown> = {}) => ({
  title: `Slice ${n}`,
  summary: `Does part ${n}.`,
  acceptance_criteria: [`criterion ${n}`],
  surface: `src/part${n}.ts:10`,
  depends_on: deps,
  est_files: 2,
  touches_sensitive: false,
  weight: n === 3 ? 'full' : 'lite',
  ...over,
});
const analysis = (n = 3, over: Record<string, unknown> = {}) => ({
  summary: 'Big.',
  deliverables: ['a', 'b', 'c'],
  est_files: 8,
  risk: 'medium',
  single: { title: 'One Story', body: 'Everything in one.', acceptance_criteria: ['it works'] },
  umbrella: { title: 'Availability umbrella', body: 'Tracks it' },
  slices: Array.from({ length: n }, (_, i) => slice(i + 1, i === 0 ? [] : [i])),
  ...over,
});
const plan = (over: Record<string, unknown> = {}) => run('final_plan.py', { weight: 'split', ticket: ticket(), analysis: analysis(), drop: '', ...over });
const stories = (over: Record<string, unknown> = {}) => run('stories.py', { plan: plan(), stopped: false, epic: null, release: null, ...over });
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

describe('SDD Breakdown: scripts', () => {
  it('turns the epic text into a plain ticket whose title is safe to repeat', () => {
    expect(run('ticket.py', { repo: 'acme/shop', text: '\n\n  Make checkout <b>faster</b> \x07 now \nmore detail' })).toMatchObject({ kind: 'text', key: '', number: 0, title: 'Make checkout b faster /b now', description: expect.stringContaining('more detail') });
    expect(run('ticket.py', { repo: 'acme/shop', text: 'x'.repeat(500) }).title).toHaveLength(120);
    expect(() => run('ticket.py', { repo: 'acme/shop', text: '   ' })).toThrow();
  });

  it('splits into three Stories in the analyst order, each with goal, scope, criteria and its dependency', () => {
    const p = plan();
    expect(p).toMatchObject({ mode: 'ok', dropped: [], epic_title: 'Availability umbrella' });
    expect(p.stories.map((s: any) => [s.slice, s.title])).toEqual([[1, 'Slice 1'], [2, 'Slice 2'], [3, 'Slice 3']]);
    expect(p.stories[0].body).toContain('Independent: it can be built on its own.');
    expect(p.stories[0].body).toContain('## Goal\nDoes part 1.');
    expect(p.stories[0].body).toContain('## Scope\nsrc/part1.ts:10');
    expect(p.stories[0].body).toContain('## Acceptance criteria\n- criterion 1');
    expect(p.stories[1].body).toContain('Slice 2 of 3. Depends on slice 1: Slice 1.');
    expect(p.stories[2].body).toContain('Depends on slice 2: Slice 2.');
    expect(p.stories[2].body).toContain('Suggested review path: full.');
  });

  it('drops the middle slice: the rest are renumbered and a dependency on the dropped one is named without a number', () => {
    const a = analysis(3, { slices: [slice(1), slice(2, [1]), slice(3, [1, 2])] });
    const p = plan({ analysis: a, drop: '2' });
    expect(p.dropped).toEqual([2]);
    expect(p.stories.map((s: any) => [s.slice, s.title])).toEqual([[1, 'Slice 1'], [2, 'Slice 3']]);
    expect(p.stories[1].body).toContain('Slice 2 of 2. Depends on slice 1: Slice 1; Slice 2 (left out of this plan).');
    // Numbers outside the plan are ignored; the plan's own numbers are the ones to name.
    expect(plan({ drop: '1, 9' }).dropped).toEqual([1]);
    expect(plan({ drop: '1, 9' }).stories.map((s: any) => s.slice)).toEqual([1, 2]);
    expect(plan({ drop: '1, 9' }).stories[0].body).toContain('Depends on Slice 1 (left out of this plan).');
  });

  it('gives a single epic one Story: the epic itself', () => {
    const p = plan({ weight: 'single' });
    expect(p).toMatchObject({ mode: 'ok', epic_title: 'Availability controls' });
    expect(p.stories).toHaveLength(1);
    expect(p.stories[0]).toMatchObject({ slice: 1, title: 'One Story' });
    expect(p.stories[0].body).toContain('Everything in one.');
    expect(p.stories[0].body).toContain('- it works');
    // The approver's drop applies to a split only.
    expect(plan({ weight: 'single', drop: '1' }).stories).toHaveLength(1);
    expect(plan({ weight: 'single', analysis: analysis(0, { single: { title: '', body: 'b', acceptance_criteria: [] } }) }).stories[0].title).toBe('Availability controls');
  });

  it('returns status none with no Stories when every slice was dropped', () => {
    const p = plan({ drop: '1,2,3' });
    expect(p).toMatchObject({ mode: 'none', stories: [], dropped: [1, 2, 3] });
    expect(stories({ plan: p, epic: 4, release: 'r1' })).toEqual({ status: 'none', epic: 4, release: 'r1', stories: [] });
  });

  it('cuts an analysis of nine slices to six Stories', () => {
    const nine = analysis(9);
    expect(plan({ analysis: nine }).stories).toHaveLength(6);
    // Even a plan that was not cut (a hand-made one) is cut again in the output.
    const wide = { mode: 'ok', epic_title: 'E', dropped: [], stories: Array.from({ length: 9 }, (_, i) => ({ slice: i + 1, title: `S${i + 1}`, body: 'b' })) };
    const out = stories({ plan: wide });
    expect(out.stories.map((s: any) => [s.slice, s.title])).toEqual([[1, 'S1'], [2, 'S2'], [3, 'S3'], [4, 'S4'], [5, 'S5'], [6, 'S6']]);
  });

  it('builds the output contract, with the Part-of line at the top when the epic is known', () => {
    const s = stories({ epic: 3, release: 'v1-2' });
    expect(s).toMatchObject({ status: 'ok', epic: 3, release: 'v1-2' });
    expect(s.stories).toHaveLength(3);
    expect(s.stories[0].body.startsWith('Part of epic 3: Availability umbrella\n\n## Goal')).toBe(true);
    expect(stories().stories[0].body.startsWith('## Goal')).toBe(true);
    expect(stories()).toMatchObject({ epic: null, release: null });
  });

  it('renumbers after a drop and keeps the delivery order', () => {
    const a = analysis(4, { slices: [slice(1), slice(2, [1]), slice(3, [2]), slice(4, [3])] });
    const s = stories({ plan: plan({ analysis: a, drop: '1,3' }) });
    expect(s.stories.map((x: any) => [x.slice, x.title])).toEqual([[1, 'Slice 2'], [2, 'Slice 4']]);
    expect(s.stories[1].body).toContain('Depends on Slice 3 (left out of this plan).');
  });

  it('says not_code when the analyst did, with no Stories, and still echoes the epic and release', () => {
    expect(stories({ plan: null, stopped: true, epic: 2, release: 'r' })).toEqual({ status: 'not_code', epic: 2, release: 'r', stories: [] });
  });

  it('echoes only a valid epic and release', () => {
    expect(stories({ epic: 0, release: 'Bad Release' })).toMatchObject({ epic: null, release: null });
    expect(stories({ epic: true, release: 7 })).toMatchObject({ epic: null, release: null });
    expect(stories({ epic: '3', release: '' })).toMatchObject({ epic: null, release: null });
    expect(stories({ epic: 12, release: 'a'.repeat(61) })).toMatchObject({ epic: 12, release: 'a'.repeat(61) });
  });

  it('cleans hostile text: no angle brackets in titles, no control characters, bounded lengths', () => {
    const evil = '<!channel> <@U123> \x00\x07\x1b[31mred\x7f\r\nnext\ttab ' + 'x'.repeat(30000);
    const a = analysis(3, {
      umbrella: { title: '<!here> umbrella\x01', body: 'b' },
      slices: [slice(1, [], { title: evil, summary: evil, surface: evil, acceptance_criteria: [evil] }), slice(2), slice(3)],
    });
    const s = stories({ plan: plan({ analysis: a }), epic: 5 });
    expect(s.status).toBe('ok');
    for (const x of s.stories) {
      expect(x.title).not.toMatch(/[<>]/);
      expect(x.title).not.toMatch(CONTROL);
      expect(x.title).not.toMatch(/[\n\t]/);
      expect(x.title.length).toBeLessThanOrEqual(200);
      expect(x.body).not.toMatch(CONTROL);
      expect(x.body.length).toBeLessThanOrEqual(19000);
    }
    expect(s.stories[0].title.startsWith('! channel')).toBe(false);
    expect(s.stories[0].title.startsWith('!channel @U123')).toBe(true);
    expect(s.stories[0].title.endsWith('…')).toBe(true);
    expect(s.stories[0].body).toContain('Part of epic 5: !here umbrella');
    expect(s.stories[0].body).toContain('next\ttab');
    expect(s.stories[0].body.endsWith('…')).toBe(true);
    // The Slack message lists cleaned titles and nothing raw.
    const n = run('notice.py', { stories: s, dropped: [] });
    expect(n.message).not.toMatch(/[<>]/);
    expect(n.message).not.toMatch(CONTROL);
    expect(n.message.startsWith('Broke down epic 5 into 3 Story(ies)')).toBe(true);
  });

  it('gives a Story with an empty title a name', () => {
    const p = { mode: 'ok', epic_title: '', dropped: [], stories: [{ slice: 1, title: ' <> \x01 ', body: 'b' }] };
    expect(stories({ plan: p, epic: 1 }).stories[0]).toMatchObject({ title: 'Story 1', body: 'Part of epic 1\n\nb' });
  });

  it('fails the run on input it cannot read, because none would tell a parent the epic had nothing to deliver', () => {
    // A non-zero exit fails the child, and the parent stops; status none is reserved for "every slice was left out".
    for (const bad of ['not json', '', {}, { plan: { mode: 'ok' }, stopped: false }, { plan: { mode: 'ok', epic_title: 'E', stories: [{ slice: 1, title: 5, body: 'b' }] } }, { plan: 'x', stopped: true }, { plan: null, stopped: false }, { plan: null, stopped: 'yes' }, { plan: null }]) {
      expect(() => run('stories.py', bad), JSON.stringify(bad)).toThrow();
    }
    // A plan that is not ok is never turned into Stories.
    expect(run('stories.py', { plan: { mode: 'none', epic_title: 'E', dropped: [], stories: [{ slice: 1, title: 't', body: 'b' }] }, epic: 1 })).toEqual({ status: 'none', epic: 1, release: null, stories: [] });
    // An explicit stop is a result without a plan.
    expect(run('stories.py', { plan: null, stopped: true })).toEqual({ status: 'not_code', epic: null, release: null, stories: [] });
  });

  it('writes the Slack notice from what was kept, and says when every slice was left out', () => {
    const s = stories({ plan: plan({ drop: '2' }), epic: 2, release: 'r1' });
    const n = run('notice.py', { stories: s, dropped: [2] });
    expect(n.message).toBe('Broke down epic 2 (release r1) into 2 Story(ies), in delivery order:\n• 1. Slice 1\n• 2. Slice 3\nLeft out at the approval: slice 2.');
    const none = run('notice.py', { stories: stories({ plan: plan({ drop: '1,2,3' }) }), dropped: [1, 2, 3] });
    expect(none.message).toBe('Nothing to deliver for the epic: every slice was left out at the approval.\nLeft out at the approval: slice 1, 2, 3.');
  });
});
