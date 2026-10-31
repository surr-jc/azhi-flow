import { createHash, randomBytes } from 'node:crypto';
import { checkEgress } from '../gateway/egress.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { decryptSecret, encryptSecret } from '../security/secrets.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';
import { buildAuthorizationUrl, discoverMcpOAuth, exchangeCode, redirectUriFor, refreshTokens, registerOAuthClient, type ClientAuthMethod, type McpOAuthDiscovery, type McpOAuthEndpoints } from './mcp-oauth.js';

export type McpAuthKind = 'none' | 'oauth';
export interface McpConnectionInput {
  name: string;
  url: string;
  auth_kind: McpAuthKind;
  oauth?: { authorization_url?: string; token_url?: string; client_id?: string; client_secret?: string; scopes?: string };
}
interface Row {
  id: string; workspace_id: string; name: string; url: string; auth_kind: McpAuthKind;
  oauth_authorization_url: string | null; oauth_token_url: string | null; oauth_client_id: string | null;
  oauth_client_secret: Buffer | null; oauth_scopes: string | null; oauth_tokens: Buffer | null;
  oauth_state: string | null; oauth_verifier: Buffer | null; status: string; last_error: string | null;
  oauth_resource: string | null; oauth_issuer: string | null; oauth_registration_endpoint: string | null; oauth_auth_method: ClientAuthMethod | null;
  oauth_registration_token: Buffer | null; oauth_state_expires_at: Date | null;
  created_by: string | null;
  created_at: Date; updated_at: Date;
}
export interface PublicConnection {
  id: string; name: string; url: string; auth_kind: McpAuthKind; status: string; last_error?: string;
  oauth?: { authorization_url?: string; token_url?: string; client_id?: string; scopes?: string; issuer?: string; resource?: string; registered: boolean; connected: boolean };
  created_at: Date; updated_at: Date;
}

export const publicConnection = (r: Row): PublicConnection => ({
  id: r.id, name: r.name, url: r.url, auth_kind: r.auth_kind, status: r.status,
  ...(r.last_error ? { last_error: r.last_error } : {}),
  ...(r.auth_kind === 'oauth' ? { oauth: { authorization_url: r.oauth_authorization_url ?? undefined, token_url: r.oauth_token_url ?? undefined, client_id: r.oauth_client_id ?? undefined, scopes: r.oauth_scopes ?? undefined, issuer: r.oauth_issuer ?? undefined, resource: r.oauth_resource ?? undefined, registered: Boolean(r.oauth_registration_token), connected: Boolean(r.oauth_tokens) } } : {}),
  created_at: r.created_at, updated_at: r.updated_at,
});

function validUrl(value: string, label = 'url') {
  let u: URL;
  try { u = new URL(value); } catch { throw new AzhiError(ErrorClass.invalidInput, `${label} must be an https URL`); }
  if (u.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && u.protocol === 'http:')) throw new AzhiError(ErrorClass.invalidInput, `${label} must be an https URL`);
  return u.toString();
}
function verifier() { return randomBytes(32).toString('base64url'); }
function challenge(v: string) { return createHash('sha256').update(v).digest('base64url'); }

