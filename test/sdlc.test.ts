import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * The SDLC example (examples/sdlc) end to end with scripted agents, and the React Flow canvas
 * following it: two approval gates, the quality gate's routes, skipped branches.
 */
const CHROMIUM = process.env.AZHI_CHROMIUM ?? '/opt/pw-browsers/chromium';
const up = await temporalAvailable();

const OUTPUTS = {
  'product-analyst': { summary: 'Retry timed-out card payments once.', acceptance_criteria: ['A processor timeout is retried once after 2 s', 'Declines are never retried', 'The retry shows in payment history'], open_questions: [] },
  architect: { summary: 'Add a single retry in the payment client for timeouts', components: ['payments-client', 'payment-history'], approach: 'Wrap the processor call; on timeout wait 2 s and retry once.', risks: [{ risk: 'Double charge', mitigation: 'Reuse the idempotency key on retry' }], test_plan: 'Unit tests for timeout, decline and success paths.' },
  engineer: { summary: 'Timeout retry in ProcessorClient with the same idempotency key', files: [{ path: 'payments/client.ts', change: 'retry once on timeout' }], tests: ['retries once on timeout', 'never retries a decline'], risks: [] },
  reviewer: (approved: boolean) => ({ approved, summary: approved ? 'Covers every criterion.' : 'History entry for the retry is missing.', findings: approved ? [] : [{ severity: 'major', text: 'No payment history entry for the retry' }] }),
};

function packageDir(reviewApproves: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-sdlc-'));
  cpSync('examples/sdlc', dir, { recursive: true });
  for (const [name, out] of Object.entries(OUTPUTS)) {
    const output = typeof out === 'function' ? out(reviewApproves) : out;
    writeFileSync(join(dir, 'profiles', `${name}@1.yaml`), JSON.stringify({ model: { provider: 'scripted' }, instructions: 'scripted', pricing: { currency: 'USD', input_per_mtok: 1, output_per_mtok: 5, revision: 'test' }, script: [{ output }] }));
  }
  return dir;
}

async function waitForApproval(h: Harness, runId: string, node: string) {
  for (let i = 0; i < 150; i++) {
    const d = await h.api.get<any>(`/v1/runs/${runId}`);
    if (d.run.flags?.waiting_reason?.node === node) return d;
    if (['succeeded', 'failed', 'cancelled'].includes(d.run.state)) throw new Error(`run ended ${d.run.state}: ${JSON.stringify(d.run.error)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run ${runId} never waited on ${node}`);
}

const nodeState = (d: any, id: string) => d.attempts.filter((a: any) => a.node_id === id).at(-1)?.state;

describe.skipIf(!up)('SDLC example', () => {
  let h: Harness;
  let browser: Browser;
  let token: string;

  beforeAll(async () => {
    h = await startHarness({ worker: false });
    for (const t of parse(readFileSync('examples/sdlc/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    token = readFileSync(h.server.localTokenFile!, 'utf8').trim();
    browser = await chromium.launch({ executablePath: CHROMIUM });
  });
  afterAll(async () => {
    await browser?.close();
    await h?.stop();
  });

  it('compiles with no plan blockers and its taint gates in place', async () => {
    const up = await uploadDir(h.api, 'examples/sdlc');
    expect(up.ok).toBe(true);
    const plan = await h.api.get<any>(`/v1/versions/${up.version.id}/plan`);
    expect(plan.nodes.map((n: any) => n.id)).toEqual(['intake', 'requirements', 'design', 'design_review', 'build', 'code_review', 'tests', 'quality_gate', 'release_approval', 'release', 'send_back', 'retro']);
    expect(plan.blockers.filter((b: any) => b.code !== 'unsupported')).toEqual([]);
  });

  it('ships through both gates, shown live on the canvas', async () => {
    const version = (await uploadDir(h.api, packageDir(true))).version.id;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { ticket: 'PAY-142' } });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
    await page.goto(`${h.server.url}/ui/runs/${run_id}#token=${encodeURIComponent(token)}`);

    const first = await waitForApproval(h, run_id, 'design_review');
    expect(first.approvals[0].request.message).toBe('Approve the design for PAY-142: Add a single retry in the payment client for timeouts?');
    await page.locator('.react-flow__node[data-id="design_review"] .wf-card.st-waiting').waitFor({ timeout: 30_000 });
    expect(await page.locator('.react-flow__node').count()).toBe(12);
    expect(await page.locator('.react-flow__node[data-id="design"] .wf-card.st-succeeded').count()).toBe(1);

    // Selecting a node opens its details.
    await page.locator('.react-flow__node[data-id="quality_gate"]').click();
    await page.getByRole('region', { name: 'Node quality_gate' }).getByText("nodes.tests.output.status == 'passed'").waitFor();

    await page.getByRole('button', { name: 'Approve' }).click();
    await waitForApproval(h, run_id, 'release_approval');
    await page.locator('.react-flow__node[data-id="release_approval"] .wf-card.st-waiting').waitFor({ timeout: 30_000 });
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'release_approval', decision: 'approved' });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.state).toBe('succeeded');
    expect(nodeState(d, 'send_back')).toBe('skipped');
    expect(nodeState(d, 'retro')).toBe('succeeded');
    expect(h.slack.messages.map((m) => m.text)).toContain('Released PAY-142: Timeout retry in ProcessorClient with the same idempotency key');

    await page.locator('.react-flow__node[data-id="retro"] .wf-card.st-succeeded').waitFor({ timeout: 30_000 });
    await page.locator('.react-flow__node[data-id="send_back"] .wf-card.st-skipped').waitFor();
    expect(errors).toEqual([]);
    await page.close();
  });

  it('sends the change back when the review does not approve, skipping the release branch', async () => {
    const version = (await uploadDir(h.api, packageDir(false))).version.id;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { ticket: 'PAY-142' } });
    await waitForApproval(h, run_id, 'design_review');
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'design_review', decision: 'approved' });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.state).toBe('succeeded');
    for (const id of ['release_approval', 'release', 'retro']) expect(nodeState(d, id)).toBe('skipped');
    expect(nodeState(d, 'send_back')).toBe('succeeded');
    expect(h.slack.messages.map((m) => m.text)).toContain('PAY-142 needs more work: History entry for the retry is missing.');
  });
});
