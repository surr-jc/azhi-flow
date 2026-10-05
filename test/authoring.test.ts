import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, type Harness } from './helpers/harness.js';

/**
 * Authoring in mission control (docs/mission-control-plan.md, increment 3), in the browser:
 * uploading a package folder as a draft, reading its files, publishing a signed draft, editing a
 * schedule, dataset documents and revisions, and registering and changing a tool. Each goes
 * through the existing endpoint, role check and audit log.
 */
const CHROMIUM = process.env.AZHI_CHROMIUM ?? '/opt/pw-browsers/chromium';
const up = await temporalAvailable();

describe.skipIf(!up)('authoring in mission control', () => {
  let h: Harness;
  let browser: Browser;
  let token: string;
  const errors: string[] = [];

  beforeAll(async () => {
    if (!existsSync('src/web/dist/index.html') || process.env.AZHI_BUILD_WEB) execSync('npm run build:web', { stdio: 'ignore' });
    h = await startHarness({ worker: false });
    for (const t of parse(readFileSync('examples/sdlc/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    token = readFileSync(h.server.localTokenFile!, 'utf8').trim();
    browser = await chromium.launch({ executablePath: CHROMIUM });
  });
  afterAll(async () => {
    await browser?.close();
    await h?.stop();
  });

  async function open(path: string, t = token): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`${h.server.url}${path}#token=${encodeURIComponent(t)}`);
    await page.waitForFunction(() => !location.hash);
    return page;
  }

  it('uploads a package folder as an unsigned draft and shows its files', async () => {
    const page = await open('/ui/workflows');
    await page.getByRole('link', { name: 'Upload a workflow' }).click();
    await page.getByLabel('Package folder').setInputFiles('examples/sdlc');
    await page.getByRole('cell', { name: 'profiles/architect@1.yaml' }).waitFor();
    // The local tool config never goes into a package.
    expect(await page.getByRole('cell', { name: 'azhi.config.yaml' }).count()).toBe(0);
    await page.getByRole('button', { name: /^Upload \d+ files$/ }).click();
    await page.waitForURL(/\/ui\/workflows\/sdlc\?version=wfv_/);
    const id = new URL(page.url()).searchParams.get('version')!;
    const v = await h.api.get<any>(`/v1/versions/${id}`);
    expect(v).toMatchObject({ draft: true, signature: null });
    expect(v.manifest.files.map((f: any) => f.path)).toContain('templates/retro.md');
    await page.getByText('This draft is not signed').waitFor();

    await page.getByText('Files in this version').click();
    expect(await page.getByLabel('Contents of workflow.yaml').innerText()).toContain('id: sdlc');
    await page.getByRole('button', { name: 'templates/retro.md' }).click();
    expect((await page.getByLabel('Contents of templates/retro.md').innerText()).trim()).toBe(readFileSync('examples/sdlc/templates/retro.md', 'utf8').trim());
    await page.close();
  });

  it('shows what the compiler refused when an upload does not compile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-bad-'));
    writeFileSync(join(dir, 'workflow.yaml'), 'schema_version: "2.0"\nid: broken\nnodes:\n  - {id: a, type: tool, tool: nope.missing@1}\n');
    const page = await open('/ui/workflows/upload');
    await page.getByLabel('Package files').setInputFiles(join(dir, 'workflow.yaml'));
    await page.getByRole('button', { name: 'Upload 1 file' }).click();
    await page.getByText(/a: tool 'nope.missing@1' is not registered/).waitFor();
    await page.close();
  });

  it('publishes a signed draft and edits the schedule', async () => {
    const draft = (await uploadDir(h.api, 'test/fixtures/approval')).version;
    expect(draft).toMatchObject({ draft: true, signed: true });
    const page = await open('/ui/workflows/approval-check');
    await page.getByRole('button', { name: `Publish v${draft.version}` }).click();
    await page.getByText('published', { exact: true }).waitFor();
    expect((await h.api.get<any>(`/v1/versions/${draft.id}`)).draft).toBe(false);

    await page.getByText('Schedule', { exact: true }).click();
    await page.getByLabel('Cron').fill('30 8 * * 1-5');
    await page.getByLabel('Timezone').fill('Asia/Kolkata');
    await page.locator('#s-team').fill('payments');
    await page.getByRole('button', { name: 'Add schedule' }).click();
    await page.getByText(/^Saved\. Next run/).waitFor();
    const s = (await h.api.get<any[]>('/v1/schedules/summary')).find((x) => x.workflow === 'approval-check');
    expect(s).toMatchObject({ cron: '30 8 * * 1-5', timezone: 'Asia/Kolkata', inputs: { team: 'payments' }, enabled: true });
    expect((await h.api.get<any[]>('/v1/audit')).some((e) => e.kind === 'schedule.changed' && e.data.cron === '30 8 * * 1-5')).toBe(true);

    await page.getByLabel('Cron').fill('not a cron');
    await page.getByRole('button', { name: 'Save schedule' }).click();
    await page.locator('.error').first().waitFor();
    await page.close();
  });

  it('creates a dataset, adds a document, publishes a revision and revokes the document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-docs-'));
    writeFileSync(join(dir, 'oncall.md'), '# On call\n\nPage the payments lead when card retries fail twice.\n');
    const page = await open('/ui/datasets');
    await page.getByLabel('Dataset name').fill('runbooks');
    await page.getByRole('button', { name: 'Create dataset' }).click();
    await page.waitForURL(/\/ui\/datasets\/runbooks$/);
    await page.getByLabel('Documents').setInputFiles(join(dir, 'oncall.md'));
    await page.getByText('not published yet').waitFor();
    await page.getByLabel('Tag').fill('approved');
    await page.getByRole('button', { name: 'Publish a revision' }).click();
    await page.getByText(/Published r1: 1 documents/).waitFor();
    await page.getByRole('cell', { name: 'approved' }).waitFor();
    const hits = await h.api.post<any>('/v1/datasets/runbooks@approved/search', { query: 'card retries' });
    expect(JSON.stringify(hits)).toContain('payments lead');

    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByText('revoked', { exact: true }).waitFor();
    expect((await h.api.get<any>('/v1/datasets/runbooks')).documents[0]).toMatchObject({ path: 'oncall.md', revoked: true });

    // A role below author can read the dataset but not change it.
    const u = await h.api.post<{ token: string }>('/v1/users', { display_name: 'viewer', role: 'viewer' });
    const viewer = await open('/ui/datasets/runbooks', u.token);
    await viewer.getByRole('heading', { name: 'Revisions' }).waitFor();
    expect(await viewer.getByRole('button', { name: 'Publish a revision' }).count()).toBe(0);
    await expect(new ApiClient(h.server.url, u.token).post('/v1/datasets/runbooks/publish', {})).rejects.toThrow(/author/);
    await viewer.close();
    await page.close();
  });

  it('registers a tool and changes it as a new revision', async () => {
    const page = await open('/ui/tools');
    await page.getByRole('button', { name: 'Register a tool' }).click();
    await page.getByRole('button', { name: 'Register tool' }).click();
    await page.getByText('Saved tracker.get-ticket@1, revision 2.').waitFor();

    const spec = (await h.api.get<any[]>('/v1/tools')).find((t) => t.id === 'ci.list-runs');
    await page.getByRole('row', { name: new RegExp(`ci\\.list-runs@${spec.version}`) }).getByRole('button', { name: 'Change' }).click();
    const box = page.getByLabel('Tool definition (JSON)');
    await box.fill((await box.inputValue()).replace(spec.description, 'Lists CI runs (changed in the browser)'));
    await page.getByRole('button', { name: 'Register tool' }).click();
    await page.getByText(`Saved ci.list-runs@${spec.version}, revision ${spec.revision + 1}.`).waitFor();
    expect((await h.api.get<any[]>('/v1/tools')).find((t) => t.id === 'ci.list-runs').description).toBe('Lists CI runs (changed in the browser)');
    expect((await h.api.get<any[]>('/v1/audit')).some((e) => e.kind === 'tool.registered' && e.data.tool === `ci.list-runs@${spec.version}`)).toBe(true);
    await page.close();
    expect(errors).toEqual([]);
  });
});