export async function listMcpConnections(ctx: AppContext, workspaceId: string) {
  const rows = (await ctx.pool.query(`SELECT * FROM mcp_connections WHERE workspace_id=$1 ORDER BY name`, [workspaceId])).rows as Row[];
  return rows.map(publicConnection);
}
export async function getMcpConnection(ctx: AppContext, workspaceId: string, id: string): Promise<Row> {
  const r = await ctx.pool.query(`SELECT * FROM mcp_connections WHERE workspace_id=$1 AND id=$2`, [workspaceId, id]);
  if (!r.rows[0]) throw new AzhiError(ErrorClass.invalidInput, 'MCP connection not found');
  return r.rows[0] as Row;
}
export async function createMcpConnection(ctx: AppContext, workspaceId: string, input: McpConnectionInput, actor: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.name)) throw new AzhiError(ErrorClass.invalidInput, 'name must use lower-case letters, digits, dots, dashes or underscores');
  const url = validUrl(input.url, 'MCP URL');
  await checkEgress(url);
  if (!['none', 'oauth'].includes(input.auth_kind)) throw new AzhiError(ErrorClass.invalidInput, 'auth_kind must be none or oauth');
  const oauth = input.oauth;
  let authorizationUrl: string | null = null, tokenUrl: string | null = null, clientId: string | null = null, clientSecret: string | null = null;
  let scopes: string | null = null, resource: string | null = null, issuer: string | null = null, registrationEndpoint: string | null = null;
  let authMethod: ClientAuthMethod | null = null, registrationToken: string | null = null, registration = 'manual';
  if (input.auth_kind === 'oauth') {
    const manual = Boolean(oauth?.authorization_url && oauth.token_url && oauth.client_id);
    if (oauth?.authorization_url) validUrl(oauth.authorization_url, 'OAuth authorization URL');
    if (oauth?.token_url) validUrl(oauth.token_url, 'OAuth token URL');
    // Hand-entered values win field by field and the server's published metadata fills the rest. A fully
    // manual connection only borrows the resource indicator and scopes, and does without them if none are published.
    let found: McpOAuthDiscovery | undefined;
    try { found = await discoverMcpOAuth(url); } catch (err) {
      if (!manual) { await audit(ctx, workspaceId, actor, 'mcp.oauth_failed', { name: input.name, stage: 'discovery', error: (err as Error).message }); throw err; }
    }
    authorizationUrl = oauth?.authorization_url ?? found?.authorization_endpoint ?? null;
    tokenUrl = oauth?.token_url ?? found?.token_endpoint ?? null;
    if (!authorizationUrl || !tokenUrl) throw new AzhiError(ErrorClass.invalidInput, 'could not determine the OAuth authorization and token URLs');
    // Endpoints from the server's metadata are untrusted: they must clear the same egress check as the MCP URL.
    await checkEgress(authorizationUrl); await checkEgress(tokenUrl);
    scopes = oauth?.scopes ?? found?.scopes ?? null; resource = found?.resource ?? null; issuer = found?.issuer ?? null;
    registrationEndpoint = found?.registration_endpoint ?? null;
    if (oauth?.client_id) {
      clientId = oauth.client_id; clientSecret = oauth.client_secret ?? null;
      authMethod = clientSecret ? (found?.auth_methods.includes('client_secret_post') && !found.auth_methods.includes('client_secret_basic') ? 'client_secret_post' : 'client_secret_basic') : 'none';
    } else {
      let reg;
      try { reg = await registerOAuthClient(found!, redirectUriFor(ctx.settings.publicUrl)); } catch (err) {
        await audit(ctx, workspaceId, actor, 'mcp.oauth_failed', { name: input.name, stage: 'registration', error: (err as Error).message });
        throw err;
      }
      clientId = reg.client_id; clientSecret = reg.client_secret; authMethod = reg.auth_method; registrationToken = reg.registration_access_token; registration = 'dynamic';
    }
  }
  const id = newId('mcp');
  await ctx.pool.query(
    `INSERT INTO mcp_connections(id, workspace_id, name, url, auth_kind, oauth_authorization_url, oauth_token_url, oauth_client_id, oauth_client_secret, oauth_scopes, status, created_by,
       oauth_resource, oauth_issuer, oauth_registration_endpoint, oauth_auth_method, oauth_registration_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, workspaceId, input.name, url, input.auth_kind, authorizationUrl, tokenUrl, clientId, clientSecret ? encryptSecret(ctx.secretKey, clientSecret) : null, scopes, input.auth_kind === 'oauth' ? 'disconnected' : 'ready', actor,
      resource, issuer, registrationEndpoint, authMethod, registrationToken ? encryptSecret(ctx.secretKey, registrationToken) : null],
  );
  await audit(ctx, workspaceId, actor, 'mcp.connection_created', { connection: id, name: input.name, auth_kind: input.auth_kind, ...(input.auth_kind === 'oauth' ? { issuer, registration } : {}) });
  return publicConnection(await getMcpConnection(ctx, workspaceId, id));
}

const STATE_TTL_MS = 10 * 60_000;
const endpoints = (ctx: AppContext, r: Row): McpOAuthEndpoints => ({
  issuer: r.oauth_issuer, authorization_url: r.oauth_authorization_url!, token_url: r.oauth_token_url!, client_id: r.oauth_client_id!,
  client_secret: r.oauth_client_secret ? decryptSecret(ctx.secretKey, r.oauth_client_secret) : null,
  auth_method: r.oauth_auth_method ?? (r.oauth_client_secret ? 'client_secret_basic' : 'none'), resource: r.oauth_resource, scopes: r.oauth_scopes,
});

export async function beginMcpOAuth(ctx: AppContext, workspaceId: string, id: string, actor: string) {
  const r = await getMcpConnection(ctx, workspaceId, id);
  if (r.auth_kind !== 'oauth' || !r.oauth_authorization_url || !r.oauth_client_id || !r.oauth_token_url) throw new AzhiError(ErrorClass.invalidInput, 'this connection does not use OAuth');
  await checkEgress(r.oauth_authorization_url);
  const state = randomBytes(24).toString('base64url');
  const { url, codeVerifier } = await buildAuthorizationUrl(endpoints(ctx, r), redirectUriFor(ctx.settings.publicUrl), state);
  await ctx.pool.query(`UPDATE mcp_connections SET oauth_state=$3, oauth_verifier=$4, oauth_state_expires_at=$5, status='authorizing', last_error=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, id, state, encryptSecret(ctx.secretKey, codeVerifier), new Date(Date.now() + STATE_TTL_MS)]);
  await audit(ctx, workspaceId, actor, 'mcp.oauth_started', { connection: id });
  return { authorization_url: url };
}

