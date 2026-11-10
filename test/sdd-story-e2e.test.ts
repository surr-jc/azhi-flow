import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGithub } from '../src/testing/fake-github.js';
import type { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * examples/sdd-story on the engine: one Story from a ticket to a signed-off pull request, with a stand-in for
 * `pr-review` as its child run. The graph is the package's own (routes, joins, approvals, the pushes and the pull
 * request on a stand-in for GitHub, the label, Slack, `result`). What is replaced is every agent that needs a checkout:
 * OpenCode cannot run on every host (the worker needs memory limits it cannot always enforce), and what the agents
 * write is covered elsewhere. Each is swapped for a script that returns what the agent's schema describes, so these
 * tests prove the wiring and nothing about the quality of the agents' work. Runs under `npm run test:local`.
 */
const up = await temporalAvailable();
const PKG = 'examples/sdd-story';
const REPO = 'acme/shop';
const CHANNEL = 'C0STORY';
const READ_TOKEN = 'ghp_read_story_1';
const WRITE_TOKEN = 'ghp_write_story_2';
const BASE_SHA = 'b'.repeat(40);
const LABEL = 'sdd-signed-off';

type ReviewKind = 'approved' | 'findings' | 'fail';
interface Scenario {
  /** Does the first proposal pass its check, and the revised one. */
  check1: boolean;
  check2: boolean;
  /** The worker's test result for the build, and for the fix round. */
  tests: 'passed' | 'failed';
  fixTests: 'passed' | 'failed';
  review: ReviewKind;
  /** The open questions the spec author raises, the spec reviewer's report, and the verifier's issues. */
  questions?: Array<{ question: string; recommendation: string; why: string }>;
  specReview?: Record<string, unknown>;
  verifyIssues?: Array<Record<string, unknown>>;
}
const HAPPY: Scenario = { check1: true, check2: true, tests: 'passed', fixTests: 'passed', review: 'approved' };
const QUESTION = { question: 'Round up or down?', recommendation: 'Round half up to 2 places.', why: 'Totals are in cents' };
const CRITICAL_ISSUE = { level: 'CRITICAL', dimension: 'correctness', issue: 'The discount can exceed the price', recommendation: 'Clamp it' };

const file = (path: string, content: string, status = 'added') => ({ path, status, content, additions: content.split('\n').length - 1, deletions: 0 });
const PROPOSAL = file('openspec/changes/discount/proposal.md', '# Discount\n');
const SRC = file('src/cart.js', 'export const total = 1;\n', 'modified');
const SRC_FIXED = file('src/cart.js', 'export const total = 2;\n', 'modified');
const SPEC = file('openspec/specs/cart/spec.md', '# cart\n');
const ARCHIVED = file('openspec/changes/archive/2026-11-10-discount/proposal.md', '# Discount\n');
const ARCHIVE_FILES = [SRC, SPEC, ARCHIVED];
const FIX_FILES = [SRC_FIXED, SPEC, ARCHIVED];
const contents = (files: typeof ARCHIVE_FILES) => Object.fromEntries(files.map((f) => [f.path, f.content]));

const workspace = (files: Array<ReturnType<typeof file>>, tests?: { status: string; attempts: number }) => ({
  repo: REPO,
  base_sha: BASE_SHA,
  files,
  ...(tests ? { tests: { status: tests.status, exit_code: tests.status === 'passed' ? 0 : 1, attempts: tests.attempts } } : {}),
  stats: { files: files.length },
  diff: 'diff --git a/src/cart.js b/src/cart.js\n',
});
const check = (ok: boolean) => ({ ok, errors: ok ? [] : ['Requirement has no scenario'], warnings: [], deltas: [{ capability: 'cart', op: 'ADDED', requirement: 'Totals apply the discount' }], capabilities: ['cart'] });
const proposal = (content: string, questions: unknown[] = []) => ({ summary: 'Discount spec', change_id: 'discount', bootstrapped: false, capabilities: ['cart'], open_questions: questions, conflicts: [], workspace: workspace([{ ...PROPOSAL, content }]) });

/** What each agent (and each checker that reads a checkout) answers, by step id. */
function answers(s: Scenario): Record<string, unknown> {
  return {
    scan: { has_openspec: true, has_config: true, has_specs: true, capabilities: [{ name: 'cart', requirements: ['Totals apply the discount'] }], active_changes: [], rules: [] },
    propose: proposal('first', s.questions),
    check_1: check(s.check1),
    revise: proposal('revised', s.questions),
    check_2: check(s.check2),
    spec_review: { summary: 'Specs are testable.', approved: true, prompt_injection_detected: false, findings: [], ...s.specReview },
    apply: {
      summary: 'total() applies the discount',
      commit_message: 'fix(cart): apply the discount\n\nTotals ignored it.',
      pr_title: 'fix(cart): apply the discount',
      pr_body: '## Summary\nApply the discount.',
      tasks_done: ['UPDATE src/cart.js'],
      tests_added: ['10% off 20 is 18'],
      deviations: [],
      risks: [],
      workspace: workspace([SRC, PROPOSAL], { status: s.tests, attempts: 2 }),
    },
    verify: { summary: 'Every requirement is implemented.', prompt_injection_detected: false, requirements: [], tasks_unticked: [], issues: s.verifyIssues ?? [] },
    archive: { summary: 'Merged the cart delta.', merged: [{ capability: 'cart', added: 1, modified: 0, removed: 0, renamed: 0 }], workspace: workspace(ARCHIVE_FILES) },
    archive_check: check(true),
    fix: { summary: 'Clamp the discount', fixed: ['No clamp'], skipped: [], prompt_injection_detected: false, workspace: workspace(FIX_FILES, { status: s.fixTests, attempts: 1 }) },
  };
}

