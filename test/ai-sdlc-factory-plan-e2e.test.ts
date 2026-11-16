import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * ai-sdlc-factory-plan on the engine, with scripted models: brainstorm, the person's answers, the release plan, its
 * approval, and the hand-off of each remaining epic to the splitter. The two agents run on the scripted provider
 * (no workspace, no OpenCode) and the splitters are small stand-ins that echo the epic text they receive, so the test
 * needs no model, no GitHub and no Slack. Runs under `npm run test:local`.
 */
const up = await temporalAvailable();
const PKG = 'examples/ai-sdlc-factory-plan';

const brainstorm = {
  summary: 'Customers cannot pay by card yet.',
  questions: [
    { question: 'Which countries must be supported?', why: 'Decides the payment provider.' },
    { question: 'Are refunds in scope?', why: 'Changes the size of the first epic.' },
  ],
  approaches: [
    { name: 'Walking skeleton first', delivers: 'One card payment end to end.', cost: 'Little polish.', leaves_out: 'Refunds', recommended: true, reason: 'Smallest path a user can walk.', counter: 'Rework later.' },
    { name: 'Full checkout', delivers: 'Everything at once.', cost: 'Slow.', leaves_out: 'Nothing', recommended: false },
  ],
  assumptions: ['Cards only'],
  unknowns: ['Which provider'],
};

const prd = {
  title: 'Pay by card',
  summary: 'Customers can pay by card.',
  problem: 'Customers cannot pay.',
  owner: { value: null, evidence: 'No CODEOWNERS found' },
  goals: ['Take a card payment'],
  non_goals: ['Refunds'],
  invariants: ['An order is never charged twice'],
  journeys: [{ name: 'Checkout', steps: ['Add to cart', 'Pay', 'See receipt'] }],
  risks: [],
  open_questions: [],
  walking_skeleton: 'cart -> pay -> receipt',
  epics: [
    { title: 'Take a card payment', goal: 'A card payment succeeds.', scope: ['src/pay'], acceptance_criteria: ['A card payment succeeds'], depends_on_note: '' },
    { title: 'Send receipts', goal: 'Email a receipt.', scope: ['src/mail'], acceptance_criteria: ['A receipt is emailed'], depends_on_note: 'Needs the first epic merged' },
  ],
};

/** The plan package with both agents on the scripted provider and without a repository checkout. */
function scriptedPlan(): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-plan-e2e-'));
  cpSync(PKG, dir, { recursive: true });
  const wfPath = join(dir, 'workflow.yaml');
  const wf = parse(readFileSync(wfPath, 'utf8'));
  for (const n of wf.nodes) if (n.type === 'agent') (delete n.executor, delete n.workspace);
  writeFileSync(wfPath, stringify(wf));
  const script = (profile: string, output: unknown) =>
    writeFileSync(join(dir, `profiles/${profile}.yaml`), JSON.stringify({ ...parse(readFileSync(`${PKG}/profiles/${profile}.yaml`, 'utf8')), model: { provider: 'scripted' }, script: [{ output }] }));
  script('brainstormer@1', brainstorm);
  script('release-planner@1', prd);
  return dir;
}

/** A stand-in splitter: same id and inputs as the published one, it only echoes the text it was given. */
function stubSplitter(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-splitter-stub-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(
    join(dir, 'workflow.yaml'),
    `schema_version: "2.0"
id: ${id}
inputs:
  type: object
  properties:
    repo: {type: string}
    text: {type: string}
    base_branch: {type: string}
    project: {type: string}
  required: [repo, text]
nodes:
  - id: echo
    type: script
    runtime: python
    entrypoint: scripts/echo.py
    input: {map: "{'text': inputs.text}"}
    output_schema: {type: object, properties: {text: {type: string}}, required: [text]}
`,
  );
  writeFileSync(join(dir, 'scripts/echo.py'), 'import json, sys\nd = json.load(sys.stdin)\nprint(json.dumps({"text": d["text"]}))\n');
  return dir;
}

