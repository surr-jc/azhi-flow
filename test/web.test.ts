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
    expect((await fetch(`${h.server.url}/favicon.ico`)).status).toBe(204);
  });

  it('follows a live run and approves it from the browser', async () => {
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team: 'payments' } });
    const page = await open(`/ui/runs/${run_id}`);
    await page.getByText('Waiting for a person to decide at step approve').waitFor({ timeout: 30_000 });
    expect(await page.locator('.wf-card.st-waiting').count()).toBe(1);
    // The decision is pinned to the waiting step on the canvas, and in full below it.
    await page.locator('.atlas-pop').getByText('Post 4 runs to C-QUALITY?').waitFor();
    await page.locator('#decision').getByText('Post 4 runs to C-QUALITY?').waitFor();

    await page.getByLabel('note').fill('looks right');
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByText('Decision recorded').waitFor();
    await waitForRun(h.api, run_id);
    await page.locator('.crumbs .live', { hasText: 'finished' }).waitFor({ timeout: 30_000 });
    expect(await page.locator('.wf-card.st-succeeded').count()).toBe(3);
    // Scrubbing back to the first event shows the run before any step had started.
    await page.getByLabel('Event to show the run at').fill('0');
    expect(await page.locator('.wf-card.st-succeeded').count()).toBe(0);
    await page.getByRole('button', { name: 'Back to live' }).click();
    expect(await page.locator('.wf-card.st-succeeded').count()).toBe(3);
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
    await page.getByRole('heading', { name: 'Waiting for a decision' }).waitFor();
    // The mission control strip: each tile opens the runs behind its number.
    const tiles = page.getByRole('navigation', { name: 'System status' });
    await tiles.getByRole('link', { name: /Needs you/ }).waitFor();
    await tiles.getByRole('link', { name: /Failed/ }).click();
    await page.waitForURL(/\/ui\/runs\?state=failed/);
    expect(await page.locator('.tile.active').innerText()).toContain('Failed');
    await page.getByRole('link', { name: 'Workflows', exact: true }).click();
    await page.getByRole('link', { name: 'approval-check' }).click();
    await page.getByRole('heading', { name: 'Run plan' }).waitFor();
    await page.getByRole('button', { name: 'Run…' }).click();
    await page.getByLabel('team').fill('search');
    await page.getByRole('button', { name: 'Test run' }).click();
    await page.waitForURL(/\/ui\/runs\/run_/);
    const id = decodeURIComponent(page.url().split('/').pop()!);
    const d = await h.api.get<any>(`/v1/runs/${id}`);
    expect(d.run).toMatchObject({ test: true, inputs: { team: 'search' }, created_by: expect.stringMatching(/^usr_/) });
    await page.close();
  });

  it('chooses the provider and model for default-model steps: in the runner, the workflow settings and the editor', async () => {
    await h.api.put('/v1/secrets/anthropic-api-key', { value: 'sk-ant-test' });
    const models = (await uploadDir(h.api, 'test/fixtures/models')).version.id;
    const page = await open('/ui/workflows/model-check');
    await page.getByRole('heading', { name: 'Run plan' }).waitFor();

    // The dock names who decides each step's model.
    await page.getByRole('button', { name: /Models/ }).first().click();
    await page.getByText('Workflow default').first().waitFor();
    expect(await page.locator('.settings-main').innerText()).toContain('none: each default-model step uses the server');
    await page.keyboard.press('Escape');

    // The runner: pick OpenAI-less Anthropic with a model; only the default-model step follows it.
    await page.getByRole('button', { name: 'Run…' }).click();
    await page.getByLabel('Team').fill('search');
    await page.locator('select[name="run-provider"]').selectOption('anthropic');
    await page.locator('select[name="run-model"]').selectOption('__other__');
    await page.getByRole('textbox', { name: 'Model id' }).fill('claude-sonnet-5-5');
    await page.getByRole('button', { name: 'Use', exact: true }).click();
    await page.getByText('Which model each step will use').click();
    const rows = page.getByLabel('Model of each agent step').locator('tbody tr');
    await rows.filter({ hasText: 'draft' }).getByText('chosen for this run').waitFor();
    expect(await rows.filter({ hasText: 'pinned' }).innerText()).toContain('claude-opus-5-5');
    expect(await rows.filter({ hasText: 'pinned' }).innerText()).toContain('named by the step');
    await page.getByRole('button', { name: 'Test run' }).click();
    await page.waitForURL(/\/ui\/runs\/run_/);
    const id = decodeURIComponent(page.url().split('/').pop()!);
    const d = await h.api.get<any>(`/v1/runs/${id}`);
    expect(d.run.snapshot).toMatchObject({ model_defaults: { provider: 'anthropic', name: 'claude-sonnet-5-5' }, model_defaults_chosen: true });
    await h.api.post(`/v1/runs/${id}/cancel`, {});

    // The editor: set the workflow's default and save it as a draft.
    await page.goto(`${h.server.url}/ui/workflows/model-check/edit?from=${models}`);
    await page.getByRole('heading', { name: 'Workflow', exact: true }).waitFor();
    await page.locator('select[name="workflow-provider"]').selectOption('anthropic');
    await page.getByRole('button', { name: 'Save draft' }).waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes('Checking…'));
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForURL(/\/ui\/workflows\/model-check\?version=/);
    const draftId = decodeURIComponent(new URL(page.url()).searchParams.get('version')!);
    const saved = await h.api.get<any>(`/v1/versions/${draftId}`);
    expect(saved.definition.model_defaults).toEqual({ provider: 'anthropic' });
    expect(saved.plan.nodes.find((n: any) => n.id === 'draft')).toBeDefined();
    await page.close();
  });

  it('tells you what an example needs before you install it, and holds the install until it is given', async () => {
    const page = await open('/ui/examples/ai-sdlc');
    const before = page.getByRole('region', { name: 'Before you install' });
    await before.waitFor();
    const text = await before.innerText();
    expect(text).toContain('the install is refused without');
    expect(text).toMatch(/required\s*Slack channel/i);
    expect(text).toMatch(/optional\s*Jira site\s*only for Jira tickets/i);
    expect(text).toMatch(/set\s*Secret github-read-token|later\s*Secret github-read-token/);
    const install = page.getByRole('button', { name: 'Install', exact: true });
    expect(await install.isDisabled()).toBe(true);
    await page.getByLabel(/^Repositories it may use/).fill('acme/shop');
    expect(await install.isDisabled()).toBe(true);
    await page.getByLabel(/^Slack channel/).fill('C0DELIVER');
    expect(await install.isDisabled()).toBe(false);
    expect(await before.innerText()).toContain('Everything required is in place.');
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

  it('sets a spend limit and the Slack alerts channel from the browser', async () => {
    const page = await open('/ui/usage');
    await page.getByRole('heading', { name: 'Spend limits' }).waitFor();
    await page.getByLabel('Limit in USD').fill('25');
    await page.getByRole('button', { name: 'Set limit' }).click();
    await page.getByRole('cell', { name: 'Whole workspace' }).waitFor();
    expect(await h.api.get<any[]>('/v1/budgets')).toEqual([expect.objectContaining({ workflow: null, period: 'month', limit: 25, exceeded: false })]);

    await page.getByRole('link', { name: 'Runs', exact: true }).click();
    await page.getByRole('link', { name: /^Alerts/ }).click();
    await page.getByLabel('Channel ID').fill('C-ALERTS');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved.').waitFor();
    await page.getByRole('button', { name: 'Send a test message' }).click();
    await page.getByText('Test message posted.').waitFor();
    expect(h.slack.messages.at(-1)).toMatchObject({ channel: 'C-ALERTS' });
    await page.close();
  });

  it('searches runs by input and date, cancels one from the list, and switches the theme', async () => {
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team: 'needle-team' } });
    expect((await h.api.get<any[]>('/v1/runs?q=needle')).map((r) => r.id)).toEqual([run_id]);
    expect((await h.api.get<any[]>(`/v1/runs?q=${run_id.slice(0, 12)}`)).map((r) => r.id)).toContain(run_id);
    expect(await h.api.get<any[]>('/v1/runs?q=100%25')).toEqual([]);
    expect(await h.api.get<any[]>(`/v1/runs?since=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`)).toEqual([]);

    const page = await open('/ui/runs');
    await page.getByLabel('Search runs').fill('needle');
    await page.getByLabel('Search runs').press('Enter');
    await page.waitForURL(/q=needle/);
    await page.getByRole('cell', { name: /needle-team/ }).waitFor();
    expect(await page.locator('tbody tr').count()).toBe(1);
    const today = new Date().toLocaleDateString('en-CA');
    await page.getByLabel('From').fill(today);
    await page.getByRole('cell', { name: /needle-team/ }).waitFor();
    await page.getByLabel('To').fill('2020-01-01');
    await page.getByText('No runs match.').waitFor();
    await page.getByRole('button', { name: 'Clear' }).click();

    page.on('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: `Cancel ${run_id}` }).click();
    expect((await waitForRun(h.api, run_id)).run.state).toBe('cancelled');

    await page.getByLabel('Theme').selectOption('dark');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(14, 20, 27)');
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.getByLabel('Theme').selectOption('system');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
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
