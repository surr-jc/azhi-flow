import {
  discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, exchangeAuthorization, extractWWWAuthenticateParams,
  refreshAuthorization, registerClient, startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { checkEgress } from '../gateway/egress.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';

/**
 * Remote MCP OAuth without hand-entered endpoints: RFC 9728 protected-resource metadata, RFC 8414
 * server metadata and RFC 7591 dynamic client registration, using the MCP SDK's helpers behind one
 * guarded fetch. Everything a server publishes is untrusted data: every URL passes the egress check,
 * every redirect hop is re-checked, and responses are size- and time-limited.
 */
export type ClientAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';
export interface McpOAuthDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  scopes: string | null;
  resource: string;
  auth_methods: string[];
}
export interface McpOAuthEndpoints {
  issuer: string | null;
  authorization_url: string;
  token_url: string;
  client_id: string;
  client_secret: string | null;
  auth_method: ClientAuthMethod;
  resource: string | null;
  scopes: string | null;
}

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_000_000;
const MAX_HOPS = 4;

export async function guardedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  let url = String(input);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await checkEgress(url);
    const res = await fetch(url, { ...init, method, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === MAX_HOPS) throw new AzhiError(ErrorClass.transient, 'too many redirects from OAuth server');
      url = new URL(location, url).toString();
      if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
      continue;
    }
    return capped(res);
  }
  throw new AzhiError(ErrorClass.transient, 'too many redirects from OAuth server');
}

async function capped(res: Response): Promise<Response> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new AzhiError(ErrorClass.contractViolation, 'OAuth server response is too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new AzhiError(ErrorClass.contractViolation, 'OAuth server response is too large');
  return new Response(buf.length ? buf : null, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function httpUrl(value: unknown, label: string): string {
  let u: URL;
  try { u = new URL(String(value)); } catch { throw new AzhiError(ErrorClass.contractViolation, `${label} is not a URL`); }
  if (u.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && u.protocol === 'http:')) throw new AzhiError(ErrorClass.contractViolation, `${label} must be an https URL`);
  return u.toString();
}
const trimSlash = (s: string) => s.replace(/\/+$/, '');

export const redirectUriFor = (publicUrl: string) => new URL('/v1/mcp/oauth/callback', publicUrl).toString();

/** Find the OAuth endpoints an MCP server publishes. Unknown values are null; missing metadata is an error. */
export async function discoverMcpOAuth(mcpUrl: string, fetchFn = guardedFetch): Promise<McpOAuthDiscovery> {
  const mcp = new URL(mcpUrl);
  let metadataUrl: URL | undefined;
  try {
    const probe = await fetchFn(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'azhi-flow', version: '0.1.0' } } }) });
    if (probe.status === 401) metadataUrl = extractWWWAuthenticateParams(probe).resourceMetadataUrl;
  } catch (err) {
    if (err instanceof AzhiError) throw err; // egress refusals are final; an unreachable probe falls through to well-known lookup
  }
  let prm: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | undefined;
  try { prm = await discoverOAuthProtectedResourceMetadata(mcp, metadataUrl ? { resourceMetadataUrl: metadataUrl } : undefined, fetchFn); } catch (err) {
    if (err instanceof AzhiError) throw err; // no protected-resource metadata: the MCP origin may itself be the authorization server
  }
  let resource = mcpUrl;
  if (prm?.resource) {
    const r = new URL(prm.resource);
    if (r.origin !== mcp.origin || !(mcp.pathname === r.pathname || mcp.pathname.startsWith(`${trimSlash(r.pathname)}/`))) throw new AzhiError(ErrorClass.contractViolation, `the server's protected resource ${prm.resource} does not match ${mcpUrl}`);
    resource = prm.resource;
  }
  const issuerUrl = httpUrl(prm?.authorization_servers?.[0] ?? mcp.origin, 'authorization server');
  const meta = await discoverAuthorizationServerMetadata(issuerUrl, { fetchFn }).catch((err) => {
    if (err instanceof AzhiError) throw err;
    return undefined;
  });
  if (!meta) throw new AzhiError(ErrorClass.invalidInput, `${mcpUrl} does not publish OAuth metadata; supply the authorization URL, token URL and client ID by hand`);
  if (trimSlash(meta.issuer) !== trimSlash(issuerUrl)) throw new AzhiError(ErrorClass.contractViolation, `OAuth issuer ${meta.issuer} does not match ${issuerUrl}`);
  if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes('S256')) throw new AzhiError(ErrorClass.invalidInput, 'the OAuth server does not support PKCE S256');
  const scopes = prm?.scopes_supported?.length ? prm.scopes_supported : meta.scopes_supported;
  return {
    issuer: meta.issuer,
    authorization_endpoint: httpUrl(meta.authorization_endpoint, 'authorization endpoint'),
    token_endpoint: httpUrl(meta.token_endpoint, 'token endpoint'),
    registration_endpoint: meta.registration_endpoint ? httpUrl(meta.registration_endpoint, 'registration endpoint') : null,
    scopes: scopes?.length ? scopes.join(' ') : null,
    resource,
    auth_methods: meta.token_endpoint_auth_methods_supported ?? [],
  };
}

