import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * Mission control (docs/mission-control-plan.md): the static app, signed in through the URL
 * fragment, following a live run over SSE, deciding an approval and starting a run from the
 * browser through the same API and role checks as the CLI, and never showing a secret value.
 * Runs in the pre-installed Chromium against the built bundle.
 */
const CHROMIUM = process.env.AZHI_CHROMIUM ?? '/opt/pw-browsers/chromium';
const up = await temporalAvailable();

describe.skipIf(!up)('mission control', () => {
  let h: Harness;
  let browser: Browser;
  let version: string;
  let token: string;
  const errors: string[] = [];

  beforeAll(async () => {
    if (!existsSync('src/web/dist/index.html') || process.env.AZHI_BUILD_WEB) execSync('npm run build:web', { stdio: 'ignore' });
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

  async function open(path: string, t = token): Promise<Page> {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${h.server.url}${path}#token=${encodeURIComponent(t)}`);
    // The token leaves the address bar as soon as the app has read it.
    await page.waitForFunction(() => !location.hash);
    return page;
  }

  it('serves a static app with no data and a strict CSP, and keeps the API authenticated', async () => {
    const res = await fetch(`${h.server.url}/ui/runs/run_x`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await res.text()).not.toContain('run_x');
    const asset = (await fetch(`${h.server.url}/ui`).then((r) => r.text())).match(/\/ui\/assets\/[^"]+\.js/)![0];
    expect((await fetch(`${h.server.url}${asset}`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${h.server.url}/v1/runs`)).status).toBe(403);
    expect((await fetch(`${h.server.url}/v1/overview`)).status).toBe(403);
    expect((await fetch(`${h.server.url}/ui/assets/..%2F..%2Froutes.ts`)).status).toBe(404);
  });

  it('follows a live run and approves it from the browser', async () => {
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team: 'payments' } });
    const page = await open(`/ui/runs/${run_id}`);
    await page.getByText('waiting for approval on approve').waitFor({ timeout: 30_000 });
    expect(await page.locator('svg .node.st-waiting').count()).toBe(1);
    await page.getByText('Post 4 runs to C-QUALITY?').waitFor();

    await page.getByLabel('note').fill('looks right');
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByText('Decision sent').waitFor();
    await waitForRun(h.api, run_id);
    await page.getByText('finished').waitFor({ timeout: 30_000 });
    expect(await page.locator('svg .node.st-succeeded').count()).toBe(3);
    const d = await h.api.get<any>(`/v1/runs/${run_id}`);
    expect(d.approvals[0]).toMatchObject({ decision: 'approved', data: { note: 'looks right' } });

    const timeline = await page.locator('.tab').innerText();
    expect(timeline).toContain('approval.decided');
    await page.getByRole('tab', { name: 'Action ledger' }).click();
    expect(await page.locator('.tab').innerText()).toMatch(/slack\.post-message@1[\s\S]*confirmed/);
    await page.getByRole('tab', { name: 'Policy coverage' }).click();
    expect(await page.locator('.tab').innerText()).toContain('as it stood when the run was created');
    await page.close();
  });

  it('lists waiting approvals, and refuses a decision from a role that may not make it', async () => {
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team: 'payments' } });
    for (let i = 0; i < 100; i++) {
      if ((await h.api.get<any[]>('/v1/approvals')).some((a) => a.run_id === run_id)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const u = await h.api.post<{ token: string }>('/v1/users', { display_name: 'viewer', role: 'viewer' });
    const viewer = new ApiClient(h.server.url, u.token);
    const mine = (await viewer.get<any[]>('/v1/approvals')).find((a) => a.run_id === run_id);
    expect(mine).toMatchObject({ node_id: 'approve', role: 'operator', can_decide: false, workflow: 'approval-check' });

    const page = await open('/ui/approvals', u.token);
    await page.getByText('Your role cannot decide this one.').first().waitFor();
    expect(await page.getByRole('button', { name: 'Approve' }).count()).toBe(0);
    await page.close();

    const overview = await h.api.get<any>('/v1/overview');
    expect(overview.approvals.pending).toBeGreaterThanOrEqual(1);
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'approve', decision: 'rejected' });
    await waitForRun(h.api, run_id);
  });

  it('shows the overview and starts a test run from the workflow page', async () => {
    const page = await open('/ui');
    await page.getByRole('heading', { name: 'Mission control' }).waitFor();
    await page.getByText('Succeeded (24 h)').waitFor();
    await page.getByRole('link', { name: 'Workflows', exact: true }).click();
    await page.getByRole('link', { name: 'approval-check' }).click();
    await page.getByRole('heading', { name: 'Run plan' }).waitFor();
    await page.getByLabel('team').fill('search');
    await page.getByRole('button', { name: 'Test run' }).click();
    await page.waitForURL(/\/ui\/runs\/run_/);
    const id = decodeURIComponent(page.url().split('/').pop()!);
    const d = await h.api.get<any>(`/v1/runs/${id}`);
    expect(d.run).toMatchObject({ test: true, inputs: { team: 'search' }, created_by: expect.stringMatching(/^usr_/) });
    await page.close();
  });

  it('sets a secret without the value ever coming back, and audits it', async () => {
    const page = await open('/ui/secrets');
    await page.getByLabel('Name').fill('ui-test-key');
    await page.getByLabel('Value').fill('sk-super-secret-value');
    await page.getByRole('button', { name: 'Save new version' }).click();
    await page.getByText('ui-test-key is now version 1.').waitFor();
    await page.reload();
    await page.getByRole('cell', { name: 'ui-test-key' }).waitFor();
    expect(await page.content()).not.toContain('sk-super-secret-value');
    expect(JSON.stringify(await h.api.get('/v1/secrets'))).not.toContain('sk-super-secret-value');
    const audit = await h.api.get<any[]>('/v1/audit');
    expect(audit.some((e) => e.kind === 'secret.changed' && e.data.name === 'ui-test-key')).toBe(true);
    await page.close();
  });

  it('summarises usage, alerts and schedules, and turns a schedule off through the audited API', async () => {
    const usage = await h.api.get<any>('/v1/usage/summary?days=7');
    expect(usage).toMatchObject({ days: 7, by_day: expect.any(Array), by_workflow: expect.any(Array) });
    expect(Array.isArray(await h.api.get('/v1/alerts'))).toBe(true);

    await h.api.post('/v1/schedules', { workflow: 'approval-check', cron: '0 9 * * 1', timezone: 'Europe/London', inputs: { team: 'payments' } });
    const [s] = await h.api.get<any[]>('/v1/schedules/summary');
    expect(s).toMatchObject({ workflow: 'approval-check', enabled: true });
    const page = await open('/ui/schedules');
    await page.getByRole('button', { name: 'Turn off' }).click();
    await page.getByRole('button', { name: 'Turn on' }).waitFor();
    expect((await h.api.get<any[]>('/v1/schedules/summary'))[0].enabled).toBe(false);
    expect((await h.api.get<any[]>('/v1/audit')).some((e) => e.kind === 'schedule.changed' && e.data.enabled === false)).toBe(true);
    await page.close();
  });

  it('asks for a token when none is held, and raised no page errors', async () => {
    const page = await browser.newPage();
    await page.goto(`${h.server.url}/ui/runs`);
    await page.getByPlaceholder('API token').fill(token);
    await page.getByRole('button', { name: 'Open' }).click();
    await page.getByRole('heading', { name: 'Runs' }).waitFor();
    await page.locator('tbody tr').first().waitFor();
    await page.close();
    expect(errors).toEqual([]);
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
});
