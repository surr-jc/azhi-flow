import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { staticCatalog } from '../src/gateway/types.js';

/**
 * The AI SDLC Factory suite (examples/ai-sdlc-factory-plan, ai-sdlc-factory, ai-sdlc-factory-readiness): every
 * package compiles with its tools and every write is behind a gate, and the scripts that decide (what a lap
 * picks, the readiness level, the epics a splitter receives) behave the same for GitHub and Jira, failing closed
 * on anything they cannot read.
 */
const PY = process.platform === 'win32' ? 'python' : 'python3';
const run = (pkg: string, script: string, input: unknown) => JSON.parse(execFileSync(PY, [join('examples', pkg, 'scripts', script)], { input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] }).toString());

const PACKAGES = ['ai-sdlc-factory-plan', 'ai-sdlc-factory', 'ai-sdlc-factory-readiness'];

describe('AI SDLC Factory packages', () => {
  for (const name of PACKAGES) {
    const dir = `examples/${name}`;
    const pkg = packageFromDirectory(dir);
    const tools = parse(readFileSync(`${dir}/azhi.config.yaml`, 'utf8')).tools;
    const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;

    it(`${name} compiles, and every write is behind a gate`, () => {
      const r = compile(def, { pkg, catalog: staticCatalog(tools) });
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.plan!.taint.paths.filter((p) => p.gate === null)).toEqual([]);
    });

    it(`${name} ships a source and a licence with every skill`, () => {
      const skills = join(dir, 'harness/skills');
      if (!existsSync(skills)) return;
      for (const s of readdirSync(skills)) for (const f of ['SKILL.md', 'LICENSE', 'SOURCE.md']) expect(existsSync(join(skills, s, f)), `${s}/${f}`).toBe(true);
    });
  }

  it('the lap writes only labels, each on the ticket it picked', () => {
    const pkg = packageFromDirectory('examples/ai-sdlc-factory');
    const tools = parse(readFileSync('examples/ai-sdlc-factory/azhi.config.yaml', 'utf8')).tools;
    const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;
    expect(compile(def, { pkg, catalog: staticCatalog(tools) }).ok).toBe(true);
    // The lap has no model step, so there is no taint path to read: check the guards on the writes directly.
    const writers = (def.nodes as any[]).filter((n) => (n.type === 'tool' && /label-issue|update-labels/.test(n.tool)) || n.type === 'notify');
    expect(writers.map((n) => n.id).sort()).toEqual(['claim_github', 'claim_jira', 'lap_post', 'sendback_github', 'sendback_jira']);
    for (const n of writers) expect(typeof n.guard, n.id).toBe('string');
    expect(tools.filter((t: any) => t.effect !== 'read').map((t: any) => t.id).sort()).toEqual(['github.label-issue', 'jira.update-labels']);
  });

  it('the release plan has no model step after the approval and no merge or close anywhere', () => {
    for (const name of PACKAGES) {
      const tools = parse(readFileSync(`examples/${name}/azhi.config.yaml`, 'utf8')).tools.map((t: any) => t.id);
      expect(tools.filter((id: string) => /merge|close|force/.test(id)), name).toEqual([]);
    }
  });
});