const python = (value: unknown) => `import json, sys\nsys.stdin.read()\nprint(json.dumps(json.loads(${JSON.stringify(JSON.stringify(value))})))\n`;
/** The build stand-in also echoes the decisions the engineer was handed, so a test can read what reached it. */
const echoing = (value: unknown) => `import json, sys\ngiven = json.load(sys.stdin)\nout = json.loads(${JSON.stringify(JSON.stringify(value))})\nout['received_decisions'] = given.get('decisions')\nprint(json.dumps(out))\n`;

/** An agent's schema with the checkout the worker would have added: the same fields, no `additionalProperties: false`. */
const WORKSPACE_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string' },
    base_sha: { type: 'string' },
    files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, status: { type: 'string' }, content: { type: 'string' }, additions: { type: 'integer' }, deletions: { type: 'integer' } }, required: ['path', 'status'] } },
    tests: { type: 'object', properties: { status: { type: 'string' }, exit_code: { type: 'integer' }, attempts: { type: 'integer' } } },
    stats: { type: 'object', properties: { files: { type: 'integer' } } },
    diff: { type: 'string' },
  },
};

let nonce = 0;
/** The package as it ships, with every agent swapped for a script that answers as the scenario says. */
function storyPackage(s: Scenario): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-story-e2e-'));
  cpSync(PKG, dir, { recursive: true });
  const wfPath = join(dir, 'workflow.yaml');
  const wf = parse(readFileSync(wfPath, 'utf8').replaceAll('{{slack_channel}}', CHANNEL));
  const out = answers(s);
  for (const n of wf.nodes) {
    if (n.type === 'agent') {
      const schema = JSON.parse(readFileSync(join(PKG, n.output_schema), 'utf8'));
      delete schema.additionalProperties;
      // The real schema refuses an empty recommendation at the agent; the stand-in lets one through to test the gate.
      for (const k of ['question', 'recommendation']) delete schema.properties.open_questions?.items?.properties?.[k]?.minLength;
      schema.properties = { ...schema.properties, workspace: WORKSPACE_SCHEMA };
      writeFileSync(join(dir, `schemas/stub_${n.id}.json`), JSON.stringify(schema));
      for (const k of ['executor', 'profile', 'workspace', 'timeout', 'budget']) delete n[k];
      Object.assign(n, { type: 'script', runtime: 'python', entrypoint: `scripts/stub_${n.id}.py`, output_schema: `schemas/stub_${n.id}.json`, limits: { time: '1m' } });
    } else if (out[n.id] === undefined || n.type !== 'script') continue;
    else n.entrypoint = `scripts/stub_${n.id}.py`;
    writeFileSync(join(dir, `scripts/stub_${n.id}.py`), (n.id === 'apply' ? echoing : python)(out[n.id]));
  }
  // The same stand-in leniency for the author's questions as in the agent schemas above.
  const sc = JSON.parse(readFileSync(join(dir, 'schemas/spec_change.json'), 'utf8'));
  for (const k of ['question', 'recommendation']) delete sc.properties.open_questions.items.properties[k].minLength;
  writeFileSync(join(dir, 'schemas/spec_change.json'), JSON.stringify(sc));
  writeFileSync(wfPath, `# scenario ${++nonce}\n${stringify(wf)}`);
  return dir;
}

/** A stand-in for pr-review: it answers as the scenario says and echoes the inputs it was given. */
function reviewPackage(kind: ReviewKind): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-review-stub-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(
    join(dir, 'workflow.yaml'),
    `# scenario ${++nonce}
schema_version: "2.0"
id: pr-review
inputs:
  type: object
  properties:
    repo: {type: string}
    pr: {type: integer}
    post: {type: boolean}
    offer_merge: {type: boolean}
    diff_base: {type: string}
  required: [repo, pr]
nodes:
  - id: echo
    type: script
    runtime: python
    entrypoint: scripts/echo.py
    input: {map: "{'repo': inputs.repo, 'pr': inputs.pr, 'post': has(inputs.post) ? inputs.post : false, 'offer_merge': has(inputs.offer_merge) ? inputs.offer_merge : false, 'diff_base': has(inputs.diff_base) ? inputs.diff_base : ''}"}
    output_schema: {type: object}
  - id: summarize
    type: script
    runtime: python
    entrypoint: scripts/summarize.py
    retry: {max_attempts: 1}
    input: {map: "{'pr': nodes.echo.output.pr}"}
    output_schema: {type: object}
`,
  );
  writeFileSync(join(dir, 'scripts/echo.py'), 'import json, sys\nprint(json.dumps(json.load(sys.stdin)))\n');
  const finding = (triage: string, title: string) => ({ severity: triage === 'fix_now' ? 'major' : 'minor', triage, reviewer: 'correctness', path: 'src/cart.js', line: 3, title, detail: 'A discount above 100% makes the total negative.', confidence: 90 });
  const verdicts = {
    approved: { verdict: 'approve', summary: 'Looks good.', findings: [] },
    findings: { verdict: 'request_changes', summary: 'One bug to fix.', findings: [finding('fix_now', 'No clamp'), finding('follow_up', 'Name the constant')] },
  };
  writeFileSync(join(dir, 'scripts/summarize.py'), kind === 'fail' ? 'raise SystemExit("the review failed")\n' : python(verdicts[kind]));
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

const SLOW = 300_000;

