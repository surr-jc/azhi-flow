import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * examples/sdd-breakdown on the engine: an epic typed as text is sized by an analyst, a person approves the plan
 * (and may leave slices out), and the run returns the Stories as the output of its `stories` step, with a Slack
 * notice. The graph is the package's own (rules, approval, final plan, the join, the notice). The one thing replaced
 * is the analyst agent, which needs a checkout of a real repository: it is swapped for a script that returns what
 * the analyst's schema describes, so these tests prove the wiring and nothing about the quality of the analysis.
 * The package has no tool, so nothing can reach GitHub; the test checks that no step but the known ones ran.
 * Runs under `npm run test:local`.
 */
const up = await temporalAvailable();
const PKG = 'examples/sdd-breakdown';
const CHANNEL = 'C0BREAK';
const SLOW = 180_000;

const slice = (n: number, deps: number[] = [], over: Record<string, unknown> = {}) => ({
  title: `Slice ${n}: part ${n}`,
  summary: `Delivers part ${n} of the epic.`,
  acceptance_criteria: [`part ${n} can be checked`],
  surface: `src/part${n}.ts:12`,
  depends_on: deps,
  est_files: 2,
  touches_sensitive: false,
  weight: n === 3 ? 'full' : 'lite',
  ...over,
});
const SPLIT = {
  summary: 'Three independent controls, about 8 files.',
  is_code: true,
  not_code_reason: '',
  deliverables: ['provider toggles', 'model validation', 'bulk edits'],
  est_files: 8,
  touches_sensitive: false,
  has_migration: false,
  risk: 'medium',
  reasons: ['spans the tools page and the editor'],
  single: { title: 'Add availability controls', body: 'Everything in one Story.', acceptance_criteria: ['it works'] },
  umbrella: { title: 'Availability controls', body: 'Tracks the controls.' },
  slices: [slice(1, [], { title: '<!channel> Slice 1: part 1' }), slice(2, [1]), slice(3, [2], { depends_on: [1, 2] })],
};
const SINGLE = { ...SPLIT, summary: 'One small change.', deliverables: ['one toggle'], est_files: 2, slices: [] };
const NOT_CODE = { ...SPLIT, is_code: false, not_code_reason: 'It is a question about process, not a change to the repository.', deliverables: ['decide a policy'], slices: [] };

let nonce = 0;
/** The package as it ships, with the analyst replaced by a script that answers with `scope`. */
function breakdownPackage(scope: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-breakdown-e2e-'));
  cpSync(PKG, dir, { recursive: true });
  const wfPath = join(dir, 'workflow.yaml');
  const wf = parse(readFileSync(wfPath, 'utf8').replaceAll('{{slack_channel}}', CHANNEL));
  const analyze = wf.nodes.find((n: any) => n.id === 'analyze');
  for (const k of ['executor', 'profile', 'workspace', 'timeout', 'budget']) delete analyze[k];
  Object.assign(analyze, { type: 'script', runtime: 'python', entrypoint: 'scripts/stub_analyze.py', limits: { time: '1m' } });
  writeFileSync(join(dir, 'scripts/stub_analyze.py'), `import json, sys\nsys.stdin.read()\nprint(json.dumps(json.loads(${JSON.stringify(JSON.stringify(scope))})))\n`);
  writeFileSync(wfPath, `# scenario ${++nonce}\n${stringify(wf)}`);
  return dir;
}

