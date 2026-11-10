import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGithub } from '../src/testing/fake-github.js';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * ai-sdlc-factory-verify on the engine, with a scripted verifier and a stand-in for GitHub: the CI runs are read from
 * the stand-in's Actions API, the verdict is graded by the package's own script, the Slack message is posted to the
 * stand-in Slack, and the fix issue is created in the stand-in GitHub only after a person approves it. Runs under
 * `npm run test:local`; the verifier's prompts and the real OpenCode path are covered by the live smoke runbook.
 */
const up = await temporalAvailable();
const PKG = 'examples/ai-sdlc-factory-verify';
const CHANNEL = 'C-VERIFY';
const READ = 'ghp_read';
const WRITE = 'ghp_write';

const journeys = 'Journey Checkout: add to cart, pay, see receipt.\nJourney Login: open the page, sign in.\nInvariant: an order is never charged twice.';
const inputs = { repo: 'acme/shop', staging_branch: 'dev', journeys };

const row = (name: string, status: string, evidence: string[], gap = '') => ({ name, status, evidence, gap });
const inv = (statement: string, status: string, evidence: string[], gap = '') => ({ statement, status, evidence, gap });

/** The verify package with its agent on the scripted provider, no repository checkout, and the Slack channel filled in. */
function scripted(output: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-verify-e2e-'));
  cpSync(PKG, dir, { recursive: true });
  const wfPath = join(dir, 'workflow.yaml');
  const wf = parse(readFileSync(wfPath, 'utf8').replace('{{slack_channel}}', CHANNEL));
  for (const n of wf.nodes) if (n.type === 'agent') (delete n.executor, delete n.workspace);
  writeFileSync(wfPath, stringify(wf));
  const profile = 'profiles/journey-verifier@1.yaml';
  writeFileSync(join(dir, profile), JSON.stringify({ ...parse(readFileSync(`${PKG}/${profile}`, 'utf8')), model: { provider: 'scripted' }, script: [{ output }] }));
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

describe.skipIf(!up)('ai-sdlc-factory-verify end to end (scripted verifier, stand-in GitHub)', () => {
  let h: Harness;
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  const saved = process.env.AZHI_EGRESS_ALLOW;

  const start = async (output: unknown, extra: Record<string, unknown> = {}) => {
    const v = await uploadDir(h.api, scripted(output));
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    return (await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs: { ...inputs, ...extra } })).run_id;
  };
  const slackSince = (n: number) => h.slack.messages.slice(n).map((m) => m.text);

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    // A green CI run on the staging branch, completed inside the last week.
    const at = Date.now() - 3_600_000;
    gh = await startFakeGithub(
      { runs: [{ id: 700, conclusion: 'success', head_branch: 'dev', run_started_at: new Date(at).toISOString(), updated_at: new Date(at + 600_000).toISOString(), jobs: [{ name: 'build', conclusion: 'success' }] }], issues: [] },
      { token: [READ, WRITE] },
    );
    h = await startHarness();
    await h.api.put('/v1/secrets/github-read-token', { value: READ });
    await h.api.put('/v1/secrets/github-write-token', { value: WRITE });
    for (const t of parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools) {
      t.transport.config.repos = ['acme/shop'];
      t.transport.config.api_url = gh.url;
      await h.api.post('/v1/tools', t);
    }
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.AZHI_EGRESS_ALLOW;
    else process.env.AZHI_EGRESS_ALLOW = saved;
    await h?.stop();
    await gh?.stop();
  });

  it('a failed journey is posted, and the fix ticket is created only after a person approves it', async () => {
    const before = h.slack.messages.length;
    const run_id = await start({
      method: 'read the code',
      journeys: [row('Checkout', 'fail', ['src/pay.ts'], 'No receipt page after payment'), row('Login', 'pass', ['src/auth.ts'])],
      invariants: [inv('An order is never charged twice', 'pass', ['src/pay.ts'])],
    });

    // The verdict is posted first; the ticket is proposed but nothing is written while the approval waits.
    const waiting = await waitForApprovalOn(h.api, run_id, 'fix_approval');
    expect(gh.created).toHaveLength(0);
    const verdict = waiting.attempts.find((a: any) => a.node_id === 'verdict' && a.state === 'succeeded').output;
    expect(verdict).toMatchObject({ overall: 'failed', ci_status: 'success', propose_fix: true, counts: { pass: 2, fail: 1, unavailable: 0 } });
    expect(waiting.approvals[0].request.payload.ticket).toMatchObject({ title: 'Release verification failed on dev: 1 problem(s)', labels: ['ready', 'priority', 'release-verify'] });
    const posted = slackSince(before).join('\n');
    expect(posted).toContain('Release verification of acme/shop (dev): failed');
    expect(posted).toContain('journey Checkout: fail');
    expect(posted).toContain('journey Login: pass');

    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'fix_approval', decision: 'approved' });
    const done = await waitForRun(h.api, run_id, 90_000);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]).toMatchObject({ repo: 'acme/shop', title: 'Release verification failed on dev: 1 problem(s)', labels: ['ready', 'priority', 'release-verify'] });
    expect(gh.created[0]!.body).toContain('No receipt page after payment');
    expect(gh.created[0]!.body).toContain('src/pay.ts');
    expect(done.attempts.find((a: any) => a.node_id === 'create_fix').state).toBe('succeeded');
  });

  it('gives the verdict and asks for no fix ticket when propose_fix is false', async () => {
    const made = gh.created.length;
    const before = h.slack.messages.length;
    const run_id = await start({ method: 'read the code', journeys: [row('Checkout', 'fail', ['src/pay.ts'], 'No receipt page after payment')], invariants: [] }, { propose_fix: false });
    const done = await waitForRun(h.api, run_id, 90_000);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    // The verdict still says the release failed and still names the ticket it would have proposed; only the question is gone.
    expect(done.attempts.find((a: any) => a.node_id === 'verdict').output).toMatchObject({ overall: 'failed', propose_fix: true });
    expect(done.approvals).toHaveLength(0);
    expect(done.attempts.find((a: any) => a.node_id === 'fix_approval').state).toBe('skipped');
    expect(done.attempts.find((a: any) => a.node_id === 'create_fix').state).toBe('skipped');
    expect(gh.created).toHaveLength(made);
    expect(slackSince(before).join('\n')).toContain('Release verification of acme/shop (dev): failed');
  });

  it('writes nothing when the person rejects the fix ticket', async () => {
    const made = gh.created.length;
    const run_id = await start({ method: 'read the code', journeys: [row('Checkout', 'fail', [], 'No pay step')], invariants: [] });
    await waitForApprovalOn(h.api, run_id, 'fix_approval');
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'fix_approval', decision: 'rejected' });
    const done = await waitForRun(h.api, run_id);
    expect(done.run.state).toBe('succeeded');
    expect(done.attempts.find((a: any) => a.node_id === 'create_fix').state).toBe('skipped');
    expect(gh.created).toHaveLength(made);
  });

  it('verifies a release whose journeys all have evidence and whose CI is green: no approval, no ticket', async () => {
    const made = gh.created.length;
    const before = h.slack.messages.length;
    const run_id = await start({
      method: 'read the code',
      journeys: [row('Checkout', 'pass', ['src/pay.ts', 'src/receipt.ts']), row('Login', 'pass', ['src/auth.ts'])],
      invariants: [inv('An order is never charged twice', 'pass', ['src/pay.ts'])],
    });
    const done = await waitForRun(h.api, run_id, 90_000);
    expect(done.run.state).toBe('succeeded');
    expect(done.attempts.find((a: any) => a.node_id === 'verdict').output).toMatchObject({ overall: 'verified', propose_fix: false, ticket: null });
    expect(done.approvals).toHaveLength(0);
    expect(done.attempts.find((a: any) => a.node_id === 'fix_approval').state).toBe('skipped');
    expect(gh.created).toHaveLength(made);
    expect(slackSince(before).join('\n')).toContain('Release verification of acme/shop (dev): verified');
  });

  it('never counts a pass without a file as evidence: the grade is unavailable, and nothing is proposed', async () => {
    const made = gh.created.length;
    const run_id = await start({ method: 'read the code', journeys: [row('Checkout', 'pass', []), row('Login', 'unavailable', [], 'Sign-in lives in another service')], invariants: [] });
    const done = await waitForRun(h.api, run_id, 90_000);
    expect(done.run.state).toBe('succeeded');
    expect(done.attempts.find((a: any) => a.node_id === 'verdict').output).toMatchObject({ overall: 'unavailable', propose_fix: false, counts: { pass: 0, fail: 0, unavailable: 2 } });
    expect(done.approvals).toHaveLength(0);
    expect(gh.created).toHaveLength(made);
  });
});