describe.skipIf(!up)('sdd-story end to end (agents replaced by scripts, pr-review replaced by a stand-in)', () => {
  let h: Harness;
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  const saved = process.env.AZHI_EGRESS_ALLOW;
  let ticket = 11;

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    gh = await startFakeGithub(
      { runs: [], pulls: [], issues: Array.from({ length: 40 }, (_, i) => ({ number: 12 + i, id: 5000 + i, repo: REPO, title: `Apply the discount ${12 + i}`, labels: [] as string[], body: 'Totals ignore the discount code.' })) },
      { token: [READ_TOKEN, WRITE_TOKEN] },
    );
    h = await startHarness();
    await h.api.put('/v1/secrets/github-read-token', { value: READ_TOKEN });
    await h.api.put('/v1/secrets/github-write-token', { value: WRITE_TOKEN });
    for (const t of parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools) {
      if (t.transport?.config?.repos) t.transport.config = { ...t.transport.config, repos: [REPO], api_url: gh.url };
      await h.api.post('/v1/tools', t);
    }
  }, 120_000);
  afterAll(async () => {
    if (saved === undefined) delete process.env.AZHI_EGRESS_ALLOW;
    else process.env.AZHI_EGRESS_ALLOW = saved;
    await h?.stop();
    await gh?.stop();
  });

  /** Publishes the review stand-in, then starts a Story for the next ticket. */
  const start = async (s: Scenario, extra: Record<string, unknown> = {}) => {
    const rv = await uploadDir(h.api, reviewPackage(s.review));
    expect(rv.ok, JSON.stringify(rv.diagnostics)).toBe(true);
    await h.api.post(`/v1/versions/${rv.version.id}/publish`, {});
    const v = await uploadDir(h.api, storyPackage(s));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    const number = ++ticket;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs: { source: 'github', ticket: `${REPO}#${number}`, repo: REPO, base_branch: 'dev', ...extra } });
    return { run_id, number };
  };
  const approve = (run_id: string, node: string, decision: 'approved' | 'rejected' = 'approved') => h.api.post(`/v1/runs/${run_id}/approvals`, { node, decision });
  const out = (d: any, id: string) => d.attempts.filter((a: any) => a.node_id === id && a.state === 'succeeded').at(-1)?.output;
  /** A tool step's result: the attempt holds {action, output, observation}. */
  const tool = (d: any, id: string) => out(d, id)?.output;
  const state = (d: any, id: string) => d.attempts.filter((a: any) => a.node_id === id).at(-1)?.state ?? 'not run';
  const labels = (n: number) => gh.issues.find((i) => i.number === n)!.labels;

  it('replaces only the agents: the stand-in package has the same steps as the real one', () => {
    const real = parse(readFileSync(`${PKG}/workflow.yaml`, 'utf8')).nodes as Array<{ id: string; type: string }>;
    const stubbed = parse(readFileSync(join(storyPackage(HAPPY), 'workflow.yaml'), 'utf8')).nodes as Array<{ id: string; type: string }>;
    expect(stubbed.map((n) => n.id)).toEqual(real.map((n) => n.id));
    expect(stubbed.filter((n) => n.type === 'agent')).toEqual([]);
    expect(real.filter((n) => n.type === 'agent').map((n) => n.id)).toEqual(['scan', 'propose', 'revise', 'spec_review', 'apply', 'verify', 'archive', 'fix']);
  });

  it('delivers a Story: specs approved, branch pushed, pull request into the base, review child, sign-off, label, result', async () => {
    const { run_id, number } = await start(HAPPY, { stack_on: 'azhi/acme/shop-11' });

    // The first proposal passes its check, so the second round never runs - and the steps after it still do.
    const specs = await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    expect(specs.approvals[0].request.payload).toMatchObject({ change_id: out(specs, 'change_id').id });
    expect(state(specs, 'pass_1')).toBe('succeeded');
    for (const id of ['revise', 'check_2', 'pass_2']) expect(state(specs, id), id).toBe('skipped');
    expect(gh.git.refs.size).toBe(0);
    await approve(run_id, 'proposal_approval');

    // Sign-off comes after the push, the pull request and the review, with all of them in front of the person.
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');
    const branch = tool(sign, 'push_branch').branch as string;
    expect(gh.branchFiles(branch)).toEqual(contents(ARCHIVE_FILES));
    expect(gh.git.pulls).toHaveLength(1);
    expect(gh.git.pulls[0]).toMatchObject({ repo: REPO, head: branch, base: 'dev', draft: false });
    const pr = tool(sign, 'open_pr');
    const review = out(sign, 'review');
    expect(review).toMatchObject({ workflow: 'pr-review', state: 'succeeded' });
    // The review is of this pull request, from the commit the branch was cut from, and it never offers to merge.
    expect(review.nodes.echo).toEqual({ repo: REPO, pr: pr.number, post: true, offer_merge: false, diff_base: BASE_SHA });
    const payload = sign.approvals.find((a: any) => a.node_id === 'signoff').request.payload;
    expect(payload).toMatchObject({ pull_request: { number: pr.number, url: pr.url }, tests: { status: 'passed' }, review: { status: 'approved', verdict: 'approve' }, fix_round_ran: false, fix_round_note: 'No fix round ran.' });
    expect(labels(number)).not.toContain(LABEL);
    await approve(run_id, 'signoff');

    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(state(done, 'fix')).toBe('skipped');
    for (const id of ['spec_review', 'apply', 'verify', 'archive', 'push_branch', 'open_pr', 'review', 'signoff', 'label_ticket', 'story_notify', 'summary', 'result']) expect(state(done, id), id).toBe('succeeded');
    expect(out(done, 'spec_change').check).toMatchObject({ ok: true, errors: [] });
    expect(labels(number)).toContain(LABEL);
    expect(out(done, 'result')).toEqual({ status: 'signed_off', reason: 'signed_off', branch, head_sha: tool(done, 'push_branch').commit_sha, pr_number: pr.number, pr_url: pr.url });
    expect(h.slack.messages.map((m) => m.text).some((t) => t.includes('Signed off') && t.includes(pr.url))).toBe(true);
    // The pull request child is a run of its own, started by this one.
    expect(done.children.map((c: any) => [c.workflow, c.state, c.parent_node_id])).toEqual([['pr-review', 'succeeded', 'review']]);
  }, SLOW);

  it('runs the second round when the first proposal fails its check, and carries that round on', async () => {
    const { run_id } = await start({ ...HAPPY, check1: false });
    const specs = await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    expect(state(specs, 'check_gate_1')).toBe('succeeded');
    for (const id of ['revise', 'check_2', 'pass_2']) expect(state(specs, id), id).toBe('succeeded');
    expect(state(specs, 'pass_1')).toBe('skipped');
    expect(out(specs, 'spec_change').check).toMatchObject({ ok: true });
    expect(out(specs, 'spec_change').workspace.files[0].content).toBe('revised');
    await approve(run_id, 'proposal_approval');
    await waitForApprovalOn(h.api, run_id, 'signoff');
    await approve(run_id, 'signoff');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off' });
  }, SLOW);

  it('sends the Story back when neither proposal passes its check: nothing is built, pushed or opened', async () => {
    const before = [gh.git.refs.size, gh.git.pulls.length];
    const { run_id, number } = await start({ ...HAPPY, check1: false, check2: false });
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals).toEqual([]);
    for (const id of ['spec_review', 'proposal_approval', 'apply', 'push_branch', 'open_pr', 'review', 'signoff']) expect(state(done, id), id).toBe('skipped');
    expect(out(done, 'result')).toEqual({ status: 'sent_back', reason: 'specs_invalid', branch: null, head_sha: null, pr_number: null, pr_url: null });
    expect([gh.git.refs.size, gh.git.pulls.length]).toEqual(before);
    expect(labels(number)).toEqual([]);
    expect(h.slack.messages.map((m) => m.text).some((t) => t.includes('did not pass its check'))).toBe(true);
  }, SLOW);

  it('sends the Story back, with the reason, when a person rejects the specs', async () => {
    const before = [gh.git.refs.size, gh.git.pulls.length];
    const { run_id } = await start(HAPPY);
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval', 'rejected');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    for (const id of ['apply', 'archive', 'push_branch', 'open_pr', 'review']) expect(state(done, id), id).toBe('skipped');
    // A parent reads this step, so it must exist even when a person says no.
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'specs_rejected', pr_number: null });
    expect([gh.git.refs.size, gh.git.pulls.length]).toEqual(before);
  }, SLOW);

  it('sends the Story back when the tests fail: no branch, no pull request, no review', async () => {
    const before = [gh.git.refs.size, gh.git.pulls.length];
    const { run_id } = await start({ ...HAPPY, tests: 'failed' });
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(state(done, 'release_gate')).toBe('succeeded');
    for (const id of ['archive', 'push_branch', 'open_pr', 'review', 'signoff']) expect(state(done, id), id).toBe('skipped');
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'tests_failed', pr_number: null });
    expect([gh.git.refs.size, gh.git.pulls.length]).toEqual(before);
    expect(h.slack.messages.map((m) => m.text).some((t) => t.includes('tests did not pass'))).toBe(true);
  }, SLOW);

  it('fixes the confirmed findings once, pushes the fix to the same branch, and says at sign-off that it was not reviewed again', async () => {
    const { run_id, number } = await start({ ...HAPPY, review: 'findings' });
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');

    expect(out(sign, 'review_outcome')).toMatchObject({ status: 'findings', fix_now: [expect.objectContaining({ title: 'No clamp' })], remaining: [expect.objectContaining({ title: 'Name the constant' })] });
    const branch = tool(sign, 'push_branch').branch as string;
    // One pull request, one branch; the fix replaced the branch's commit, so its files are the whole fixed change.
    expect(gh.git.pulls.filter((p) => p.head === branch)).toHaveLength(1);
    expect(gh.branchFiles(branch)).toEqual(contents(FIX_FILES));
    expect(tool(sign, 'push_fix').commit_sha).not.toBe(tool(sign, 'push_branch').commit_sha);
    expect(gh.git.refs.get(branch)).toBe(tool(sign, 'push_fix').commit_sha);
    const payload = sign.approvals.find((a: any) => a.node_id === 'signoff').request.payload;
    expect(payload).toMatchObject({ review: { status: 'findings' }, fix_round_ran: true, fix_round_note: 'The fix was tested but not reviewed again.', fix_round: { ran: true, tests_status: 'passed', re_reviewed: false } });
    expect(payload.remaining_findings).toHaveLength(1);
    // The review ran once: there is no second review of the fix.
    expect(sign.attempts.filter((a: any) => a.node_id === 'review')).toHaveLength(1);
    await approve(run_id, 'signoff');

    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off', branch, head_sha: tool(done, 'push_fix').commit_sha });
    expect(labels(number)).toContain(LABEL);
    expect(h.slack.messages.map((m) => m.text).some((t) => t.includes('fix round ran, not reviewed again'))).toBe(true);
  }, SLOW);

  it('asks nobody to sign off a fix whose tests fail, and leaves the pushed branch as it was', async () => {
    const { run_id } = await start({ ...HAPPY, review: 'findings', fixTests: 'failed' });
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    const branch = tool(done, 'push_branch').branch as string;
    expect(gh.branchFiles(branch)).toEqual(contents(ARCHIVE_FILES));
    for (const id of ['push_fix', 'fix_done', 'signoff', 'label_ticket']) expect(state(done, id), id).toBe('skipped');
    expect(done.approvals.map((a: any) => a.node_id)).toEqual(['proposal_approval']);
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'fix_tests_failed', branch, pr_number: expect.any(Number) });
    expect(h.slack.messages.map((m) => m.text).some((t) => t.includes('fix round failed its tests'))).toBe(true);
  }, SLOW);

  it('sends the Story back, without a sign-off, when the review child fails', async () => {
    const { run_id } = await start({ ...HAPPY, review: 'fail' });
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(out(done, 'review')).toMatchObject({ workflow: 'pr-review', state: 'failed', error: { class: expect.any(String) } });
    expect(out(done, 'review_outcome')).toMatchObject({ status: 'unavailable', reason: 'review_did_not_succeed' });
    for (const id of ['fix', 'signoff', 'label_ticket']) expect(state(done, id), id).toBe('skipped');
    expect(done.approvals.map((a: any) => a.node_id)).toEqual(['proposal_approval']);
    // The pull request exists and is reported, but it was not signed off.
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'review_unavailable', pr_number: expect.any(Number) });
    expect(h.slack.messages.map((m) => m.text).some((t) => t.includes('review is unavailable'))).toBe(true);
  }, SLOW);

  it('sends the Story back, unlabelled, when a person rejects the sign-off', async () => {
    const { run_id, number } = await start(HAPPY);
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    await waitForApprovalOn(h.api, run_id, 'signoff');
    await approve(run_id, 'signoff', 'rejected');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    for (const id of ['label_ticket', 'story_notify', 'summary']) expect(state(done, id), id).toBe('skipped');
    expect(labels(number)).toEqual([]);
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'signoff_rejected', pr_number: expect.any(Number) });
  }, SLOW);

  // ---- mode: auto -------------------------------------------------------------------------------------------------

  const AUTO = { mode: 'auto' };
  const texts = (key: string) => h.slack.messages.map((m) => m.text).filter((t) => t.includes(key));
  const received = (d: any) => out(d, 'apply').received_decisions;

  it('auto: asks nobody when the rules allow it - specs and sign-off are decided, labelled, posted to Slack', async () => {
    const { run_id, number } = await start(HAPPY, AUTO);
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals).toEqual([]);
    expect(out(done, 'specs_gate')).toMatchObject({ route: 'auto', reason: 'auto' });
    expect(out(done, 'signoff_gate')).toMatchObject({ route: 'auto', reason: 'auto' });
    for (const id of ['proposal_approval', 'signoff']) expect(state(done, id), id).toBe('skipped');
    for (const id of ['specs_auto', 'specs_notify', 'specs_decision', 'signoff_auto', 'signoff_notify', 'signoff_decision', 'label_ticket', 'story_notify', 'summary', 'result']) expect(state(done, id), id).toBe('succeeded');
    expect(out(done, 'specs_decision')).toEqual({ by: 'auto', data: { notes: 'Auto mode: no person was asked. No open questions.' } });
    expect(received(done)).toEqual({ notes: 'Auto mode: no person was asked. No open questions.' });
    expect(out(done, 'signoff_decision')).toEqual({ decision: 'approved', by: 'auto' });
    expect(labels(number)).toContain(LABEL);
    const pr = tool(done, 'open_pr');
    expect(out(done, 'result')).toEqual({ status: 'signed_off', reason: 'signed_off', branch: tool(done, 'push_branch').branch, head_sha: tool(done, 'push_branch').commit_sha, pr_number: pr.number, pr_url: pr.url });
    const key = out(done, 'intake').key as string;
    const said = texts(key);
    expect(said.some((t) => t.includes('approved by rules') && t.includes('No open questions'))).toBe(true);
    expect(said.some((t) => t.includes('nobody signed this off') && t.includes(pr.url) && t.includes('Tests passed') && t.includes('no fix round was needed'))).toBe(true);
    expect(said.some((t) => t.includes(`Signed off ${key} (auto)`))).toBe(true);
  }, SLOW);

  it('auto: takes the recommended answer of an open question, hands it to the engineer and says so in Slack', async () => {
    const { run_id } = await start({ ...HAPPY, questions: [QUESTION] }, AUTO);
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals).toEqual([]);
    expect(out(done, 'specs_gate')).toMatchObject({ route: 'auto' });
    expect(received(done).notes).toBe('Auto mode: no person was asked. Taken as recommended:\n1. Round up or down? -> Round half up to 2 places.');
    const key = out(done, 'intake').key as string;
    expect(texts(key).some((t) => t.includes('1. Round up or down? -> Round half up to 2 places. (why: Totals are in cents)'))).toBe(true);
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off' });
  }, SLOW);

  it('auto: asks the person about the specs when a question has no recommendation, says why, and carries on after they approve', async () => {
    const { run_id, number } = await start({ ...HAPPY, questions: [{ ...QUESTION, recommendation: '' }] }, AUTO);
    const specs = await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    expect(out(specs, 'specs_gate')).toMatchObject({ route: 'ask', reason: 'no_recommendation' });
    const request = specs.approvals.find((a: any) => a.node_id === 'proposal_approval').request;
    expect(request.message).toContain('Asked although the run is unattended: An open question has no recommended answer');
    expect(request.payload.open_questions).toEqual([{ ...QUESTION, recommendation: '' }]);
    expect(state(specs, 'specs_auto')).toBe('skipped');
    await approve(run_id, 'proposal_approval');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals.map((a: any) => a.node_id)).toEqual(['proposal_approval']);
    expect(out(done, 'specs_decision')).toMatchObject({ by: expect.any(String) });
    expect(out(done, 'specs_decision').by).not.toBe('auto');
    expect(state(done, 'specs_notify')).toBe('skipped');
    expect(labels(number)).toContain(LABEL);
    // The sign-off was still decided by the rules.
    expect(out(done, 'signoff_decision')).toEqual({ decision: 'approved', by: 'auto' });
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off' });
  }, SLOW);

  it('auto: a rejected specs approval that was asked sends the Story back and builds nothing', async () => {
    const before = [gh.git.refs.size, gh.git.pulls.length];
    const { run_id } = await start({ ...HAPPY, questions: [{ ...QUESTION, recommendation: '' }] }, AUTO);
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval', 'rejected');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    // The join still runs (it also reads the open questions) but finds no approved decision, and specs_ok stops the run there.
    expect(out(done, 'specs_decision')).toEqual({ by: null, data: null });
    for (const id of ['apply', 'archive', 'push_branch', 'open_pr', 'review', 'signoff_gate', 'signoff_auto', 'label_ticket']) expect(state(done, id), id).toBe('skipped');
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'specs_rejected', pr_number: null });
    expect([gh.git.refs.size, gh.git.pulls.length]).toEqual(before);
  }, SLOW);

  it('auto: a review that asked for changes still gets its fix round, but a person signs the unreviewed fix off, and is told why', async () => {
    const { run_id, number } = await start({ ...HAPPY, review: 'findings' }, AUTO);
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');
    // The fix ran and passed its tests and was pushed; nobody reviewed it, so the rules do not sign it off.
    expect(state(sign, 'fix')).toBe('succeeded');
    expect(tool(sign, 'push_fix').commit_sha).toBeTruthy();
    expect(out(sign, 'signoff_gate')).toMatchObject({ route: 'ask', reason: 'fix_not_reviewed' });
    expect(state(sign, 'signoff_auto')).toBe('skipped');
    expect(sign.approvals.map((a: any) => a.node_id)).toEqual(['signoff']);
    expect(sign.approvals[0].request.message).toContain('Asked although the run is unattended: The review asked for changes and a fix round followed; nobody reviewed the fix, so a person signs it off.');
    expect(sign.approvals[0].request.payload).toMatchObject({ fix_round_ran: true, fix_round_note: 'The fix was tested but not reviewed again.' });
    expect(sign.attempts.filter((a: any) => a.node_id === 'review')).toHaveLength(1);
    expect(labels(number)).not.toContain(LABEL);
    await approve(run_id, 'signoff');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(state(done, 'signoff_notify')).toBe('skipped');
    expect(out(done, 'signoff_decision').by).not.toBe('auto');
    expect(labels(number)).toContain(LABEL);
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off', head_sha: tool(done, 'push_fix').commit_sha });
  }, SLOW);

  it('auto: a CRITICAL verifier issue makes the pull request a draft and the sign-off IS asked, with the reason', async () => {
    const { run_id, number } = await start({ ...HAPPY, verifyIssues: [CRITICAL_ISSUE] }, AUTO);
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');
    expect(out(sign, 'signoff_gate')).toMatchObject({ route: 'ask', reason: 'critical_issue' });
    expect(state(sign, 'signoff_auto')).toBe('skipped');
    expect(tool(sign, 'open_pr').draft).toBe(true);
    expect(gh.git.pulls.at(-1)).toMatchObject({ draft: true });
    expect(sign.approvals.map((a: any) => a.node_id)).toEqual(['signoff']);
    expect(sign.approvals[0].request.message).toContain('Asked although the run is unattended: The verifier found a CRITICAL issue.');
    expect(labels(number)).not.toContain(LABEL);
    await approve(run_id, 'signoff');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(state(done, 'signoff_notify')).toBe('skipped');
    expect(out(done, 'signoff_decision')).toMatchObject({ decision: 'approved' });
    expect(out(done, 'signoff_decision').by).not.toBe('auto');
    expect(labels(number)).toContain(LABEL);
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off' });
  }, SLOW);

  it('auto: a rejected sign-off that was asked sends the Story back, unlabelled', async () => {
    const { run_id, number } = await start({ ...HAPPY, verifyIssues: [CRITICAL_ISSUE] }, AUTO);
    await waitForApprovalOn(h.api, run_id, 'signoff');
    await approve(run_id, 'signoff', 'rejected');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    for (const id of ['signoff_decision', 'label_ticket', 'story_notify', 'summary']) expect(state(done, id), id).toBe('skipped');
    expect(labels(number)).toEqual([]);
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'signoff_rejected', pr_number: expect.any(Number) });
  }, SLOW);

  it('auto: a failing review child sends the Story back as in supervised mode, with nobody asked', async () => {
    const { run_id } = await start({ ...HAPPY, review: 'fail' }, AUTO);
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals).toEqual([]);
    expect(out(done, 'review_outcome')).toMatchObject({ status: 'unavailable' });
    for (const id of ['fix', 'signoff_gate', 'signoff_auto', 'signoff_decision', 'label_ticket']) expect(state(done, id), id).toBe('skipped');
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'review_unavailable', pr_number: expect.any(Number) });
  }, SLOW);

  it('auto: failing tests send the Story back and nothing is signed off', async () => {
    const { run_id } = await start({ ...HAPPY, tests: 'failed' }, AUTO);
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals).toEqual([]);
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'tests_failed', pr_number: null });
  }, SLOW);

  it('supervised: open questions still reach the person, who can leave the notes empty to take the recommended answers', async () => {
    const { run_id } = await start({ ...HAPPY, questions: [QUESTION] }, { mode: 'supervised' });
    const specs = await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    expect(out(specs, 'specs_gate')).toMatchObject({ route: 'ask', reason: 'supervised' });
    const request = specs.approvals.find((a: any) => a.node_id === 'proposal_approval').request;
    expect(request.message).not.toContain('Asked although');
    expect(request.payload.open_questions).toEqual([QUESTION]);
    await approve(run_id, 'proposal_approval');
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');
    expect(sign.approvals.find((a: any) => a.node_id === 'signoff').request.message).not.toContain('Asked although');
    expect(received(sign)).toEqual({ notes: 'Taken as recommended:\n1. Round up or down? -> Round half up to 2 places.' });
    expect(['specs_auto', 'specs_notify', 'signoff_auto']).toSatisfy((ids: string[]) => ids.every((id) => state(sign, id) === 'skipped'));
    await approve(run_id, 'signoff');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals.map((a: any) => a.node_id)).toEqual(['proposal_approval', 'signoff']);
    expect(out(done, 'signoff_decision').by).not.toBe('auto');
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off' });
  }, SLOW);

  // ---- source: files ----------------------------------------------------------------------------------------------

  const DOC = { path: 'docs/release/my-release/breakdown.md', content: '# Release breakdown\n\n- S1 the cart\n- S2 the discount\n' };
  const withDoc = (files: typeof ARCHIVE_FILES) => ({ ...contents(files), [DOC.path]: DOC.content });
  let storyN = 0;
  /** Publishes the review stand-in, then starts a Story that comes from its inputs: no tracker is read or written. */
  const startFiles = async (s: Scenario, extra: Record<string, unknown> = {}) => {
    const rv = await uploadDir(h.api, reviewPackage(s.review));
    expect(rv.ok, JSON.stringify(rv.diagnostics)).toBe(true);
    await h.api.post(`/v1/versions/${rv.version.id}/publish`, {});
    const v = await uploadDir(h.api, storyPackage(s));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    const key = `my-release-s${++storyN}`;
    const mark = gh.requests.length;
    const inputs = { source: 'files', ticket: '', repo: REPO, base_branch: 'dev', story_key: key, story_title: 'Apply the discount', story_body: '## Story\nAs a shopper I get 10% off.\n\n- [ ] total applies it', extra_files: [DOC], ...extra };
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs });
    return { run_id, key, issueRequests: () => gh.requests.slice(mark).filter((r) => r.includes('/issues')) };
  };

  it('files: delivers a Story from its inputs and carries the document into the pull request, reading and labelling nothing', async () => {
    const { run_id, key, issueRequests } = await startFiles(HAPPY);
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');
    const branch = tool(sign, 'push_branch').branch as string;
    expect(branch).toBe(`azhi/${key}`);
    // The branch holds the agent's files AND the document, and the pull request goes into the base branch.
    expect(gh.branchFiles(branch)).toEqual(withDoc(ARCHIVE_FILES));
    expect(gh.git.pulls.filter((p) => p.head === branch)).toEqual([expect.objectContaining({ repo: REPO, head: branch, base: 'dev', draft: false })]);
    const pr = tool(sign, 'open_pr');
    expect(out(sign, 'intake')).toMatchObject({ source: 'files', key, title: 'Apply the discount', url: '', labels: [] });
    expect(out(sign, 'push_files').ignored).toEqual([]);
    const body = gh.git.pulls.find((p) => p.head === branch)!.body;
    expect(body).toContain(`Ticket: ${key}\n\n_Opened by Azhi Flow`);
    expect(sign.approvals.find((a: any) => a.node_id === 'signoff').request.payload).toMatchObject({ branch, extra_files_ignored: [], pull_request: { number: pr.number } });
    await approve(run_id, 'signoff');

    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    // No issue was read and no label call was made; the github-only steps never ran.
    expect(issueRequests()).toEqual([]);
    for (const id of ['github_issue', 'intake_github', 'label_ticket']) expect(state(done, id), id).toBe('skipped');
    for (const id of ['files_ticket', 'intake', 'push_files', 'push_branch', 'open_pr', 'review', 'signoff', 'signoff_decision', 'label_choice', 'story_notify', 'summary', 'result']) expect(state(done, id), id).toBe('succeeded');
    expect(state(done, 'fix')).toBe('skipped');
    expect(out(done, 'result')).toEqual({ status: 'signed_off', reason: 'signed_off', branch, head_sha: tool(done, 'push_branch').commit_sha, pr_number: pr.number, pr_url: pr.url });
    expect(h.slack.messages.map((m) => m.text).some((t) => t.includes(`Signed off ${key}`) && t.includes(pr.url))).toBe(true);
    expect(done.children.map((c: any) => [c.workflow, c.state])).toEqual([['pr-review', 'succeeded']]);
  }, SLOW);

  it('files: a Story without extra files signs off and pushes only the agent files', async () => {
    const { run_id } = await startFiles(HAPPY, { extra_files: [] });
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');
    expect(gh.branchFiles(tool(sign, 'push_branch').branch)).toEqual(contents(ARCHIVE_FILES));
    await approve(run_id, 'signoff');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off' });
  }, SLOW);

  it('files: the fix round re-pushes the whole fixed change and the document is still on the branch', async () => {
    const { run_id, key, issueRequests } = await startFiles({ ...HAPPY, review: 'findings' });
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');
    const branch = tool(sign, 'push_branch').branch as string;
    expect(branch).toBe(`azhi/${key}`);
    expect(state(sign, 'fix')).toBe('succeeded');
    expect(tool(sign, 'push_fix').commit_sha).not.toBe(tool(sign, 'push_branch').commit_sha);
    expect(gh.git.refs.get(branch)).toBe(tool(sign, 'push_fix').commit_sha);
    expect(gh.branchFiles(branch)).toEqual(withDoc(FIX_FILES));
    expect(out(sign, 'push_fix_files').files.map((f: any) => f.path)).toContain(DOC.path);
    expect(gh.git.pulls.filter((p) => p.head === branch)).toHaveLength(1);
    const payload = sign.approvals.find((a: any) => a.node_id === 'signoff').request.payload;
    expect(payload).toMatchObject({ fix_round_ran: true, extra_files_ignored: [], fix_round: { ran: true, tests_status: 'passed', extra_files_ignored: [] } });
    await approve(run_id, 'signoff');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(issueRequests()).toEqual([]);
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off', branch, head_sha: tool(done, 'push_fix').commit_sha });
    for (const id of ['story_notify', 'summary', 'result']) expect(state(done, id), id).toBe('succeeded');
  }, SLOW);

  it('files: an extra the script refuses is left out and listed at sign-off, and the Story still signs off', async () => {
    // a..b.md matches the input schema's pattern but has "..", which push_files refuses; the second is a repeated path.
    const refused = { path: 'docs/release/my-release/a..b.md', content: 'x' };
    const { run_id } = await startFiles(HAPPY, { extra_files: [refused, DOC, { ...DOC, content: 'again' }] });
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');
    const branch = tool(sign, 'push_branch').branch as string;
    expect(gh.branchFiles(branch)).toEqual(withDoc(ARCHIVE_FILES));
    expect(gh.branchFiles(branch)).not.toHaveProperty([refused.path]);
    expect(sign.approvals.find((a: any) => a.node_id === 'signoff').request.payload.extra_files_ignored).toEqual([refused.path, DOC.path]);
    await approve(run_id, 'signoff');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(out(done, 'result')).toMatchObject({ status: 'signed_off' });
  }, SLOW);

  it('files: an extra outside docs/release, or a fourth extra, is refused when the run starts: nothing is created', async () => {
    const before = [gh.git.refs.size, gh.git.pulls.length];
    const v = await uploadDir(h.api, storyPackage(HAPPY));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    const inputs = { source: 'files', ticket: '', repo: REPO, base_branch: 'dev', story_key: 'my-release-bad', story_title: 'T', story_body: 'B' };
    await expect(h.api.post('/v1/runs', { version: v.version.id, inputs: { ...inputs, extra_files: [{ path: 'src/evil.md', content: 'x' }] } })).rejects.toThrow(/input schema/);
    await expect(h.api.post('/v1/runs', { version: v.version.id, inputs: { ...inputs, extra_files: [DOC, DOC, DOC, DOC] } })).rejects.toThrow(/input schema/);
    expect([gh.git.refs.size, gh.git.pulls.length]).toEqual(before);
  }, SLOW);

  it('files: a rejected sign-off sends the Story back as in github mode, with the branch and pull request reported', async () => {
    const { run_id, issueRequests } = await startFiles(HAPPY);
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    await waitForApprovalOn(h.api, run_id, 'signoff');
    await approve(run_id, 'signoff', 'rejected');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    for (const id of ['label_choice', 'label_ticket', 'story_notify', 'summary']) expect(state(done, id), id).toBe('skipped');
    expect(issueRequests()).toEqual([]);
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'signoff_rejected', branch: tool(done, 'push_branch').branch, pr_number: expect.any(Number) });
  }, SLOW);

  it('files: rejected specs send the Story back with nothing built or pushed', async () => {
    const before = [gh.git.refs.size, gh.git.pulls.length];
    const { run_id } = await startFiles(HAPPY);
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval', 'rejected');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    for (const id of ['apply', 'push_files', 'push_branch', 'open_pr', 'review']) expect(state(done, id), id).toBe('skipped');
    expect(out(done, 'result')).toMatchObject({ status: 'sent_back', reason: 'specs_rejected', pr_number: null });
    expect([gh.git.refs.size, gh.git.pulls.length]).toEqual(before);
  }, SLOW);

  it('files: auto mode works as with github - nobody is asked, the document is pushed, nothing is labelled', async () => {
    const { run_id, key, issueRequests } = await startFiles(HAPPY, AUTO);
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals).toEqual([]);
    expect(out(done, 'specs_gate')).toMatchObject({ route: 'auto' });
    expect(out(done, 'signoff_gate')).toMatchObject({ route: 'auto' });
    expect(out(done, 'signoff_decision')).toEqual({ decision: 'approved', by: 'auto' });
    const branch = tool(done, 'push_branch').branch as string;
    expect(branch).toBe(`azhi/${key}`);
    expect(gh.branchFiles(branch)).toEqual(withDoc(ARCHIVE_FILES));
    expect(issueRequests()).toEqual([]);
    for (const id of ['signoff_notify', 'story_notify', 'summary', 'result']) expect(state(done, id), id).toBe('succeeded');
    for (const id of ['github_issue', 'label_ticket']) expect(state(done, id), id).toBe('skipped');
    const pr = tool(done, 'open_pr');
    expect(out(done, 'result')).toEqual({ status: 'signed_off', reason: 'signed_off', branch, head_sha: tool(done, 'push_branch').commit_sha, pr_number: pr.number, pr_url: pr.url });
    expect(texts(key).some((t) => t.includes(`Signed off ${key} (auto)`))).toBe(true);
  }, SLOW);

  it('files: a Story title that is empty after cleaning fails the run closed, before anything is read or built', async () => {
    const before = [gh.git.refs.size, gh.git.pulls.length];
    const { run_id, issueRequests } = await startFiles(HAPPY, { story_title: '<>  ' });
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('failed');
    expect(done.approvals).toEqual([]);
    expect(state(done, 'files_ticket')).toBe('failed');
    for (const id of ['intake', 'change_id', 'scan', 'propose', 'push_files', 'push_branch', 'open_pr']) expect(['skipped', 'not run'], id).toContain(state(done, id));
    expect(issueRequests()).toEqual([]);
    expect([gh.git.refs.size, gh.git.pulls.length]).toEqual(before);
  }, SLOW);

  it('files: a missing story title or body is refused when the run starts', async () => {
    const v = await uploadDir(h.api, storyPackage(HAPPY));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    const inputs = { source: 'files', ticket: '', repo: REPO, base_branch: 'dev', story_key: 'my-release-bad', story_title: 'T', story_body: 'B' };
    for (const over of [{ story_title: '' }, { story_title: undefined }, { story_body: '' }, { story_key: '' }, { ticket: 'acme/shop#12' }]) {
      await expect(h.api.post('/v1/runs', { version: v.version.id, inputs: { ...inputs, ...over } }), JSON.stringify(over)).rejects.toThrow(/input schema/);
    }
    await expect(h.api.post('/v1/runs', { version: v.version.id, inputs: { source: 'github', repo: REPO, base_branch: 'dev', ticket: '' } })).rejects.toThrow(/input schema/);
  }, SLOW);

  it('github: a Story with the files-only inputs empty behaves as before - the issue is read and labelled, nothing extra is pushed', async () => {
    const { run_id, number } = await start(HAPPY, { story_key: '', story_title: '', story_body: '', extra_files: [] });
    await waitForApprovalOn(h.api, run_id, 'proposal_approval');
    await approve(run_id, 'proposal_approval');
    const sign = await waitForApprovalOn(h.api, run_id, 'signoff');
    expect(gh.branchFiles(tool(sign, 'push_branch').branch)).toEqual(contents(ARCHIVE_FILES));
    expect(out(sign, 'intake')).toMatchObject({ source: 'github', key: `${REPO}#${number}` });
    await approve(run_id, 'signoff');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    for (const id of ['files_ticket']) expect(state(done, id), id).toBe('skipped');
    for (const id of ['github_issue', 'intake_github', 'label_choice', 'label_ticket', 'story_notify', 'summary', 'result']) expect(state(done, id), id).toBe('succeeded');
    expect(labels(number)).toContain(LABEL);
    expect(gh.requests.some((r) => r.includes(`/issues/${number}`))).toBe(true);
  }, SLOW);
});
