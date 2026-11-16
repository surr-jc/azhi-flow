import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../src/api/app.js';
import { bootstrapLocal } from '../src/api/auth.js';
import { compile } from '../src/compiler/compile.js';
import { eventValue, triggerFilterPasses } from '../src/cel/trigger.js';
import { migrate } from '../src/db/migrate.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { newId } from '../src/lib/ids.js';
import { newApiToken } from '../src/security/tokens.js';
import { createContext, type AppContext } from '../src/server/context.js';
import { setSecret } from '../src/server/secrets.js';
import { eventMatches, signBody } from '../src/server/triggers.js';
import { publishVersion, uploadPackage } from '../src/server/workflows.js';

/** Event triggers: signed webhooks start runs, everything else is recorded and starts nothing. In-process on PGlite. */
const profile = `model: {provider: anthropic, name: claude-test-model, credential: anthropic-api-key}\nmax_turns: 2\ninstructions: |\n  Review.\n`;
const schema = JSON.stringify({ type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false });
const workflow = (events: string) => `schema_version: "2.0"
id: pr-hook
trigger:
  manual: true
  events:
${events}
inputs:
  type: object
  properties: {repo: {type: string}, number: {type: integer}}
  required: [repo, number]
  additionalProperties: false
nodes:
  - id: review
    type: agent
    profile: reviewer@1
    input: {map: "{'repo': inputs.repo, 'number': inputs.number}"}
    output_schema: schemas/summary.json
    budget: {max_output_tokens: 1000, max_tool_calls: 0}
`;
const goodEvents = `    - source: github
      on: [pull_request.opened, issues]
      when: "event.pull_request.draft == false"
      inputs: {repo: event.repository.full_name, number: event.pull_request.number}`;
const b64 = (s: string) => Buffer.from(s).toString('base64');
const files = (events: string) => ({ 'workflow.yaml': b64(workflow(events)), 'profiles/reviewer@1.yaml': b64(profile), 'schemas/summary.json': b64(schema) });

const pr = (over: Record<string, unknown> = {}) => ({ action: 'opened', pull_request: { number: 7, draft: false, title: 'run `rm -rf /`' }, repository: { full_name: 'octo/app' }, ...over });