describe('pick.py: what a lap takes', () => {
  const config = { claim_label: 'factory-in-progress', owner_label: 'factory-needs-owner', priority_label: 'priority' };
  const gh = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `T${number}`, labels: ['ready'], parent: 0, slice: 0, depends: [], blocked: false, reason: '', in_flight: false, created_at: `2026-10-0${number % 9}T00:00:00Z`, ...extra });
  const pick = (queues: unknown[]) => run('ai-sdlc-factory', 'pick.py', { source: 'github', repo: 'acme/shop', config, github: { queues } });

  it('takes the priority ticket first, then the one that unblocks the most, then the oldest', () => {
    const items = [
      gh(11, { parent: 5, slice: 1, created_at: '2026-10-05T00:00:00Z' }),
      gh(12, { parent: 5, slice: 2, depends: [1], blocked: true, reason: 'waiting for #11' }),
      gh(13, { parent: 5, slice: 3, depends: [1], blocked: true, reason: 'waiting for #11' }),
      gh(14, { created_at: '2026-10-01T00:00:00Z' }),
      gh(15, { labels: ['ready', 'priority'], created_at: '2026-10-09T00:00:00Z' }),
    ];
    expect(pick([{ items }])).toMatchObject({ route: 'work', ticket: { ref: 'acme/shop#15', number: 15 }, reason: 'high priority' });
    const noPriority = items.filter((i) => i.number !== 15);
    const second = pick([{ items: noPriority }]);
    expect(second).toMatchObject({ route: 'work', ticket: { number: 11 }, reason: 'unblocks 2 other ticket(s)' });
    expect(second.skipped).toEqual([{ key: '#12', why: 'waiting for #11' }, { key: '#13', why: 'waiting for #11' }]);
    expect(pick([{ items: [gh(14), gh(16, { created_at: '2026-09-01T00:00:00Z' })] }])).toMatchObject({ ticket: { number: 16 }, reason: 'oldest workable ticket' });
  });

  it('skips a ticket a lap or a pull request already has, one waiting for its owner, and a duplicate across queues', () => {
    const r = pick([
      { items: [gh(1, { in_flight: true }), gh(2, { labels: ['ready', 'factory-needs-owner'] }), gh(3)] },
      { items: [gh(3), gh(4, { blocked: true, reason: 'the sub-issues of #9 could not be read' })] },
    ]);
    expect(r.ticket.number).toBe(3);
    expect(r.skipped).toEqual([
      { key: '#1', why: 'a lap or a pull request already has it' },
      { key: '#2', why: 'waiting for its owner' },
      { key: '#4', why: 'the sub-issues of #9 could not be read' },
    ]);
    expect(r.claim_labels).toEqual(['factory-in-progress']);
    expect(r.sendback_labels).toEqual(['factory-needs-owner']);
  });

  it('is idle, and says why, when nothing can be taken', () => {
    expect(pick([{ items: [] }])).toMatchObject({ route: 'idle', reason: 'the queue is empty', ticket: { key: '', number: 0 } });
    expect(pick([{ items: [gh(1, { in_flight: true })] }])).toMatchObject({ route: 'idle', reason: 'nothing is workable' });
  });

  describe('on Jira', () => {
    const issue = (key: string, extra: Record<string, unknown> = {}) => ({ key, summary: `S ${key}`, status: { name: 'To Do', category: 'To Do' }, priority: { name: 'Medium' }, labels: ['ready'], created: '2026-10-01', description: '', ...extra });
    const done = { name: 'Done', category: 'Done' };
    const body = (order: string) => `Part of PAY-1\n\n${order}`;
    const jira = (issues: unknown) => run('ai-sdlc-factory', 'pick.py', { source: 'jira', repo: 'acme/shop', config, jira: { issues } });

    it('frees a slice once the slice it waits for is done, and keeps the labels it already had', () => {
      const issues = [
        issue('PAY-2', { status: done, parent: { key: 'PAY-1' }, description: body('Slice 1 of 2. Independent: it can be built on its own.') }),
        issue('PAY-3', { labels: ['azhi-split', 'team'], parent: { key: 'PAY-1' }, description: body('Slice 2 of 2. Depends on slice 1: First. Do not start it before those are merged.') }),
      ];
      const r = jira(issues);
      expect(r).toMatchObject({ route: 'work', ticket: { source: 'jira', key: 'PAY-3', ref: 'PAY-3' } });
      expect(JSON.parse(r.claim_fields).labels).toEqual(['azhi-split', 'factory-in-progress', 'team']);
      expect(JSON.parse(r.sendback_fields).labels).toEqual(['azhi-split', 'factory-in-progress', 'factory-needs-owner', 'team']);
      expect(r.skipped).toEqual([{ key: 'PAY-2', why: 'already done' }]);
    });

    it('blocks on an open slice, a slice missing from the results, an unreadable status and a blocking link', () => {
      const dep = (n: number) => body(`Slice ${n} of 3. Depends on slice 1: First. Do not start it before those are merged.`);
      const issues = [
        issue('PAY-2', { parent: { key: 'PAY-1' }, description: body('Slice 1 of 3. Independent: it can be built on its own.') }),
        issue('PAY-3', { parent: { key: 'PAY-1' }, description: dep(2) }),
        issue('PAY-4', { parent: { key: 'PAY-1' }, description: body('Slice 3 of 3. Depends on slice 7: Gone. Do not start it before those are merged.') }),
        issue('PAY-5', { issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by' }, inward_issue: { key: 'PAY-9', status: { name: 'In Progress', category: 'In Progress' } } }] }),
        issue('PAY-6', { issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by' }, inward_issue: { key: 'PAY-8' } }] }),
        issue('PAY-7', { status: undefined }),
      ];
      const r = jira(issues);
      expect(r.ticket.key).toBe('PAY-2');
      const why = Object.fromEntries(r.skipped.map((s: any) => [s.key, s.why]));
      expect(why['PAY-3']).toBe('waiting for slice 1');
      expect(why['PAY-4']).toContain('slice 7 not found');
      expect(why['PAY-5']).toBe('blocked by PAY-9');
      expect(why['PAY-6']).toBe('blocked by PAY-8 (status unreadable)');
      expect(why['PAY-7']).toBe('status unreadable');
    });

    it('treats high priority as first, and a search it cannot read as idle', () => {
      expect(jira([issue('PAY-2'), issue('PAY-3', { priority: { name: 'High' }, created: '2026-10-09' })]).ticket.key).toBe('PAY-3');
      expect(run('ai-sdlc-factory', 'pick.py', { source: 'jira', repo: 'acme/shop', config, jira: { issues: null } })).toMatchObject({ route: 'idle', reason: 'the Jira search returned nothing readable' });
    });
  });
});

describe('outcome.py', () => {
  it('reports a pull request, or a send-back when the delivery ended without one', () => {
    const shipped = run('ai-sdlc-factory', 'outcome.py', { child: { run_id: 'r1', state: 'succeeded', nodes: { open_pr: { url: 'https://github.com/acme/shop/pull/7', number: 7, draft: true }, finalize: { change: { summary: 'Added it', tests: { status: 'passed' } }, needs_human_attention: true } } } });
    expect(shipped).toMatchObject({ status: 'shipped', pr_url: 'https://github.com/acme/shop/pull/7', pr_number: 7, draft: true, tests: 'passed', needs_attention: true });
    expect(run('ai-sdlc-factory', 'outcome.py', { child: { run_id: 'r2', nodes: { finalize: { change: { tests: { status: 'failed' } } } } } })).toMatchObject({ status: 'sent_back', pr_url: '', tests: 'failed' });
    expect(run('ai-sdlc-factory', 'outcome.py', { child: {} })).toMatchObject({ status: 'sent_back', tests: 'unavailable' });
  });
});

describe('score.py: the readiness level', () => {
  const exists = (...paths: string[]) => ({ files: paths.map((path) => ({ path, exists: true, kind: path.endsWith('workflows') ? 'dir' : 'file', entries: path.endsWith('workflows') ? ['ci.yml'] : [] })) });
  const all = exists('README.md', '.github/CODEOWNERS', '.github/PULL_REQUEST_TEMPLATE.md', '.github/workflows');
  const runs = (status: string) => [{ id: 'acme/shop#1', status, branch: 'dev', started_at: '2026-10-30T00:00:00Z', failed_tests: status === 'failure' ? ['backend'] : [] }];
  const score = (input: Record<string, unknown>) => run('ai-sdlc-factory-readiness', 'score.py', { repo: 'acme/shop', base_branch: 'dev', open_tickets: [], labels: ['ci-failing', 'ready', 'priority'], ...input });

  it('is gold only when CI is green on the base branch', () => {
    expect(score({ files: all, runs: runs('success') })).toMatchObject({ level: 'gold', propose_fix: false });
    const red = score({ files: all, runs: runs('failure') });
    expect(red).toMatchObject({ level: 'silver', propose_fix: true, failed_jobs: ['backend'], ci_status: 'failure' });
    expect(red.ticket).toMatchObject({ title: 'CI is failing on dev', labels: ['ci-failing', 'ready', 'priority'] });
    expect(JSON.parse(red.ticket.additional_fields)).toEqual({ labels: ['ci-failing', 'ready', 'priority'] });
    expect(red.ticket.body).toContain('- backend');
  });

  it('never counts missing CI data as a pass, and judges only the base branch', () => {
    expect(score({ files: all, runs: [] })).toMatchObject({ level: 'silver', ci_status: 'unavailable', has_unavailable: true, propose_fix: false });
    const other = [{ ...runs('failure')[0], branch: 'feature' }];
    expect(score({ files: all, runs: other })).toMatchObject({ level: 'silver', ci_status: 'unavailable', propose_fix: false });
  });

  it('grades bronze and none from the files', () => {
    expect(score({ files: exists('README.md', 'CODEOWNERS'), runs: [] })).toMatchObject({ level: 'bronze', failing: ['A pull request template exists', 'A CI workflow exists'] });
    expect(score({ files: exists('README.md'), runs: runs('success') })).toMatchObject({ level: 'none' });
    expect(score({ files: { files: [{ path: '.github/workflows', exists: true, kind: 'dir', entries: ['notes.txt'] }] }, runs: [] }).checks.find((c: any) => c.id === 'ci_workflow').status).toBe('fail');
  });

  it('proposes one fix only when no ticket is open and the lookup could be read', () => {
    expect(score({ files: all, runs: runs('failure'), open_tickets: [{ key: 'PAY-9' }] })).toMatchObject({ propose_fix: false, open_tickets: 1, ticket: null });
    const unknown = score({ files: all, runs: runs('failure'), open_tickets: null });
    expect(unknown).toMatchObject({ propose_fix: false, has_unavailable: true });
    expect(unknown.unavailable).toContain('Whether a ticket is already open for the failing CI');
  });
});

describe('plan scripts', () => {
  it('joins a ticket and a goal into one brief, and refuses an empty request', () => {
    const b = run('ai-sdlc-factory-plan', 'brief.py', { ticket: { source: 'jira', key: 'PAY-1', title: 'Checkout', description: 'Pay by card' }, goal: 'Ship it by Q4' });
    expect(b).toMatchObject({ kind: 'ticket', source: 'jira', key: 'PAY-1', title: 'Checkout' });
    expect(b.text).toBe('PAY-1 Checkout\n\nPay by card\n\nDirection from the requester:\nShip it by Q4');
    expect(run('ai-sdlc-factory-plan', 'brief.py', { ticket: null, goal: '\n  Build a shop\nwith carts' })).toMatchObject({ kind: 'text', title: 'Build a shop', key: '' });
    expect(() => run('ai-sdlc-factory-plan', 'brief.py', { ticket: null, goal: ' ' })).toThrow();
  });

  const prd = {
    title: 'Shop',
    summary: 'A small shop',
    invariants: ['Orders are never lost'],
    journeys: [{ name: 'Buy', steps: ['Add to cart', 'Pay'] }],
    non_goals: ['Marketplace'],
    walking_skeleton: 'Cart to receipt',
    epics: [
      { title: 'Cart', goal: 'Carts work', scope: ['cart api'], acceptance_criteria: ['Add an item'], depends_on_note: '' },
      { title: 'Pay', goal: 'Payments', scope: ['pay api'], acceptance_criteria: ['Pay by card'], depends_on_note: 'Needs epic 1 merged first' },
      { title: 'Ship', goal: 'Shipping', scope: ['ship api'], acceptance_criteria: ['Track a parcel'], depends_on_note: '' },
    ],
  };

  it('writes each epic with the release context, keeps the plan numbering, and drops what the approver left out', () => {
    const all = run('ai-sdlc-factory-plan', 'epics.py', { prd, drop: '' });
    expect(all.count).toBe(3);
    expect(all.epics[0].text).toContain('Orders are never lost');
    expect(all.epics[0].text).toContain('# Epic 1: Cart');
    expect(all.epics[0].text).toContain('## Walking skeleton');
    expect(all.epics[1].text).toContain('Needs epic 1 merged first');
    expect(all.epics[1].text).not.toContain('## Walking skeleton');
    const some = run('ai-sdlc-factory-plan', 'epics.py', { prd, drop: '1, 3' });
    expect(some).toMatchObject({ count: 1, dropped: [1, 3] });
    expect(some.epics[0]).toMatchObject({ n: 2, title: 'Pay' });
  });

  it('cuts an epic to the splitter limit and says so', () => {
    const big = { ...prd, epics: [{ ...prd.epics[0], goal: 'x'.repeat(30000) }] };
    const r = run('ai-sdlc-factory-plan', 'epics.py', { prd: big, drop: '' });
    expect(r.epics[0].text.length).toBe(19000);
    expect(r.epics[0].truncated).toBe(true);
  });

  it('says whether the next epic exists', () => {
    expect(run('ai-sdlc-factory-plan', 'gate.py', { count: 2, n: 2 })).toEqual({ proceed: true });
    expect(run('ai-sdlc-factory-plan', 'gate.py', { count: 1, n: 2 })).toEqual({ proceed: false });
  });
});