async function failOAuth(ctx: AppContext, r: Row, message: string, stage: string) {
  await ctx.pool.query(`UPDATE mcp_connections SET status='error', last_error=$2, oauth_state=NULL, oauth_verifier=NULL, oauth_state_expires_at=NULL, updated_at=now() WHERE id=$1`, [r.id, message]);
  await audit(ctx, r.workspace_id, r.created_by, 'mcp.oauth_failed', { connection: r.id, stage, error: message });
}

/** The provider redirected back with `error=` instead of a code: record why and clear the pending sign-in. */
export async function failMcpOAuth(ctx: AppContext, state: string, message: string) {
  const r = (await ctx.pool.query(`SELECT * FROM mcp_connections WHERE oauth_state=$1`, [state])).rows[0] as Row | undefined;
  if (!r) return undefined;
  await failOAuth(ctx, r, `OAuth authorization failed: ${message}`, 'authorize');
  return r;
}

export async function finishMcpOAuth(ctx: AppContext, state: string, code: string) {
  const q = await ctx.pool.query(`SELECT * FROM mcp_connections WHERE oauth_state=$1`, [state]);
  const r = q.rows[0] as Row | undefined;
  if (!r || !r.oauth_token_url || !r.oauth_client_id || !r.oauth_verifier) throw new AzhiError(ErrorClass.authorization, 'OAuth request has expired or is invalid');
  if (r.oauth_state_expires_at && r.oauth_state_expires_at.getTime() < Date.now()) {
    await failOAuth(ctx, r, 'The sign-in link expired. Start sign-in again.', 'callback');
    throw new AzhiError(ErrorClass.authorization, 'OAuth request has expired or is invalid');
  }
  let token: Record<string, unknown>;
  try {
    await checkEgress(r.oauth_token_url);
    token = { ...await exchangeCode(endpoints(ctx, r), code, decryptSecret(ctx.secretKey, r.oauth_verifier), redirectUriFor(ctx.settings.publicUrl)) };
  } catch (err) {
    await failOAuth(ctx, r, `OAuth token exchange failed: ${(err as Error).message}`, 'token');
    throw new AzhiError(ErrorClass.authorization, `OAuth token exchange failed: ${(err as Error).message}`);
  }
  token.obtained_at = Date.now();
  await ctx.pool.query(`UPDATE mcp_connections SET oauth_tokens=$2, oauth_state=NULL, oauth_verifier=NULL, oauth_state_expires_at=NULL, status='ready', last_error=NULL, updated_at=now() WHERE id=$1`, [r.id, encryptSecret(ctx.secretKey, JSON.stringify(token))]);
  await audit(ctx, r.workspace_id, r.created_by, 'mcp.oauth_connected', { connection: r.id });
  return r;
}

