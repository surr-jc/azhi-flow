import Fastify from 'fastify';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerExampleRoutes } from '../src/api/examples.js';
import { migrate } from '../src/db/migrate.js';
import { preflight } from '../src/plan/preflight.js';
import { loadToolRevision, registerTool } from '../src/server/catalog.js';
import { createContext } from '../src/server/context.js';
import { setSecret } from '../src/server/secrets.js';
import { getVersion } from '../src/server/workflows.js';
import { startFakeGithub } from '../src/testing/fake-github.js';
import { startFakeSlack } from '../src/testing/fake-slack.js';

// The provider's model list, which the real code reads over the network: tests set what it answers.
const modelList = vi.hoisted(() => ({ next: (): unknown => ({ provider: 'opencode', models: [], source: 'built-in' }), calls: [] as string[] }));
vi.mock('../src/builder/models.js', async (orig) => ({ ...(await orig<typeof import('../src/builder/models.js')>()), builderModels: async (_c: unknown, _w: string, provider: string) => (modelList.calls.push(provider), modelList.next()) }));

/** The workflow preflight: tools, secrets, GitHub tokens per repository, Slack. Real pr-review example, fake GitHub and Slack. */
process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
const WS = 'ws_pre';
describe('workflow preflight', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-pre-'));
  const app = Fastify();
  let ctx: ReturnType<typeof createContext>;
  let versionId: string;
  const stops: Array<() => Promise<void>> = [];
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  let slack: Awaited<ReturnType<typeof startFakeSlack>>;

  const run = async (inputs: Record<string, unknown>) => preflight(ctx, WS, (await getVersion(ctx, WS, versionId))!, { inputs });
  const failures = (r: Awaited<ReturnType<typeof run>>) => r.checks.filter((c) => c.status === 'fail');

  beforeAll(async () => {
    process.env.AZHI_EXAMPLES_DIR = join(dir, 'examples');
    cpSync('examples/pr-review', join(dir, 'examples', 'pr-review'), { recursive: true });
    gh = await startFakeGithub({ runs: [], issues: [] }, { token: ['read-token', 'write-token'], scopes: 'repo', repos: { 'acme/payments': { private: true, permissions: { pull: true, push: true } }, 'acme/ledger': { private: true, permissions: { pull: true, push: false } } } });
    slack = await startFakeSlack(0, { token: 'xoxb-ok' });
    stops.push(() => gh.stop(), () => slack.close());
    ctx = createContext({ databaseUrl: 'pglite://memory', dataDir: join(dir, 'data'), artifactDir: join(dir, 'artifacts'), slackApiUrl: slack.url });
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,'test')`, [WS]).catch(() => undefined);
    app.addHook('onRequest', async (req) => void (req.principal = { kind: 'user', workspaceId: WS, userId: 'usr_test', role: 'owner' } as never));
    registerExampleRoutes(app, ctx);
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/v1/examples/pr-review/install', payload: { repos: ['acme/payments'], api_url: gh.url, settings: { slack_channel: 'C0123ABCD' } } });
    expect(r.statusCode).toBe(200);
    versionId = r.json().version.id;
  });
  afterAll(async () => {
    await app.close();
    for (const s of stops) await s();
  });

  it('lists every missing secret before anything is checked live', async () => {
    const r = await run({ repo: 'acme/payments', pr: 7 });
    expect(r.ok).toBe(false);
    const names = failures(r).filter((c) => c.kind === 'secret').map((c) => c.target);
    expect(names).toEqual(expect.arrayContaining(['github-read-token', 'github-comment-token', 'github-copilot-token', 'slack-bot-token']));
    expect(failures(r).find((c) => c.target === 'github-comment-token')!.message).toContain('post');
  });

  it('passes when every token works for the repositories involved', async () => {
    await setSecret(ctx, WS, 'github-read-token', 'read-token', 'usr_test');
    await setSecret(ctx, WS, 'github-comment-token', 'write-token', 'usr_test');
    await setSecret(ctx, WS, 'github-merge-token', 'write-token', 'usr_test');
    await setSecret(ctx, WS, 'github-copilot-token', 'copilot', 'usr_test');
    await setSecret(ctx, WS, 'slack-bot-token', 'xoxb-ok', 'usr_test');
    const r = await run({ repo: 'acme/payments', pr: 7 });
    // The installed draft is not signed yet (the browser signs it): the run plan's own blocker is all that is left.
    expect(failures(r).map((c) => c.message)).toEqual(['package signature: package is not signed']);
    expect(r.checks.some((c) => c.kind === 'github' && c.status === 'ok' && c.target.startsWith('acme/payments with github-comment-token'))).toBe(true);
    expect(r.checks.some((c) => c.kind === 'slack' && c.status === 'ok')).toBe(true);
  });

  it('refuses a repository the tools do not allow', async () => {
    const r = await run({ repo: 'acme/other', pr: 7 });
    expect(r.ok).toBe(false);
    const f = failures(r).find((c) => c.kind === 'github' && c.target === 'acme/other' && c.node === 'pr')!;
    expect(f.message).toContain('not in the repositories');
    expect(f.fix).toContain('Connections');
  });

  it('tells which token and repository is wrong when an added repository cannot be used', async () => {
    // The ledger repository is allowed on the tools but the comment token can only read it.
    for (const ref of ['github.get-pull-request@1', 'github.comment-on-pr@1']) {
      const r = await app.inject({ method: 'POST', url: '/v1/examples/pr-review/repos', payload: { add: ['acme/ledger'] } });
      expect(r.statusCode).toBe(200);
      void ref;
    }
    const r = await run({ repo: 'acme/ledger', pr: 7 });
    const bad = failures(r).find((c) => c.kind === 'github' && c.target === 'acme/ledger with github-comment-token')!;
    expect(bad.message).toContain('not change');
    expect(failures(r).some((c) => c.target === 'acme/ledger with github-read-token')).toBe(false);
  });

  it('reports a Slack token that Slack refuses', async () => {
    await setSecret(ctx, WS, 'slack-bot-token', 'xoxb-bad', 'usr_test');
    const r = await run({ repo: 'acme/payments', pr: 7 });
    const f = failures(r).find((c) => c.kind === 'slack')!;
    expect(f.message).toContain('invalid_auth');
  });

  it('asks for an optional sign-in without blocking the run', async () => {
    const spec = (await loadToolRevision(ctx, WS, 'github.get-pull-request@1', undefined))!;
    const { revision: _r, ...cur } = spec;
    await registerTool(ctx, WS, { ...cur, credential: 'optional-sign-in', credential_optional: true }, 'usr_test');
    const r = await run({ repo: 'acme/payments', pr: 7 });
    expect(failures(r).some((c) => c.target === 'optional-sign-in')).toBe(false);
    const w = r.checks.find((c) => c.target === 'optional-sign-in')!;
    expect(w).toMatchObject({ status: 'warn', kind: 'secret', optional: true, node: 'pr' });
    // Required again: the same missing secret blocks.
    await registerTool(ctx, WS, { ...cur, credential: 'optional-sign-in' }, 'usr_test');
    expect(failures(await run({ repo: 'acme/payments', pr: 7 })).some((c) => c.target === 'optional-sign-in')).toBe(true);
  });

  describe('model availability', () => {
    // The run's own choice, as `--provider github-copilot --model ... --force-model` sends it.
    const choose = (name: string) => ({ provider: 'github-copilot' as const, name, force: true });
    const check = async (name: string) => preflight(ctx, WS, (await getVersion(ctx, WS, versionId))!, { inputs: { repo: 'acme/payments', pr: 7 }, modelDefaults: choose(name) });
    const models = (...ids: string[]) => ({ provider: 'opencode', models: ids.map((id) => ({ id, label: id })), source: 'live' });

    it('fails a model the provider does not list, naming the step and what is offered', async () => {
      modelList.next = () => models('claude-opus-5-5', 'gpt-5.5');
      const f = (await check('gpt-5.6-terra')).checks.filter((c) => c.kind === 'model' && c.status === 'fail');
      expect(f.length).toBe(1); // one check however many steps use the model
      expect(f[0]!.node).toBeTruthy();
      expect(f[0]!.message).toContain('gpt-5.6-terra');
      expect(f[0]!.message).toContain('claude-opus-5-5');
      expect(f[0]!.fix).toContain('--model');
    });

    it('passes a model the provider lists', async () => {
      modelList.next = () => models('gpt-5.5');
      const r = await check('gpt-5.5');
      expect(r.checks.filter((c) => c.kind === 'model').map((c) => c.status)).toEqual(['ok']);
    });

    it('warns, and never guesses, when the live list is not available', async () => {
      modelList.next = () => ({ provider: 'opencode', models: [], source: 'built-in', note: 'could not read Copilot\'s model list (HTTP 500)' });
      const m = (await check('gpt-5.6-terra')).checks.filter((c) => c.kind === 'model');
      expect(m.map((c) => c.status)).toEqual(['warn']);
      expect(m[0]!.message).toContain('Could not verify');
      modelList.next = () => { throw new Error('offline'); };
      expect((await check('gpt-5.6-terra')).checks.filter((c) => c.kind === 'model').map((c) => c.status)).toEqual(['warn']);
    });

    it("checks the run's model choice, not only the workflow's", async () => {
      modelList.calls.length = 0;
      modelList.next = () => models('gpt-5.5');
      const without = await run({ repo: 'acme/payments', pr: 7 });
      expect(without.checks.some((c) => c.kind === 'model' && c.target === 'github-copilot gpt-5.5')).toBe(false);
      expect((await check('gpt-5.5')).checks.some((c) => c.kind === 'model' && c.target === 'github-copilot gpt-5.5')).toBe(true);
      expect(modelList.calls).toContain('opencode'); // Copilot is listed under OpenCode's name
    });
  });
});