export interface RegisteredClient { client_id: string; client_secret: string | null; auth_method: ClientAuthMethod; registration_access_token: string | null }

/** RFC 7591 dynamic registration of Azhi's own client. The server is asked for a public client when it allows one. */
export async function registerOAuthClient(d: McpOAuthDiscovery, redirectUri: string, fetchFn = guardedFetch): Promise<RegisteredClient> {
  if (!d.registration_endpoint) throw new AzhiError(ErrorClass.invalidInput, `the server does not support dynamic client registration; register a client with redirect URI ${redirectUri} and supply its client ID`);
  const wanted: ClientAuthMethod = d.auth_methods.includes('none') ? 'none' : d.auth_methods.includes('client_secret_post') && !d.auth_methods.includes('client_secret_basic') ? 'client_secret_post' : 'client_secret_basic';
  // The SDK's parsed result drops registration_access_token, so read it from the raw response.
  let registrationToken: string | null = null;
  const capture: typeof guardedFetch = async (input, init) => {
    const res = await fetchFn(input, init);
    try { const t = (await res.clone().json() as { registration_access_token?: unknown }).registration_access_token; if (typeof t === 'string') registrationToken = t; } catch { /* not JSON: the SDK reports it */ }
    return res;
  };
  const info = await registerClient(d.issuer, {
    metadata: { issuer: d.issuer, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, registration_endpoint: d.registration_endpoint, response_types_supported: ['code'] },
    clientMetadata: { client_name: 'Azhi Flow', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: wanted, ...(d.scopes ? { scope: d.scopes } : {}) },
    fetchFn: capture,
  });
  const granted = (info.token_endpoint_auth_method as ClientAuthMethod | undefined) ?? wanted;
  const method: ClientAuthMethod = info.client_secret ? (granted === 'none' ? 'client_secret_basic' : granted) : 'none';
  return { client_id: info.client_id, client_secret: info.client_secret ?? null, auth_method: method, registration_access_token: registrationToken };
}

const clientInfo = (e: McpOAuthEndpoints): OAuthClientInformationMixed => ({ client_id: e.client_id, ...(e.client_secret ? { client_secret: e.client_secret } : {}) });
const serverMeta = (e: McpOAuthEndpoints) => ({
  issuer: e.issuer ?? new URL(e.token_url).origin, authorization_endpoint: e.authorization_url, token_endpoint: e.token_url,
  response_types_supported: ['code'], token_endpoint_auth_methods_supported: [e.auth_method],
});
const issuerOf = (e: McpOAuthEndpoints) => e.issuer ?? new URL(e.token_url).origin;

export async function buildAuthorizationUrl(e: McpOAuthEndpoints, redirectUri: string, state: string) {
  const { authorizationUrl, codeVerifier } = await startAuthorization(issuerOf(e), { metadata: serverMeta(e), clientInformation: clientInfo(e), redirectUrl: redirectUri, state, ...(e.scopes ? { scope: e.scopes } : {}), ...(e.resource ? { resource: e.resource } : {}) });
  return { url: authorizationUrl.toString(), codeVerifier };
}

export function exchangeCode(e: McpOAuthEndpoints, code: string, codeVerifier: string, redirectUri: string): Promise<OAuthTokens> {
  return exchangeAuthorization(issuerOf(e), { metadata: serverMeta(e), clientInformation: clientInfo(e), authorizationCode: code, codeVerifier, redirectUri, ...(e.resource ? { resource: e.resource } : {}), fetchFn: guardedFetch });
}

export function refreshTokens(e: McpOAuthEndpoints, refreshToken: string): Promise<OAuthTokens> {
  return refreshAuthorization(issuerOf(e), { metadata: serverMeta(e), clientInformation: clientInfo(e), refreshToken, ...(e.resource ? { resource: e.resource } : {}), fetchFn: guardedFetch });
}
