import { createHash, randomBytes } from 'node:crypto';
import { checkEgress } from '../gateway/egress.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { decryptSecret, encryptSecret } from '../security/secrets.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';

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
  created_by: string | null;
  created_at: Date; updated_at: Date;
}
export interface PublicConnection {
  id: string; name: string; url: string; auth_kind: McpAuthKind; status: string; last_error?: string;
  oauth?: { authorization_url?: string; token_url?: string; client_id?: string; scopes?: string; connected: boolean };
  created_at: Date; updated_at: Date;
}

const publicRow = (r: Row): PublicConnection => ({
  id: r.id, name: r.name, url: r.url, auth_kind: r.auth_kind, status: r.status,
  ...(r.last_error ? { last_error: r.last_error } : {}),
  ...(r.auth_kind === 'oauth' ? { oauth: { authorization_url: r.oauth_authorization_url ?? undefined, token_url: r.oauth_token_url ?? undefined, client_id: r.oauth_client_id ?? undefined, scopes: r.oauth_scopes ?? undefined, connected: Boolean(r.oauth_tokens) } } : {}),
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
  return rows.map(publicRow);
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
  if (input.auth_kind === 'oauth') {
    if (!oauth?.authorization_url || !oauth.token_url || !oauth.client_id) throw new AzhiError(ErrorClass.invalidInput, 'OAuth authorization URL, token URL and client ID are required');
    validUrl(oauth.authorization_url, 'OAuth authorization URL'); validUrl(oauth.token_url, 'OAuth token URL');
  }
  const id = newId('mcp');
  await ctx.pool.query(
    `INSERT INTO mcp_connections(id, workspace_id, name, url, auth_kind, oauth_authorization_url, oauth_token_url, oauth_client_id, oauth_client_secret, oauth_scopes, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, workspaceId, input.name, url, input.auth_kind, oauth?.authorization_url ? validUrl(oauth.authorization_url) : null, oauth?.token_url ? validUrl(oauth.token_url) : null, oauth?.client_id ?? null, oauth?.client_secret ? encryptSecret(ctx.secretKey, oauth.client_secret) : null, oauth?.scopes ?? null, input.auth_kind === 'oauth' ? 'disconnected' : 'ready', actor],
  );
  await audit(ctx, workspaceId, actor, 'mcp.connection_created', { connection: id, name: input.name, auth_kind: input.auth_kind });
  return publicRow(await getMcpConnection(ctx, workspaceId, id));
}

export async function beginMcpOAuth(ctx: AppContext, workspaceId: string, id: string, actor: string) {
  const r = await getMcpConnection(ctx, workspaceId, id);
  if (r.auth_kind !== 'oauth' || !r.oauth_authorization_url || !r.oauth_client_id) throw new AzhiError(ErrorClass.invalidInput, 'this connection does not use OAuth');
  await checkEgress(r.oauth_authorization_url);
  const state = randomBytes(24).toString('base64url'); const codeVerifier = verifier();
  const redirect = new URL('/v1/mcp/oauth/callback', ctx.settings.publicUrl).toString();
  const u = new URL(r.oauth_authorization_url);
  u.searchParams.set('response_type', 'code'); u.searchParams.set('client_id', r.oauth_client_id); u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('state', state); u.searchParams.set('code_challenge', challenge(codeVerifier)); u.searchParams.set('code_challenge_method', 'S256');
  if (r.oauth_scopes) u.searchParams.set('scope', r.oauth_scopes);
  await ctx.pool.query(`UPDATE mcp_connections SET oauth_state=$3, oauth_verifier=$4, status='authorizing', last_error=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, id, state, encryptSecret(ctx.secretKey, codeVerifier)]);
  await audit(ctx, workspaceId, actor, 'mcp.oauth_started', { connection: id });
  return { authorization_url: u.toString() };
}

export async function finishMcpOAuth(ctx: AppContext, state: string, code: string) {
  const q = await ctx.pool.query(`SELECT * FROM mcp_connections WHERE oauth_state=$1`, [state]);
  const r = q.rows[0] as Row | undefined;
  if (!r || !r.oauth_token_url || !r.oauth_client_id || !r.oauth_verifier) throw new AzhiError(ErrorClass.authorization, 'OAuth request has expired or is invalid');
  await checkEgress(r.oauth_token_url);
  const verifierValue = decryptSecret(ctx.secretKey, r.oauth_verifier);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: r.oauth_client_id, redirect_uri: new URL('/v1/mcp/oauth/callback', ctx.settings.publicUrl).toString(), code_verifier: verifierValue });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (r.oauth_client_secret) headers.authorization = `Basic ${Buffer.from(`${r.oauth_client_id}:${decryptSecret(ctx.secretKey, r.oauth_client_secret)}`).toString('base64')}`;
  let token: Record<string, unknown>;
  try {
    const res = await fetch(r.oauth_token_url, { method: 'POST', headers, body });
    token = await res.json() as Record<string, unknown>;
    if (!res.ok || typeof token.access_token !== 'string') throw new Error(String(token.error_description ?? token.error ?? `HTTP ${res.status}`));
  } catch (err) {
    await ctx.pool.query(`UPDATE mcp_connections SET status='error', last_error=$2, oauth_state=NULL, oauth_verifier=NULL, updated_at=now() WHERE id=$1`, [r.id, `OAuth token exchange failed: ${(err as Error).message}`]);
    throw new AzhiError(ErrorClass.authorization, `OAuth token exchange failed: ${(err as Error).message}`);
  }
  token.obtained_at = Date.now();
  await ctx.pool.query(`UPDATE mcp_connections SET oauth_tokens=$2, oauth_state=NULL, oauth_verifier=NULL, status='ready', last_error=NULL, updated_at=now() WHERE id=$1`, [r.id, encryptSecret(ctx.secretKey, JSON.stringify(token))]);
  await audit(ctx, r.workspace_id, r.created_by, 'mcp.oauth_connected', { connection: r.id });
  return r;
}

