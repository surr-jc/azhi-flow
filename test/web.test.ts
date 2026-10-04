import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * The read-only run page: served without data, signed in through the URL fragment, following a
 * live run over SSE (an approval wait, then the decision) and showing the ledger, coverage and
 * timeline. Runs in the pre-installed Chromium.
 */
const CHROMIUM = process.env.AZHI_CHROMIUM ?? '/opt/pw-browsers/chromium';
const up = await temporalAvailable();

describe.skipIf(!up)('web run page', () => {
  let h: Harness;
  let browser: Browser;
  let version: string;
  let token: string;

  beforeAll(async () => {
    h = await startHarness();
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    version = (await uploadDir(h.api, 'test/fixtures/approval')).version.id;
    token = readFileSync(h.server.localTokenFile!, 'utf8').trim();
    browser = await chromium.launch({ executablePath: CHROMIUM });
  });
  afterAll(async () => {
    await browser?.close();
    await h?.stop();
  });

  it('serves a static page with no data and a strict CSP, and keeps the API authenticated', async () => {
    const res = await fetch(`${h.server.url}/ui/runs/run_x`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await res.text()).not.toContain('run_x');
    expect((await fetch(`${h.server.url}/v1/runs`)).status).toBe(403);
    expect((await fetch(`${h.server.url}/ui/assets/../app.ts`)).status).toBe(404);
  });

  it('follows a live run: waits for approval, updates when approved, shows ledger, coverage and timeline', async () => {
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team: 'payments' } });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${h.server.url}/ui/runs/${run_id}#token=${encodeURIComponent(token)}`);
    // The token leaves the address bar as soon as the page has read it.
    await page.waitForFunction(() => !location.hash);
    await page.getByText('waiting for approval on approve').waitFor({ timeout: 30_000 });
    expect(await page.locator('svg .node.st-waiting').count()).toBe(1);

    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'approve', decision: 'approved' });
    await waitForRun(h.api, run_id);
    await page.locator('.badge.s-succeeded').first().waitFor({ timeout: 30_000 });
    await page.getByText('finished').waitFor();
    expect(await page.locator('svg .node.st-succeeded').count()).toBe(3);
    expect(await page.locator('main').innerText()).not.toMatch(/^(null|undefined)$/m);

    const timeline = await page.locator('.tab').innerText();
    expect(timeline).toContain('run.planned');
    expect(timeline).toContain('approval.requested');
    expect(timeline).toContain('approval.decided');

    await page.getByRole('tab', { name: 'Action ledger' }).click();
    expect(await page.locator('.tab').innerText()).toMatch(/slack\.post-message@1[\s\S]*confirmed/);
    await page.getByRole('tab', { name: 'Policy coverage' }).click();
    const coverage = await page.locator('.tab').innerText();
    expect(coverage).toContain('enforced');
    expect(coverage).toContain('as it stood when the run was created');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('resumes the event stream from Last-Event-ID without repeating events', async () => {
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team: 'payments' }, test: true });
    const all = await h.api.get<Array<{ seq: number }>>(`/v1/runs/${run_id}/events`);
    expect(all.length).toBeGreaterThan(1);
    const res = await fetch(`${h.server.url}/v1/runs/${run_id}/events`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'last-event-id': String(all[0]!.seq) } });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const ids = [...value!.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids[0]).toBe(all[1]!.seq);
    expect(ids).not.toContain(all[0]!.seq);
  });

  it('asks for a token when none is held', async () => {
    const page = await browser.newPage();
    await page.goto(`${h.server.url}/ui`);
    await page.getByPlaceholder('API token').fill(token);
    await page.getByRole('button', { name: 'Open' }).click();
    await page.getByRole('heading', { name: 'Runs' }).waitFor();
    expect(await page.locator('tbody tr').count()).toBeGreaterThan(0);
    await page.close();
  });
});
