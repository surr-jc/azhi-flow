import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, type Harness } from './helpers/harness.js';
import { execSync } from 'node:child_process';

/**
 * The workflow editor (docs/mission-control-plan.md, increment 5 step 2): an edited definition
 * is checked by the server's compiler and run plan without being saved, and saved as a new
 * unsigned draft of the same workflow with the package's other files kept. In the browser, steps
 * are added, renamed, linked and saved from the canvas.
 */
const CHROMIUM = process.env.AZHI_CHROMIUM ?? '/opt/pw-browsers/chromium';
const up = await temporalAvailable();

describe.skipIf(!up)('workflow editor', () => {
  let h: Harness;
  let browser: Browser;
  let base: { id: string; version: number; package_hash: string };
  let def: any;
  const errors: string[] = [];

  beforeAll(async () => {
    if (!existsSync('src/web/dist/index.html') || process.env.AZHI_BUILD_WEB) execSync('npm run build:web', { stdio: 'ignore' });
    h = await startHarness({ worker: false });
    for (const t of parse(readFileSync('examples/sdlc/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    const r = await uploadDir(h.api, 'examples/sdlc');
    expect(r.ok).toBe(true);
    base = r.version;
    await h.api.post(`/v1/versions/${base.id}/publish`, {});
    def = (await h.api.get<any>(`/v1/versions/${base.id}`)).definition;
    browser = await chromium.launch({ executablePath: CHROMIUM });
  });
  afterAll(async () => {
    await browser?.close();
    await h?.stop();
  });

  it('checks an edit without saving it, and saves it as a new draft with the other files kept', async () => {
    const source = await h.api.get<any>(`/v1/versions/${base.id}/source`);
    expect(source.workflow).toBe('workflow.yaml');
    expect(source.files.find((f: any) => f.path === 'profiles/architect@1.yaml').text).toContain('model');

    const same = await h.api.post<any>(`/v1/versions/${base.id}/check`, { definition: def });
    expect(same).toMatchObject({ ok: true, plan: { workflow: 'sdlc' } });
    expect(same.yaml).toMatch(/^# Feature delivery across the SDLC/);

    const broken = { ...def, nodes: [...def.nodes, { id: 'oops', type: 'tool', tool: 'nope.missing@1', arguments: { x: { ref: 'nodes.ghost.output' } } }] };
    const bad = await h.api.post<any>(`/v1/versions/${base.id}/check`, { definition: broken });
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ node: 'oops', severity: 'error' })]));

    const renamed = await h.api.post<any>(`/v1/versions/${base.id}/check`, { definition: { ...def, id: 'other' } });
    expect(renamed.diagnostics).toEqual([expect.objectContaining({ code: 'workflow_id_changed' })]);

    const before = (await h.api.get<any[]>('/v1/workflows/sdlc/versions')).length;
    const edited = { ...def, nodes: [...def.nodes, { id: 'sign_off', type: 'approval', depends_on: ['retro'], role: 'operator', message: 'Close the ticket?' }] };
    const saved = await h.api.post<any>(`/v1/versions/${base.id}/drafts`, { definition: edited });
    expect(saved).toMatchObject({ ok: true, version: { workflow: 'sdlc', draft: true, signed: false } });
    expect((await h.api.get<any[]>('/v1/workflows/sdlc/versions')).length).toBe(before + 1);
    const v = await h.api.get<any>(`/v1/versions/${saved.version.id}`);
    expect(v.definition.nodes.at(-1)).toMatchObject({ id: 'sign_off', depends_on: ['retro'] });
    expect(v.manifest.files.map((f: any) => f.path)).toEqual(source.files.map((f: any) => f.path));
    const kept = (await h.api.get<any>(`/v1/versions/${saved.version.id}/source`)).files.find((f: any) => f.path === 'templates/retro.md');
    expect(kept.text).toBe(readFileSync('examples/sdlc/templates/retro.md', 'utf8'));
    // A draft is not published: publishing still needs the author's signature.
    await expect(h.api.post(`/v1/versions/${saved.version.id}/publish`, {})).rejects.toThrow(/signature/i);

    const u = await h.api.post<{ token: string }>('/v1/users', { display_name: 'op', role: 'operator' });
    await expect(new ApiClient(h.server.url, u.token).post(`/v1/versions/${base.id}/drafts`, { definition: edited })).rejects.toThrow(/author/);
    expect((await h.api.get<any[]>('/v1/audit')).some((e) => e.kind === 'workflow.version_created' && e.data.version_id === saved.version.id)).toBe(true);
  });

  it('the harness builder: lists executors, and checks and saves profiles with the draft', async () => {
    const ex = await h.api.get<any>('/v1/executors');
    expect(ex.executors.map((e: any) => e.id)).toEqual(expect.arrayContaining(['model-agent', 'opencode']));
    expect(ex.executors.find((e: any) => e.id === 'opencode').providers).toEqual(['anthropic', 'github-copilot']);

    const profile = 'model: {provider: anthropic, name: default, credential: anthropic-api-key}\ninstructions: Summarise the ticket.\n';
    const withNode = { ...def, nodes: [...def.nodes, { id: 'summary', type: 'agent', profile: 'summariser@1', output_schema: { type: 'object' } }] };
    // Without the profile the draft does not compile; with it the check passes.
    expect((await h.api.post<any>(`/v1/versions/${base.id}/check`, { definition: withNode })).ok).toBe(false);
    const ok = await h.api.post<any>(`/v1/versions/${base.id}/check`, { definition: withNode, profiles: { 'profiles/summariser@1.yaml': profile } });
    expect(ok.ok).toBe(true);

    const bad = await h.api.post<any>(`/v1/versions/${base.id}/check`, { definition: withNode, profiles: { 'profiles/summariser@1.yaml': 'model: {provider: nope}\ninstructions: x\n' } });
    expect(bad).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'profile_invalid' })] });
    const path = await h.api.post<any>(`/v1/versions/${base.id}/check`, { definition: def, profiles: { 'elsewhere.yaml': profile } });
    expect(path.diagnostics[0].code).toBe('profile_path');

    const saved = await h.api.post<any>(`/v1/versions/${base.id}/drafts`, { definition: withNode, profiles: { 'profiles/summariser@1.yaml': profile } });
    expect(saved.ok).toBe(true);
    const files = (await h.api.get<any>(`/v1/versions/${saved.version.id}/source`)).files;
    expect(files.find((f: any) => f.path === 'profiles/summariser@1.yaml').text).toBe(profile);
  });

  async function open(path: string): Promise<Page> {
    const token = readFileSync(h.server.localTokenFile!, 'utf8').trim();
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${h.server.url}${path}#token=${encodeURIComponent(token)}`);
    await page.waitForFunction(() => !location.hash);
    return page;
  }

  it('adds, renames and links a step on the canvas, shows problems, and saves a draft', async () => {
    const page = await open('/ui/workflows/sdlc');
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await page.getByRole('heading', { name: /^Edit Feature delivery/ }).waitFor();
    await page.getByText('compiles').waitFor();
    expect(await page.locator('.wf-card').count()).toBe(def.nodes.length);

    // A tool step with an unknown tool is flagged on its card and in the list.
    await page.getByRole('button', { name: 'Add Tool step' }).click();
    await page.getByLabel('Tool', { exact: true }).fill('nope.missing@1');
    await page.locator('.wf-card.has-problem').waitFor();
    await page.getByRole('button', { name: 'Remove step' }).click();
    await page.getByText('compiles').waitFor();

    await page.getByRole('button', { name: 'Add Approval gate step' }).click();
    await page.getByLabel('Step id').fill('sign_off');
    await page.getByLabel('Step id').press('Enter');
    await page.getByRole('region', { name: 'Step sign_off' }).waitFor();
    await page.getByLabel('Run after').selectOption('retro');
    await page.locator('[data-testid="rf__edge-retro->sign_off"]').waitFor({ state: 'attached' });
    await page.getByText('compiles').waitFor();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForURL(/\/ui\/workflows\/sdlc\?version=wfv_/);
    const id = new URL(page.url()).searchParams.get('version')!;
    const v = await h.api.get<any>(`/v1/versions/${id}`);
    expect(v.draft).toBe(true);
    expect(v.definition.nodes.find((n: any) => n.id === 'sign_off')).toMatchObject({ type: 'approval', depends_on: ['retro'] });
    await page.getByRole('heading', { name: 'Run plan' }).waitFor();
    await page.close();
    expect(errors).toEqual([]);
  });
  it('edits an agent step in the harness builder and saves its profile with the draft', async () => {
    const page = await open('/ui/workflows/sdlc');
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await page.getByText('compiles').waitFor();
    await page.getByRole('button', { name: 'Add Agent step' }).click();
    const region = page.getByRole('group', { name: 'Harness' });
    await region.waitFor();
    // Pick OpenCode: its capabilities show, and a new profile is created and edited.
    await region.locator('select').first().selectOption('opencode');
    await page.getByText('Built-in tools: switched off by permission rules').waitFor();
    await region.getByLabel('New profile name').fill('triage@1');
    await region.getByRole('button', { name: 'New profile' }).click();
    await region.getByLabel('Instructions').fill('Triage the ticket and say how urgent it is.');
    await region.getByLabel('Max turns').fill('4');
    await page.getByText('compiles').waitFor();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForURL(/\/ui\/workflows\/sdlc\?version=wfv_/);
    const id = new URL(page.url()).searchParams.get('version')!;
    const files = (await h.api.get<any>(`/v1/versions/${id}/source`)).files;
    const text = files.find((f: any) => f.path === 'profiles/triage@1.yaml').text as string;
    expect(parse(text)).toMatchObject({ instructions: 'Triage the ticket and say how urgent it is.', max_turns: 4, model: { provider: 'anthropic' } });
    const v = await h.api.get<any>(`/v1/versions/${id}`);
    expect(v.definition.nodes.find((n: any) => n.profile === 'triage@1')).toMatchObject({ type: 'agent', executor: 'opencode' });
    await page.close();
    expect(errors).toEqual([]);
  });
});