// One refresh at a time per connection: refresh tokens are often single-use, so two racing callers would burn it.
const refreshing = new Map<string, Promise<string>>();
async function accessToken(ctx: AppContext, r: Row): Promise<string | undefined> {
  if (r.auth_kind === 'none') return undefined;
  if (!r.oauth_tokens) throw new AzhiError(ErrorClass.authorization, `MCP connection '${r.name}' is not connected`);
  const token = JSON.parse(decryptSecret(ctx.secretKey, r.oauth_tokens)) as { access_token?: string; refresh_token?: string; expires_in?: number; obtained_at?: number };
  if (!token.access_token) throw new AzhiError(ErrorClass.authorization, `MCP connection '${r.name}' has no access token`);
  if (token.refresh_token && token.expires_in && token.obtained_at && Date.now() >= token.obtained_at + token.expires_in * 1000 - 60_000) {
    if (!r.oauth_token_url || !r.oauth_client_id) throw new AzhiError(ErrorClass.authorization, `MCP connection '${r.name}' cannot refresh its OAuth token`);
    const pending = refreshing.get(r.id) ?? (async () => {
      try {
        // A caller that waited on the lock may find the tokens already refreshed: use the stored ones, not the row it loaded.
        const fresh = (await ctx.pool.query(`SELECT * FROM mcp_connections WHERE id=$1`, [r.id])).rows[0] as Row;
        const current = JSON.parse(decryptSecret(ctx.secretKey, fresh.oauth_tokens!)) as typeof token;
        if (current.obtained_at && current.obtained_at !== token.obtained_at) return current.access_token!;
        await checkEgress(fresh.oauth_token_url!);
        const refreshed = await refreshTokens(endpoints(ctx, fresh), token.refresh_token!);
        const next = { ...token, ...refreshed, refresh_token: refreshed.refresh_token ?? token.refresh_token, obtained_at: Date.now() };
        await ctx.pool.query(`UPDATE mcp_connections SET oauth_tokens=$2, status='ready', last_error=NULL, updated_at=now() WHERE id=$1`, [r.id, encryptSecret(ctx.secretKey, JSON.stringify(next))]);
        return next.access_token as string;
      } catch (err) {
        await ctx.pool.query(`UPDATE mcp_connections SET status='error', last_error=$2, updated_at=now() WHERE id=$1`, [r.id, `OAuth refresh failed: ${(err as Error).message}. Sign in again.`]);
        await audit(ctx, r.workspace_id, r.created_by, 'mcp.oauth_failed', { connection: r.id, stage: 'refresh', error: (err as Error).message });
        throw new AzhiError(ErrorClass.authorization, `MCP connection '${r.name}' OAuth refresh failed`);
      } finally { refreshing.delete(r.id); }
    })();
    refreshing.set(r.id, pending);
    return pending;
  }
  return token.access_token;
}

function parseRpcResponse(text: string) {
  try { return JSON.parse(text); } catch {
    // Streamable HTTP may return a single SSE event. Multi-event streams are not valid for MCP
    // request responses, so take the first JSON data event and reject anything else.
    const data = text.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
    if (!data) throw new AzhiError(ErrorClass.contractViolation, 'remote MCP returned neither JSON nor an SSE JSON event');
    try { return JSON.parse(data); } catch { throw new AzhiError(ErrorClass.contractViolation, 'remote MCP returned invalid JSON'); }
  }
}

