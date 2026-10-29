import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { migrate } from '../src/db/migrate.js';
import { createContext, type AppContext } from '../src/server/context.js';
import { discoverMcpTools } from '../src/server/mcp.js';
import { decryptSecret, encryptSecret } from '../src/security/secrets.js';
import { startMcpOAuthServer, type McpOAuthFixture } from './fixtures/mcp-oauth-server.js';
import { freshDatabase } from './helpers/harness.js';

/**
 * Registering a remote MCP server with just a URL and a name: discovery, dynamic client registration,
 * sign-in through the callback, and refresh, all against a fixture that speaks the protocol.
 */
const WS = 'ws_mcp_oauth';
const PUBLIC = 'http://127.0.0.1:9999';

describe('remote MCP OAuth by discovery', () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  let fx: McpOAuthFixture | undefined;
  const saved = process.env.AZHI_EGRESS_ALLOW;
  let seq = 0;

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    const dir = mkdtempSync(join(tmpdir(), 'azhi-mcp-oauth-'));
    ctx = createContext({ databaseUrl: await freshDatabase(), dataDir: dir, artifactDir: join(dir, 'artifacts'), publicUrl: PUBLIC });
    await migrate(ctx.pool);
    await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,$1)`, [WS]);
    app = Fastify();
    app.addHook('onRequest', async (req) => { (req as any).principal = { kind: 'user', workspaceId: WS, userId: 'usr_admin', role: 'admin' }; });
    app.setErrorHandler((err, _req, reply) => reply.code(400).send({ error: (err as Error).message }));
    registerMcpRoutes(app, ctx);
    await app.ready();
  });
  afterEach(async () => { await fx?.close(); fx = undefined; });
  afterAll(async () => {
    if (saved === undefined) delete process.env.AZHI_EGRESS_ALLOW; else process.env.AZHI_EGRESS_ALLOW = saved;
    await app?.close(); await ctx?.pool.end();
  });

  const create = async (body: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/v1/mcp/connections', payload: { name: `conn-${++seq}`, url: fx!.mcpUrl, auth_kind: 'oauth', ...body } });
    return { status: res.statusCode, body: res.json() };
  };
  const callback = (query: Record<string, string>) => app.inject({ method: 'GET', url: `/v1/mcp/oauth/callback?${new URLSearchParams(query)}` });
  const status = async (id: string) => (await app.inject({ method: 'GET', url: `/v1/mcp/connections/${id}` })).json();
  const stateOf = (authorizationUrl: string) => new URL(authorizationUrl).searchParams.get('state')!;
  /** Make the stored access token look old, as it would after its lifetime has passed. */
  const age = async (id: string) => {
    const row = (await ctx.pool.query(`SELECT oauth_tokens FROM mcp_connections WHERE id=$1`, [id])).rows[0];
    const t = JSON.parse(decryptSecret(ctx.secretKey, row.oauth_tokens)); t.obtained_at = 1;
    await ctx.pool.query(`UPDATE mcp_connections SET oauth_tokens=$2 WHERE id=$1`, [id, encryptSecret(ctx.secretKey, JSON.stringify(t))]);
  };
  const signedIn = async (extra: Record<string, unknown> = {}) => {
    const c = await create(extra);
    expect(c.status).toBe(200);
    const res = await callback({ state: stateOf(c.body.authorization_url), code: 'good-code' });
    expect(res.statusCode).toBe(200);
    return c.body.id as string;
  };

  it('needs only a URL and a name: discovers, registers a client, signs in and lists tools', async () => {
    fx = await startMcpOAuthServer();
    const c = await create({});
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ auth_kind: 'oauth', status: 'authorizing', oauth: { client_id: 'dyn-client', issuer: fx.url, registered: true, connected: false, scopes: 'read write' } });
    expect(JSON.stringify(c.body)).not.toContain('reg-token');

    expect(fx.requests.register).toHaveLength(1);
    expect(fx.requests.register[0]).toMatchObject({ redirect_uris: [`${PUBLIC}/v1/mcp/oauth/callback`], token_endpoint_auth_method: 'none', scope: 'read write' });

    const u = new URL(c.body.authorization_url);
    expect(`${u.origin}${u.pathname}`).toBe(`${fx.url}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: 'dyn-client', redirect_uri: `${PUBLIC}/v1/mcp/oauth/callback`, code_challenge_method: 'S256', resource: fx.mcpUrl, scope: 'read write' });

    const done = await callback({ state: stateOf(c.body.authorization_url), code: 'good-code' });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('azhi-mcp-connected');
    expect(done.body).toContain(c.body.id);
    const tok = fx.requests.token[0]!;
    expect(tok.body.get('resource')).toBe(fx.mcpUrl);
    expect(tok.body.get('client_id')).toBe('dyn-client');
    expect(tok.body.get('code_verifier')).toBeTruthy();
    expect(tok.headers.authorization).toBeUndefined();

    expect(await status(c.body.id)).toMatchObject({ status: 'ready', oauth: { connected: true } });
    expect(await discoverMcpTools(ctx, WS, c.body.id)).toEqual([{ name: 'search', description: 'Search pages', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }]);

    // The tool's input schema comes from the server's listing when it is not given.
    const reg = await app.inject({ method: 'POST', url: `/v1/mcp/connections/${c.body.id}/tools`, payload: { id: 'search-pages', version: 1, name: 'search', description: 'Search', effect: 'read', output_schema: { type: 'object' } } });
    expect(reg.statusCode).toBe(200);
    const audits = (await ctx.pool.query(`SELECT kind, data FROM audit_events WHERE workspace_id=$1 AND kind='mcp.connection_created'`, [WS])).rows;
    expect(audits.at(-1).data).toMatchObject({ issuer: fx.url, registration: 'dynamic' });
  });

  it('says exactly which redirect URI to register when the server has no dynamic registration', async () => {
    fx = await startMcpOAuthServer({ registration: false });
    const c = await create({});
    expect(c.status).toBe(400);
    expect(c.body.error).toContain(`${PUBLIC}/v1/mcp/oauth/callback`);
    const failed = (await ctx.pool.query(`SELECT data FROM audit_events WHERE workspace_id=$1 AND kind='mcp.oauth_failed' ORDER BY seq DESC LIMIT 1`, [WS])).rows[0];
    expect(failed.data.stage).toBe('registration');
  });

  it('lets hand-entered values override discovery, with a client secret sent as HTTP Basic', async () => {
    fx = await startMcpOAuthServer({ registration: false, authMethods: ['client_secret_basic'] });
    const c = await create({ oauth: { client_id: 'mine', client_secret: 's3cret', scopes: 'read' } });
    expect(c.status).toBe(200);
    expect(fx.requests.register).toHaveLength(0);
    expect(new URL(c.body.authorization_url).searchParams.get('client_id')).toBe('mine');
    expect(new URL(c.body.authorization_url).searchParams.get('scope')).toBe('read');
    await callback({ state: stateOf(c.body.authorization_url), code: 'good-code' });
    expect(fx.requests.token[0]!.headers.authorization).toBe(`Basic ${Buffer.from('mine:s3cret').toString('base64')}`);
    expect(fx.requests.token[0]!.body.get('client_secret')).toBeNull();
  });

  it('records a provider error on the connection instead of failing with a validation error', async () => {
    fx = await startMcpOAuthServer();
    const c = await create({});
    const res = await callback({ state: stateOf(c.body.authorization_url), error: 'access_denied', error_description: 'User said <no>' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('User said &lt;no&gt;');
    expect(await status(c.body.id)).toMatchObject({ status: 'error', last_error: 'OAuth authorization failed: User said <no>' });
    // The pending state is gone, so the same link cannot be replayed.
    expect((await callback({ state: stateOf(c.body.authorization_url), code: 'good-code' })).statusCode).toBe(400);
  });

  it('rejects an expired sign-in', async () => {
    fx = await startMcpOAuthServer();
    const c = await create({});
    await ctx.pool.query(`UPDATE mcp_connections SET oauth_state_expires_at = now() - interval '1 minute' WHERE id=$1`, [c.body.id]);
    const res = await callback({ state: stateOf(c.body.authorization_url), code: 'good-code' });
    expect(res.statusCode).toBe(400);
    expect(fx.requests.token).toHaveLength(0);
    expect(await status(c.body.id)).toMatchObject({ status: 'error', last_error: expect.stringContaining('expired') });
  });

  it('marks a failed code exchange as an error with the provider message', async () => {
    fx = await startMcpOAuthServer();
    const c = await create({});
    const res = await callback({ state: stateOf(c.body.authorization_url), code: 'wrong' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('bad code');
    expect(await status(c.body.id)).toMatchObject({ status: 'error' });
  });

  it('refuses discovered endpoints on a private address', async () => {
    fx = await startMcpOAuthServer({ authorizationEndpoint: 'http://10.1.2.3/authorize' });
    const c = await create({});
    expect(c.status).toBe(400);
    expect(c.body.error).toMatch(/private address 10\.1\.2\.3/);
  });

  it('refuses an authorization server whose issuer does not match where it was found', async () => {
    fx = await startMcpOAuthServer({ issuer: 'http://127.0.0.1:1' });
    const c = await create({});
    expect(c.status).toBe(400);
    expect(c.body.error).toContain('does not match');
  });

  it('sends the resource when refreshing, and refreshes once for concurrent callers', async () => {
    fx = await startMcpOAuthServer();
    const id = await signedIn();
    await age(id);
    const before = fx.requests.token.length;
    await Promise.all([discoverMcpTools(ctx, WS, id), discoverMcpTools(ctx, WS, id)]);
    const refreshes = fx.requests.token.slice(before);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.body.get('grant_type')).toBe('refresh_token');
    expect(refreshes[0]!.body.get('resource')).toBe(fx.mcpUrl);
    expect(refreshes[0]!.body.get('refresh_token')).toBe('refresh-1');
  });

  it('asks the user to sign in again when the server stops accepting the token', async () => {
    fx = await startMcpOAuthServer();
    const id = await signedIn();
    fx.issued.push('someone-else');
    await expect(discoverMcpTools(ctx, WS, id)).rejects.toThrow(/sign in again/);
    expect(await status(id)).toMatchObject({ status: 'disconnected', last_error: expect.stringContaining('Sign in again') });
  });

  it('keeps no-auth connections working without any OAuth fields', async () => {
    fx = await startMcpOAuthServer();
    const c = await create({ auth_kind: 'none' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'ready', auth_kind: 'none' });
    expect(c.body.authorization_url).toBeUndefined();
  });
});