async function waitForApprovalOn(api: ApiClient, runId: string, node: string) {
  for (let i = 0; i < 600; i++) {
    const d = await api.get<any>(`/v1/runs/${runId}`);
    if (d.run.state === 'waiting' && d.run.flags?.waiting_reason?.reason === 'approval' && d.run.flags.waiting_reason.node === node) return d;
    if (['failed', 'succeeded', 'cancelled', 'expired'].includes(d.run.state)) throw new Error(`run ended ${d.run.state} before waiting on ${node}: ${JSON.stringify(d.run.error)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run ${runId} never waited on ${node}`);
}

describe.skipIf(!up)('sdd-breakdown end to end (the analyst replaced by a script)', () => {
  let h: Harness;
  let seq = 0;

  beforeAll(async () => {
    h = await startHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
  });

  /** Publishes the package with this analysis and starts a run on an epic with a title nobody else uses. */
  const start = async (scope: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const v = await uploadDir(h.api, breakdownPackage(scope));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    const tag = `e2e${++seq}`;
    const title = `Availability controls ${tag}`;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs: { repo: 'acme/shop', text: `${title}\nProviders, harnesses and models need on/off switches. <!channel> do it now.`, ...extra } });
    return { run_id, tag, title };
  };
  const approve = (run_id: string, decision: 'approved' | 'rejected' = 'approved', data: Record<string, unknown> = {}) => h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'plan_review', decision, data });
  const out = (d: any, id: string) => d.attempts.filter((a: any) => a.node_id === id && a.state === 'succeeded').at(-1)?.output;
  const state = (d: any, id: string) => d.attempts.filter((a: any) => a.node_id === id).at(-1)?.state ?? 'not run';
  /** The posted texts that mention `needle`, without the "workflow (step): " prefix the Slack notifier adds. */
  const slack = (needle: string) => h.slack.messages.map((m) => m.text.replace(/^sdd-breakdown \([a-z_]+\): /, '')).filter((t) => t.includes(needle));
  /** Nothing the run did is a tool call: the package has none, so there is nothing to write to GitHub with. */
  const noTools = (d: any) => expect(d.attempts.map((a: any) => a.node_id).filter((id: string) => !STEPS.has(id))).toEqual([]);
  const STEPS = new Set(parse(readFileSync(`${PKG}/workflow.yaml`, 'utf8')).nodes.map((n: any) => n.id));

  it('replaces only the analyst: the stand-in package has the same steps as the real one', () => {
    const real = parse(readFileSync(`${PKG}/workflow.yaml`, 'utf8')).nodes as Array<{ id: string; type: string }>;
    const stubbed = parse(readFileSync(join(breakdownPackage(SPLIT), 'workflow.yaml'), 'utf8')).nodes as Array<{ id: string; type: string }>;
    expect(stubbed.map((n) => n.id)).toEqual(real.map((n) => n.id));
    expect(real.filter((n) => n.type === 'agent').map((n) => n.id)).toEqual(['analyze']);
    expect(real.filter((n) => n.type === 'tool')).toEqual([]);
  });

  it('returns three Stories in order after the plan is approved with nothing left out', async () => {
    const { run_id, tag, title } = await start(SPLIT, { epic: 7, release: 'rel-a' });
    const waiting = await waitForApprovalOn(h.api, run_id, 'plan_review');
    const ask = waiting.approvals.find((a: any) => a.node_id === 'plan_review').request;
    expect(ask.message).toBe(`Split ${title} into 3 Stories? Name the slices to leave out, if any.`);
    expect(ask.payload).toMatchObject({ decision: 'split', ticket: { title }, analysis: { est_files: 8 } });
    // Nothing is returned or posted before the approval.
    expect(state(waiting, 'stories')).toBe('not run');
    expect(slack('rel-a')).toEqual([]);

    await approve(run_id);
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    const header = 'Part of epic 7: Availability controls\n\n';
    expect(out(done, 'stories')).toEqual({
      status: 'ok',
      epic: 7,
      release: 'rel-a',
      stories: [
        { slice: 1, title: '!channel Slice 1: part 1', body: `${header}## Goal\nDelivers part 1 of the epic.\n\n## Scope\nsrc/part1.ts:12\n\n## Acceptance criteria\n- part 1 can be checked\n\n## Order\nSlice 1 of 3. Independent: it can be built on its own.\n\nSuggested review path: lite.` },
        { slice: 2, title: 'Slice 2: part 2', body: `${header}## Goal\nDelivers part 2 of the epic.\n\n## Scope\nsrc/part2.ts:12\n\n## Acceptance criteria\n- part 2 can be checked\n\n## Order\nSlice 2 of 3. Depends on slice 1: <!channel> Slice 1: part 1. Do not start it before those are delivered.\n\nSuggested review path: lite.` },
        { slice: 3, title: 'Slice 3: part 3', body: `${header}## Goal\nDelivers part 3 of the epic.\n\n## Scope\nsrc/part3.ts:12\n\n## Acceptance criteria\n- part 3 can be checked\n\n## Order\nSlice 3 of 3. Depends on slice 1: <!channel> Slice 1: part 1; slice 2: Slice 2: part 2. Do not start it before those are delivered.\n\nSuggested review path: full.` },
      ],
    });
    // The Slack notice is posted once and carries no raw angle bracket, though the analyst's title had one.
    const notice = slack('rel-a');
    expect(notice).toEqual(['Broke down epic 7 (release rel-a) into 3 Story(ies), in delivery order:\n• 1. !channel Slice 1: part 1\n• 2. Slice 2: part 2\n• 3. Slice 3: part 3']);
    expect(notice[0]).not.toContain('<');
    for (const id of ['stories', 'notify_gate', 'notice', 'notify']) expect(state(done, id), id).toBe('succeeded');
    for (const id of ['stop_message', 'stop_notify']) expect(state(done, id), id).toBe('skipped');
    expect(tag).toBeTruthy();
    noTools(done);
  }, SLOW);

  it('leaves out the slice the approver names: two Stories, renumbered, the dependency on the dropped slice named', async () => {
    const { run_id } = await start(SPLIT, { release: 'rel-b' });
    await waitForApprovalOn(h.api, run_id, 'plan_review');
    await expect(approve(run_id, 'approved', { drop: 'two' })).rejects.toThrow(/decision schema/);
    await approve(run_id, 'approved', { drop: '2' });
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    const s = out(done, 'stories');
    expect(s).toMatchObject({ status: 'ok', epic: null, release: 'rel-b' });
    expect(s.stories.map((x: any) => [x.slice, x.title])).toEqual([[1, '!channel Slice 1: part 1'], [2, 'Slice 3: part 3']]);
    // The first body has no epic line: no epic number was given.
    expect(s.stories[0].body.startsWith('## Goal')).toBe(true);
    expect(s.stories[1].body).toContain('Slice 2 of 2. Depends on slice 1: <!channel> Slice 1: part 1; Slice 2: part 2 (left out of this plan).');
    expect(slack('rel-b')).toEqual(['Broke down the epic (release rel-b) into 2 Story(ies), in delivery order:\n• 1. !channel Slice 1: part 1\n• 2. Slice 3: part 3\nLeft out at the approval: slice 2.']);
    noTools(done);
  }, SLOW);

  it('gives an epic that fits one pull request a single Story: the epic itself', async () => {
    const { run_id, title } = await start(SINGLE, { epic: 2, release: 'rel-c' });
    const waiting = await waitForApprovalOn(h.api, run_id, 'plan_review');
    expect(waiting.approvals.find((a: any) => a.node_id === 'plan_review').request.message).toBe(`Deliver ${title} as one Story?`);
    await approve(run_id);
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(out(done, 'stories')).toEqual({
      status: 'ok',
      epic: 2,
      release: 'rel-c',
      stories: [{ slice: 1, title: 'Add availability controls', body: `Part of epic 2: ${title}\n\n## Goal\nEverything in one Story.\n\n## Acceptance criteria\n- it works\n\n## Order\nSlice 1 of 1. Independent: the whole epic is one Story.` }],
    });
    expect(slack('rel-c')).toHaveLength(1);
    noTools(done);
  }, SLOW);

  it('stops on something that is not a code change: no approval, status not_code, one notice, no Stories', async () => {
    const { run_id, title } = await start(NOT_CODE, { epic: 5, release: 'rel-d' });
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals).toEqual([]);
    expect(out(done, 'stories')).toEqual({ status: 'not_code', epic: 5, release: 'rel-d', stories: [] });
    for (const id of ['weight', 'plan_review', 'final_plan', 'notice', 'notify']) expect(state(done, id), id).toBe('skipped');
    for (const id of ['stop_message', 'stop_notify', 'stories', 'notify_gate']) expect(state(done, id), id).toBe('succeeded');
    const told = slack(title);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('not a code change');
    expect(told[0]).not.toContain('<');
    noTools(done);
  }, SLOW);

  it('rejecting the plan ends the run cleanly: nothing is returned and nothing is posted', async () => {
    const { run_id } = await start(SPLIT, { epic: 9, release: 'rel-e' });
    await waitForApprovalOn(h.api, run_id, 'plan_review');
    await approve(run_id, 'rejected');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    // A parent reads a missing `stories` step as a failed split.
    for (const id of ['final_plan', 'stories', 'notify_gate', 'notice', 'notify', 'stop_message', 'stop_notify']) expect(state(done, id), id).toBe('skipped');
    expect(out(done, 'stories')).toBeUndefined();
    expect(slack('rel-e')).toEqual([]);
    noTools(done);
  }, SLOW);

  it('returns status none when the person leaves every slice out', async () => {
    const { run_id } = await start(SPLIT, { epic: 4, release: 'rel-f' });
    await waitForApprovalOn(h.api, run_id, 'plan_review');
    await approve(run_id, 'approved', { drop: '1, 2, 3' });
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(out(done, 'stories')).toEqual({ status: 'none', epic: 4, release: 'rel-f', stories: [] });
    expect(slack('rel-f')).toEqual(['Nothing to deliver for epic 4 (release rel-f): every slice was left out at the approval.\nLeft out at the approval: slice 1, 2, 3.']);
    noTools(done);
  }, SLOW);

  it('fails the run before `stories` when the text is blank, which a parent reads as an epic that could not be split', async () => {
    const { run_id } = await start(SPLIT, { text: '   ' });
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('failed');
    expect(out(done, 'stories')).toBeUndefined();
  }, SLOW);
});