async function accessToken(ctx: AppContext, r: Row): Promise<string | undefined> {
  if (r.auth_kind === 'none') return undefined;
  if (!r.oauth_tokens) throw new AzhiError(ErrorClass.authorization, `MCP connection '${r.name}' is not connected`);
  const token = JSON.parse(decryptSecret(ctx.secretKey, r.oauth_tokens)) as { access_token?: string; refresh_token?: string; expires_in?: number; obtained_at?: number };
  if (!token.access_token) throw new AzhiError(ErrorClass.authorization, `MCP connection '${r.name}' has no access token`);
  if (token.refresh_token && token.expires_in && token.obtained_at && Date.now() >= token.obtained_at + token.expires_in * 1000 - 60_000) {
    if (!r.oauth_token_url || !r.oauth_client_id) throw new AzhiError(ErrorClass.authorization, `MCP connection '${r.name}' cannot refresh its OAuth token`);
    await checkEgress(r.oauth_token_url);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (r.oauth_client_secret) headers.authorization = `Basic ${Buffer.from(`${r.oauth_client_id}:${decryptSecret(ctx.secretKey, r.oauth_client_secret)}`).toString('base64')}`;
    try {
      const res = await fetch(r.oauth_token_url, { method: 'POST', headers, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: r.oauth_client_id }) });
      const refreshed = await res.json() as Record<string, unknown>;
      if (!res.ok || typeof refreshed.access_token !== 'string') throw new Error(String(refreshed.error_description ?? refreshed.error ?? `HTTP ${res.status}`));
      const next = { ...token, ...refreshed, refresh_token: refreshed.refresh_token ?? token.refresh_token, obtained_at: Date.now() };
      await ctx.pool.query(`UPDATE mcp_connections SET oauth_tokens=$2, status='ready', last_error=NULL, updated_at=now() WHERE id=$1`, [r.id, encryptSecret(ctx.secretKey, JSON.stringify(next))]);
      return next.access_token as string;
    } catch (err) {
      await ctx.pool.query(`UPDATE mcp_connections SET status='error', last_error=$2, updated_at=now() WHERE id=$1`, [r.id, `OAuth refresh failed: ${(err as Error).message}`]);
      throw new AzhiError(ErrorClass.authorization, `MCP connection '${r.name}' OAuth refresh failed`);
    }
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
async function rpc(ctx: AppContext, r: Row, method: string, params?: Record<string, unknown>): Promise<RpcResult> {
  await checkEgress(r.url);
  const token = await accessToken(ctx, r);
  const request = async (session?: string) => {
    const res = await fetch(r.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26', ...(session ? { 'mcp-session-id': session } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }) });
    const text = await res.text();
    if (!res.ok) throw new AzhiError(res.status === 401 || res.status === 403 ? ErrorClass.authorization : ErrorClass.transient, `remote MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { payload: parseRpcResponse(text), session: res.headers.get('mcp-session-id') };
  };
  const initial = await request();
  if (initial.payload.error) return { error: initial.payload.error, session: initial.session };
  return { result: initial.payload.result, session: initial.session };
}

async function initialized(ctx: AppContext, r: Row): Promise<string | undefined> {
  const init = await rpc(ctx, r, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'azhi-flow', version: '0.1.0' } });
  if (init.error) throw new AzhiError(ErrorClass.invalidInput, `remote MCP initialize failed: ${init.error.message ?? 'unknown error'}`);
  // The server accepts this notification on the same endpoint; it intentionally has no response.
  await fetch(r.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(init.session ? { 'mcp-session-id': init.session } : {}), ...(await accessToken(ctx, r) ? { authorization: `Bearer ${await accessToken(ctx, r)}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  return init.session ?? undefined;
}
async function rpcSession(ctx: AppContext, r: Row, session: string | undefined, method: string, params?: Record<string, unknown>) {
  await checkEgress(r.url); const token = await accessToken(ctx, r);
  const res = await fetch(r.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26', ...(session ? { 'mcp-session-id': session } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, ...(params ? { params } : {}) }) });
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