interface RpcResult { result?: any; error?: { code?: number; message?: string }; session?: string | null }
const RPC_TIMEOUT_MS = 30_000;
/** One authenticated POST to the MCP endpoint. A 401 means the stored sign-in is no longer accepted. */
async function post(ctx: AppContext, r: Row, token: string | undefined, session: string | undefined, body: Record<string, unknown>) {
  const res = await fetch(r.url, { method: 'POST', signal: AbortSignal.timeout(RPC_TIMEOUT_MS), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26', ...(session ? { 'mcp-session-id': session } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });
  if (res.status === 401 && r.auth_kind === 'oauth') {
    await ctx.pool.query(`UPDATE mcp_connections SET status='disconnected', last_error=$2, updated_at=now() WHERE id=$1`, [r.id, 'The server no longer accepts this sign-in. Sign in again.']);
    throw new AzhiError(ErrorClass.authorization, `MCP connection '${r.name}' needs to sign in again`);
  }
  return res;
}
async function rpc(ctx: AppContext, r: Row, method: string, params?: Record<string, unknown>): Promise<RpcResult> {
  await checkEgress(r.url);
  const res = await post(ctx, r, await accessToken(ctx, r), undefined, { id: 1, method, ...(params ? { params } : {}) });
  const text = await res.text();
  if (!res.ok) throw new AzhiError(res.status === 401 || res.status === 403 ? ErrorClass.authorization : ErrorClass.transient, `remote MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  const payload = parseRpcResponse(text);
  return payload.error ? { error: payload.error, session: res.headers.get('mcp-session-id') } : { result: payload.result, session: res.headers.get('mcp-session-id') };
}

async function initialized(ctx: AppContext, r: Row): Promise<string | undefined> {
  const init = await rpc(ctx, r, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'azhi-flow', version: '0.1.0' } });
  if (init.error) throw new AzhiError(ErrorClass.invalidInput, `remote MCP initialize failed: ${init.error.message ?? 'unknown error'}`);
  // The server accepts this notification on the same endpoint; it intentionally has no response.
  await post(ctx, r, await accessToken(ctx, r), init.session ?? undefined, { method: 'notifications/initialized' });
  return init.session ?? undefined;
}
async function rpcSession(ctx: AppContext, r: Row, session: string | undefined, method: string, params?: Record<string, unknown>) {
  await checkEgress(r.url);
  const res = await post(ctx, r, await accessToken(ctx, r), session, { id: 2, method, ...(params ? { params } : {}) });
  const text = await res.text(); if (!res.ok) throw new AzhiError(res.status === 401 || res.status === 403 ? ErrorClass.authorization : ErrorClass.transient, `remote MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  return parseRpcResponse(text) as { result?: any; error?: { message?: string } };
}
export async function discoverMcpTools(ctx: AppContext, workspaceId: string, id: string) {
  const r = await getMcpConnection(ctx, workspaceId, id); const session = await initialized(ctx, r); const reply = await rpcSession(ctx, r, session, 'tools/list');
  if (reply.error) throw new AzhiError(ErrorClass.invalidInput, `remote MCP tools/list failed: ${reply.error.message ?? 'unknown error'}`);
  return ((reply.result?.tools ?? []) as Array<any>).map((t) => ({ name: String(t.name), description: typeof t.description === 'string' ? t.description : '', input_schema: t.inputSchema ?? { type: 'object' } }));
}
export async function callRemoteMcpTool(ctx: AppContext, workspaceId: string, connection: string, tool: string, args: Record<string, unknown>) {
  const r = await getMcpConnection(ctx, workspaceId, connection); const session = await initialized(ctx, r); const reply = await rpcSession(ctx, r, session, 'tools/call', { name: tool, arguments: args });
  if (reply.error || reply.result?.isError) throw new AzhiError(ErrorClass.invalidInput, `remote MCP tool error: ${reply.error?.message ?? textContent(reply.result).slice(0, 200)}`);
  if (reply.result?.structuredContent !== undefined) return reply.result.structuredContent;
  const text = textContent(reply.result); try { return JSON.parse(text); } catch { return text; }
}
function textContent(result: any) { return (result?.content ?? []).filter((x: any) => x?.type === 'text').map((x: any) => x.text ?? '').join(''); }