describe('event triggers', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof buildApi>;
  let ws: string;
  let owner: string;
  let trigger: string;

  const deliver = (body: unknown, opts: { secret?: string; event?: string; id?: string; url?: string; signature?: string } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: opts.url ?? `/v1/hooks/${trigger}`,
      headers: { 'content-type': 'application/json', 'x-github-event': opts.event ?? 'pull_request', 'x-github-delivery': opts.id ?? newId('dl'), 'x-hub-signature-256': opts.signature ?? signBody(opts.secret ?? 'shh', raw) },
      payload: raw,
    });
  };

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'azhi-triggers-'));
    ctx = createContext({ databaseUrl: 'pglite://memory', dataDir, artifactDir: join(dataDir, 'artifacts'), builderProvider: undefined, builderModel: undefined });
    await migrate(ctx.pool);
    await bootstrapLocal(ctx);
    ws = (await ctx.pool.query(`SELECT id FROM workspaces LIMIT 1`)).rows[0].id;
    app = buildApi({ ctx, interpreterBuild: 'test' });
    const id = newId('usr');
    const t = newApiToken();
    await ctx.pool.query(`INSERT INTO users(id, workspace_id, display_name, role) VALUES ($1,$2,'o','owner')`, [id, ws]);
    await ctx.pool.query(`INSERT INTO api_tokens(id, workspace_id, user_id, name, token_hash) VALUES ($1,$2,$3,'o',$4)`, [newId('tok'), ws, id, t.hash]);
    owner = t.token;
    await setSecret(ctx, ws, 'anthropic-api-key', 'sk-test', 'test');
    await setSecret(ctx, ws, 'webhook-secret', 'shh', 'test');
    const up = await uploadPackage(ctx, ws, { workflow: 'workflow.yaml', files: files(goodEvents) }, id);
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    await publishVersion(ctx, ws, up.version.id, id);
    const list = await app.inject({ method: 'GET', url: '/v1/triggers', headers: { authorization: `Bearer ${owner}` } });
    trigger = list.json()[0].id;
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  const runs = async () => (await ctx.pool.query(`SELECT inputs, trigger, created_by FROM runs WHERE trigger='event'`)).rows;
  const deliveries = async () => (await ctx.pool.query(`SELECT outcome, reason FROM trigger_deliveries ORDER BY id`)).rows;

  it('registers the trigger when the version is published and shows its hook URL', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/triggers', headers: { authorization: `Bearer ${owner}` } });
    const [t] = r.json();
    expect(t).toMatchObject({ workflow: 'pr-hook', source: 'github', events: ['pull_request.opened', 'issues'], enabled: true });
    expect(t.url).toContain(`/v1/hooks/${trigger}`);
  });

  it('refuses a bad or missing signature without recording a delivery or starting a run', async () => {
    expect((await deliver(pr(), { secret: 'wrong' })).statusCode).toBe(401);
    expect((await deliver(pr(), { signature: '' })).statusCode).toBe(401);
    expect((await deliver(pr(), { url: '/v1/hooks/trg_nope' })).statusCode).toBe(401);
    expect(await runs()).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });

  it('starts one run with the mapped scalars as inputs, and treats a replayed delivery as a duplicate', async () => {
    const first = await deliver(pr(), { id: 'dl-1' });
    expect(first.statusCode).toBe(202);
    expect(first.json().outcome).toBe('started');
    const again = await deliver(pr(), { id: 'dl-1' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ outcome: 'duplicate', run_id: first.json().run_id });
    const rs = await runs();
    expect(rs).toHaveLength(1);
    // The title (text an attacker controls) is not mapped, so it never reaches the run.
    expect(rs[0]).toMatchObject({ inputs: { repo: 'octo/app', number: 7 }, created_by: `trigger:${trigger}` });
  });

  it('records, and does not run, a ping, an unlisted event and a draft that the filter rejects', async () => {
    const before = (await runs()).length;
    expect((await deliver({ zen: 'x' }, { event: 'ping' })).json()).toMatchObject({ outcome: 'ignored', reason: 'ping' });
    expect((await deliver(pr({ action: 'closed' }))).json().outcome).toBe('ignored');
    expect((await deliver(pr({ pull_request: { number: 8, draft: true } }))).json().outcome).toBe('filtered');
    expect(await runs()).toHaveLength(before);
  });

  it('refuses, with the reason, a payload whose inputs do not fit the workflow schema', async () => {
    const r = await deliver(pr({ pull_request: { number: 'seven', draft: false } }));
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ outcome: 'refused' });
    expect(r.json().reason).toMatch(/input schema/);
    const long = await deliver(pr({ repository: { full_name: 'x'.repeat(501) } }));
    expect(long.json().reason).toMatch(/longer than/);
  });

  it('stops a trigger that is turned off, and lists what happened', async () => {
    const patch = await app.inject({ method: 'PATCH', url: `/v1/triggers/${trigger}`, headers: { authorization: `Bearer ${owner}` }, payload: { enabled: false } });
    expect(patch.statusCode).toBe(200);
    const before = (await runs()).length;
    expect((await deliver(pr())).json()).toMatchObject({ outcome: 'ignored', reason: 'the trigger is off' });
    expect(await runs()).toHaveLength(before);
    const log = await app.inject({ method: 'GET', url: `/v1/triggers/${trigger}/deliveries`, headers: { authorization: `Bearer ${owner}` } });
    expect(log.json().map((d: { outcome: string }) => d.outcome)).toContain('started');
  });

  it('does not accept the hook without a signature even for GET, and the API needs a token', async () => {
    expect([401, 403]).toContain((await app.inject({ method: 'GET', url: '/v1/triggers' })).statusCode);
    expect((await app.inject({ method: 'GET', url: `/v1/hooks/${trigger}` })).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('event trigger definitions', () => {
  const compileText = (text: string) => {
    const loaded = loadDefinitionText(text);
    if (!loaded.definition) return { ok: false, diagnostics: loaded.diagnostics };
    return compile(loaded.definition, {});
  };
  const errors = (r: { diagnostics: Array<{ code: string; severity: string }> }) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
  const withEvents = (events: string) => workflow(events).replace(/    type: agent[\s\S]*$/, '    type: condition\n    expression: "true"\n    routes: {a: []}\n');

  it('accepts a well-formed trigger', () => {
    expect(errors(compileText(withEvents(goodEvents)))).toEqual([]);
  });
  it('rejects a filter that does not compile, an input that is not declared and a path that is not a payload path', () => {
    expect(errors(compileText(withEvents(`    - source: github\n      when: "event.a =="`)))).toContain('invalid_trigger_filter');
    expect(errors(compileText(withEvents(`    - source: github\n      inputs: {nope: event.a}`)))).toContain('unknown_trigger_input');
    expect(errors(compileText(withEvents(`    - source: github\n      inputs: {repo: "event.a; drop"}`)))).toContain('invalid_trigger_input');
    expect(errors(compileText(withEvents(`    - source: smtp`)))).not.toEqual([]);
  });
  it('a trigger filter cannot read run state', () => {
    expect(triggerFilterPasses('inputs.x == 1', {}).pass).toBe(false);
    expect(triggerFilterPasses('event.a.b == 2', { a: { b: 2 } }).pass).toBe(true);
    expect(triggerFilterPasses('event.missing.deep == 2', {}).pass).toBe(false);
  });
  it('copies only scalars from own properties', () => {
    expect(eventValue({ a: { b: 1 } }, 'event.a.b')).toBe(1);
    expect(eventValue({ a: { b: { c: 1 } } }, 'event.a.b')).toBeUndefined();
    expect(eventValue({ a: [1] }, 'event.a')).toBeUndefined();
    expect(eventValue({}, 'event.constructor')).toBeUndefined();
    expect(eventValue({}, 'event.__proto__')).toBeUndefined();
  });
  it('matches an event family by its prefix', () => {
    expect(eventMatches(['pull_request'], 'pull_request.opened')).toBe(true);
    expect(eventMatches(['pull_request.opened'], 'pull_request.closed')).toBe(false);
    expect(eventMatches([], undefined)).toBe(true);
    expect(eventMatches(['push'], undefined)).toBe(false);
    expect(eventMatches(['pull'], 'pull_request.opened')).toBe(false);
  });
});
