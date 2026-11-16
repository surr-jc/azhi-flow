import { Ajv2020 } from 'ajv/dist/2020.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';

/**
 * The seams between the SDD workflows. Each package's own tests use stand-ins for its children, so none of them can see
 * a child whose real inputs or outputs have drifted from what its parent assumes. These tests run the REAL scripts of one
 * package on the REAL output of another, and check every child call in the compiled plans against the child's declared
 * inputs:
 *   sdd-factory -> sdd-breakdown | issue-splitter | sdd-story | ai-sdlc-factory-verify
 *   sdd-story   -> pr-review
 */
const PY: string[] = (() => {
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    const r = spawnSync(cmd[0]!, [...cmd.slice(1), '-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return cmd;
  }
  throw new Error('no Python 3 found (tried python3, python, py -3)');
})();
const ajv = new Ajv2020({ allErrors: true, strict: false });

/** Runs a script of a package as the worker does, and checks its output against the schema that package declares for it. */
const run = (pkg: string, script: string, input: unknown) => {
  const out = JSON.parse(
    execFileSync(PY[0]!, [...PY.slice(1), join('examples', pkg, 'scripts', script)], {
      input: JSON.stringify(input),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }).toString(),
  );
  const schemaPath = join('examples', pkg, 'schemas', script.replace(/\.py$/, '.json'));
  if (existsSync(schemaPath)) {
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
    if (!validate(out)) throw new Error(`${pkg}/${script} printed ${JSON.stringify(out).slice(0, 300)}, which ${schemaPath} refuses: ${ajv.errorsText(validate.errors)}`);
  }
  return out;
};

const workflowOf = (pkg: string) => parse(readFileSync(join('examples', pkg, 'workflow.yaml'), 'utf8').replaceAll('{{slack_channel}}', 'C0TEST'));
/** The JSON Schema a package declares for its run inputs, as a validator. */
const inputsOf = (pkg: string) => {
  const schema = workflowOf(pkg).inputs;
  return { schema, validate: ajv.compile(schema) };
};
const planOf = (pkg: string) => {
  const dir = join('examples', pkg);
  const p = packageFromDirectory(dir);
  const tools = parse(readFileSync(join(dir, 'azhi.config.yaml'), 'utf8')).tools ?? [];
  const def = loadDefinitionText(p.readText(p.manifest.workflow)!).definition!;
  const r = compile(def, { pkg: p, catalog: staticCatalog(tools) });
  expect(r.diagnostics.filter((d) => d.severity === 'error'), pkg).toEqual([]);
  return r.plan!;
};
/** The keys of an input map as written in the workflow: a `{key: value}` object, never a CEL `map`. */
const keysOf = (input: unknown) => Object.keys((input ?? {}) as Record<string, unknown>);

const REPO = 'acme/shop';
const MAX_RELEASE = /^[a-z0-9][a-z0-9-]{0,60}$/;

describe('every child call passes inputs the child declares', () => {
  const calls: Array<[string, string]> = [
    ['sdd-factory', 'issue-splitter'],
    ['sdd-factory', 'sdd-breakdown'],
    ['sdd-factory', 'sdd-story'],
    ['sdd-factory', 'ai-sdlc-factory-verify'],
    ['sdd-story', 'pr-review'],
  ];
  for (const [parent, child] of calls) {
    it(`${parent} -> ${child}`, () => {
      const plan = planOf(parent);
      const steps = plan.nodes.filter((n) => n.type === 'subworkflow' && (n.def as { workflow?: string }).workflow === child);
      expect(steps.length, `${parent} has a step calling ${child}`).toBeGreaterThan(0);
      const declared = inputsOf(child).schema;
      const properties = Object.keys(declared.properties ?? {});
      // Required by the child unconditionally; a conditional requirement (allOf/anyOf) is checked by the chain tests below.
      const required: string[] = declared.required ?? [];
      for (const step of steps) {
        const given = keysOf((step.def as { input?: unknown }).input);
        expect(properties, `${step.id} passes only inputs ${child} declares`).toEqual(expect.arrayContaining(given));
        expect(given, `${step.id} passes every input ${child} requires`).toEqual(expect.arrayContaining(required));
      }
    });
  }
});

describe('a release with no tracker, through the real scripts of all three packages', () => {
  const dropped = { mode: 'ok', epic_title: 'Take a card payment', dropped: [], stories: [] as unknown[] };
  const plan = (titles: string[]) => ({ ...dropped, stories: titles.map((t, i) => ({ slice: i + 1, title: t, body: `Build ${t}.\n\n## Acceptance\n- it works` })) });
  const prd = {
    title: 'Pay by card',
    summary: 'Customers can pay by card.',
    invariants: ['An order is never charged twice'],
    journeys: [{ name: 'Checkout', steps: ['Add to cart', 'Pay', 'See receipt'] }],
    non_goals: [],
    walking_skeleton: 'cart -> pay -> receipt',
    epics: [
      { title: 'Take a card payment', goal: 'A card payment succeeds.', scope: ['src/pay'], acceptance_criteria: ['It succeeds'] },
      { title: 'Send receipts', goal: 'Email a receipt.', scope: ['src/mail'], acceptance_criteria: ['It is emailed'] },
    ],
  };

  it('turns what sdd-breakdown returns into inputs that sdd-story accepts, and the first one carries the document', () => {
    const release = run('sdd-factory', 'release.py', { prd, repo: REPO, goal: 'Let customers pay by card', ticket: '' }).id as string;
    expect(release).toMatch(MAX_RELEASE);
    const epics = run('sdd-factory', 'epics.py', { prd, drop: '', greenfield: false }).epics as Array<{ n: number; text: string }>;
    expect(epics).toHaveLength(2);

    // What the factory sends sdd-breakdown for each epic is what sdd-breakdown declares.
    const breakdownInputs = inputsOf('sdd-breakdown');
    for (const e of epics) {
      const sent = { repo: REPO, text: e.text, base_branch: 'dev', epic: e.n, release };
      expect(breakdownInputs.validate(sent), JSON.stringify(breakdownInputs.validate.errors)).toBe(true);
    }

    // What sdd-breakdown prints (its real script) is what the factory's outcome script reads.
    const rounds = [plan(['Charge a card', 'Show a receipt page']), plan(['Email the receipt'])].map((p, i) => {
      const stories = run('sdd-breakdown', 'stories.py', { plan: p, epic: i + 1, release });
      expect(stories).toMatchObject({ status: 'ok', epic: i + 1, release });
      const outcome = run('sdd-factory', 'breakdown_outcome.py', { child: { state: 'succeeded', nodes: { stories } }, epic: i + 1, last: i === 1 });
      expect(outcome).toMatchObject({ status: 'ok', epic: i + 1 });
      return { round: i + 1, outcome: i === 1 ? 'done' : 'retry', reason: null, steps: { breakdown_outcome: outcome } };
    });
    const order = run('sdd-factory', 'order.py', { source: 'files', split: null, breakdown: { outcome: 'done', reason: null, count: 2, exited: true, last: {}, rounds }, epics: 2, repo: REPO, release });
    expect(order).toMatchObject({ ok: true, count: 3, too_many: false });
    expect(order.stories.map((s: any) => s.ref)).toEqual([`${release}-s1`, `${release}-s2`, `${release}-s3`]);

    const doc = run('sdd-factory', 'breakdown_doc.py', { source: 'files', release, prd: '# Pay by card\n\nThe plan.', order });
    expect(doc.files).toHaveLength(1);
    expect(doc.files[0].path).toBe(`docs/release/${release}/breakdown.md`);
    for (const t of ['Charge a card', 'Show a receipt page', 'Email the receipt']) expect(doc.files[0].content).toContain(t);

    // What the factory sends sdd-story for each Story is what sdd-story declares: the first carries the document, the rest none.
    const storyInputs = inputsOf('sdd-story');
    let stackOn = 'dev';
    order.stories.forEach((s: any, i: number) => {
      const sent = { source: 'files', repo: REPO, base_branch: 'dev', stack_on: stackOn, mode: 'supervised', ...s.inputs, extra_files: i === 0 ? doc.files : [] };
      expect(storyInputs.validate(sent), `${s.ref}: ${JSON.stringify(storyInputs.validate.errors)}`).toBe(true);
      // The Story's own intake turns the inputs into the ticket the rest of the Story reads, and the branch it will push.
      // (The workflow maps story_key, story_title and story_body to the script's key, title and body.)
      const ticket = run('sdd-story', 'files_ticket.py', { key: sent.story_key, title: sent.story_title, body: sent.story_body });
      expect(ticket).toMatchObject({ key: s.ref });
      stackOn = `azhi/${ticket.key}`;
      expect(stackOn).toMatch(/^[A-Za-z0-9._/-]{1,200}$/);
    });

    // The document the first Story receives is pushed with the change, and a Story without extras pushes only its own files.
    const pushed = run('sdd-story', 'push_files.py', { agent_files: [{ path: 'src/pay.ts', status: 'added', content: 'x' }], extra_files: doc.files });
    expect(pushed.files.map((f: any) => f.path).sort()).toEqual([`docs/release/${release}/breakdown.md`, 'src/pay.ts']);
    expect(pushed.ignored).toEqual([]);
  });

  it('a release id from the factory is accepted by sdd-breakdown for any title, even an odd one', () => {
    const breakdownInputs = inputsOf('sdd-breakdown');
    for (const title of ['Pay by card', '', '!!!', 'Ünïcödé — ✨ release', 'x'.repeat(300), '  Spaces   and CAPS  ']) {
      const release = run('sdd-factory', 'release.py', { prd: { ...prd, title }, repo: REPO, goal: 'goal', ticket: '' }).id as string;
      expect(release, title).toMatch(MAX_RELEASE);
      expect(breakdownInputs.validate({ repo: REPO, text: 't', release }), title).toBe(true);
    }
  });

  it('an unreadable plan from sdd-breakdown stops the release instead of reading as an epic with nothing to deliver', () => {
    // sdd-breakdown fails its run on a plan it cannot read; the factory reads a failed child as a failed split.
    const outcome = run('sdd-factory', 'breakdown_outcome.py', { child: { state: 'failed', error: { class: 'internal' }, nodes: {} }, epic: 1, last: false });
    expect(outcome).toMatchObject({ status: 'failed', stories: [] });
    const order = run('sdd-factory', 'order.py', {
      source: 'files',
      split: null,
      breakdown: { outcome: 'stop', reason: null, count: 1, exited: true, last: {}, rounds: [{ round: 1, outcome: 'stop', reason: null, steps: { breakdown_outcome: outcome } }] },
      epics: 2,
      repo: REPO,
      release: 'pay-by-card-abc123',
    });
    expect(order).toMatchObject({ ok: false, problem: 'split_failed', count: 0, stories: [] });
  });
});

describe('a release with GitHub issues, through the real scripts', () => {
  it('gives sdd-story a ticket and empty files-only inputs, which it accepts', () => {
    const rounds = [
      {
        round: 1,
        outcome: 'done',
        reason: null,
        steps: { split_outcome: { status: 'ok', epic: 1, reason: 'ok', last: true, stories: [{ ref: `${REPO}#12`, number: 12, title: 'Story 12' }, { ref: `${REPO}#13`, number: 13, title: 'Story 13' }] } },
      },
    ];
    const order = run('sdd-factory', 'order.py', { source: 'github', split: { outcome: 'done', reason: null, count: 1, exited: true, last: {}, rounds }, breakdown: null, epics: 1, repo: REPO, release: 'r-abc123' });
    expect(order).toMatchObject({ ok: true, count: 2 });
    const storyInputs = inputsOf('sdd-story');
    for (const s of order.stories) {
      const sent = { source: 'github', repo: REPO, base_branch: 'dev', stack_on: '', mode: 'auto', ...s.inputs, extra_files: [] };
      expect(sent.ticket).toBe(s.ref);
      expect(storyInputs.validate(sent), JSON.stringify(storyInputs.validate.errors)).toBe(true);
    }
    // And the inputs that belong to the other source are refused, so a wiring mistake fails at the start of the Story.
    expect(storyInputs.validate({ source: 'files', repo: REPO, base_branch: 'dev', ticket: `${REPO}#12`, story_key: 'a-s1', story_title: 't', story_body: 'b' })).toBe(false);
    expect(storyInputs.validate({ source: 'github', repo: REPO, base_branch: 'dev', ticket: '' })).toBe(false);
  });
});