async function waitForApprovalOn(api: ApiClient, runId: string, node: string) {
  for (let i = 0; i < 300; i++) {
    const d = await api.get<any>(`/v1/runs/${runId}`);
    if (d.run.state === 'waiting' && d.run.flags?.waiting_reason?.reason === 'approval' && d.run.flags.waiting_reason.node === node) return d;
    if (['failed', 'succeeded', 'cancelled', 'expired'].includes(d.run.state)) throw new Error(`run ended ${d.run.state} before waiting on ${node}: ${JSON.stringify(d.run.error)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run ${runId} never waited on ${node}`);
}

describe.skipIf(!up)('ai-sdlc-factory-plan end to end (scripted models)', () => {
  let h: Harness;
  let version: string;
  const inputs = { source: 'github', repo: 'acme/shop', base_branch: 'dev', goal: 'Let customers pay by card' };

  beforeAll(async () => {
    h = await startHarness();
    for (const t of parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools) await h.api.post('/v1/tools', t);
    // The goal-only path reads no ticket, but the run plan wants every tool's credential present.
    for (const name of ['github-read-token', 'jira-api-token']) await h.api.put(`/v1/secrets/${name}`, { value: 'unused' });
    for (const id of ['issue-splitter', 'issue-splitter-jira']) {
      const v = await uploadDir(h.api, stubSplitter(id));
      expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
      await h.api.post(`/v1/versions/${v.version.id}/publish`, {});
    }
    const v = await uploadDir(h.api, scriptedPlan());
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    version = v.version.id;
  });
  afterAll(async () => h?.stop());

  it('brainstorms with a person, plans from their answers, and splits only the epics they keep', async () => {
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs });

    // 1. The brainstorm waits for a person with the questions and the approaches; nothing is planned yet.
    const asked = await waitForApprovalOn(h.api, run_id, 'brainstorm_review');
    expect(asked.approvals[0].request.payload).toMatchObject({ questions: brainstorm.questions, assumptions: ['Cards only'], unknowns: ['Which provider'] });
    expect(asked.approvals[0].request.payload.approaches.map((a: any) => a.name)).toEqual(['Walking skeleton first', 'Full checkout']);
    expect(asked.attempts.find((a: any) => a.node_id === 'plan_release')?.state ?? 'pending').toBe('pending');
    // An approval without an approach is refused by the decision schema.
    await expect(h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'brainstorm_review', decision: 'approved', data: { answers: 'UK only' } })).rejects.toThrow(/decision schema/);
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'brainstorm_review', decision: 'approved', data: { approach: 'Walking skeleton first', answers: '1. UK only. 2. No refunds.' } });

    // 2. Only now is the plan written; a person approves it and leaves the second epic out.
    const review = await waitForApprovalOn(h.api, run_id, 'prd_review');
    expect(review.attempts.find((a: any) => a.node_id === 'plan_release')).toMatchObject({ state: 'succeeded', output: { title: 'Pay by card', owner: { value: null } } });
    expect(review.approvals.find((a: any) => a.node_id === 'brainstorm_review')).toMatchObject({ decision: 'approved', data: { approach: 'Walking skeleton first' } });
    expect(review.approvals.find((a: any) => a.node_id === 'prd_review').request.payload.epics).toEqual(['Take a card payment', 'Send receipts']);
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'prd_review', decision: 'approved', data: { drop: '2' } });

    // 3. One epic reaches the GitHub splitter, with the release context in front; nothing goes to Jira or for epic 2.
    const done = await waitForRun(h.api, run_id, 90_000);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    const state = (id: string) => done.attempts.find((a: any) => a.node_id === id)?.state;
    expect(state('split_1_github')).toBe('succeeded');
    for (const id of ['split_1_jira', 'split_2_github', 'split_2_jira', 'split_3_github', 'split_3_jira']) expect(state(id), id).not.toBe('succeeded');
    const epics = done.attempts.find((a: any) => a.node_id === 'epics').output;
    expect(epics).toMatchObject({ count: 1, dropped: [2] });
    const split = done.attempts.find((a: any) => a.node_id === 'split_1_github' && a.state === 'succeeded').output;
    expect(split.workflow).toBe('issue-splitter');
    const received = split.nodes.echo.text as string;
    expect(received).toContain('An order is never charged twice');
    expect(received).toContain('Checkout: Add to cart -> Pay -> See receipt');
    expect(received).toContain('A card payment succeeds');
    expect(received).not.toContain('A receipt is emailed');
  });

  it('plans nothing and creates nothing when the person rejects the brainstorm', async () => {
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs });
    await waitForApprovalOn(h.api, run_id, 'brainstorm_review');
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'brainstorm_review', decision: 'rejected' });
    const done = await waitForRun(h.api, run_id);
    expect(done.run.state).toBe('succeeded');
    for (const id of ['plan_release', 'prd_review', 'epics', 'split_1_github']) expect(done.attempts.find((a: any) => a.node_id === id)?.state, id).toBe('skipped');
    expect(done.approvals.map((a: any) => a.node_id)).toEqual(['brainstorm_review']);
  });
});
