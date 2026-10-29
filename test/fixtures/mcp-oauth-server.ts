import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * A remote MCP server that speaks the OAuth discovery protocol: a 401 with WWW-Authenticate, RFC 9728
 * and RFC 8414 documents (path-suffixed and root), RFC 7591 registration, a token endpoint that records
 * what it was sent, and an MCP endpoint that accepts only the token it issued.
 */
export interface McpOAuthFixture {
  url: string;
  mcpUrl: string;
  requests: { register: any[]; token: Array<{ headers: IncomingMessage['headers']; body: URLSearchParams }> };
  issued: string[];
  options: { registration: boolean; expiresIn: number; authorizationEndpoint?: string; issuer?: string; authMethods: string[] };
  close(): Promise<void>;
}

export async function startMcpOAuthServer(init: Partial<McpOAuthFixture['options']> = {}): Promise<McpOAuthFixture> {
  const options = { registration: true, expiresIn: 3600, authMethods: ['none'], ...init };
  const requests: McpOAuthFixture['requests'] = { register: [], token: [] };
  const issued: string[] = [];
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const path = new URL(req.url!, base).pathname;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (path === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read', 'write'] });
    if (path === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: options.issuer ?? base, authorization_endpoint: options.authorizationEndpoint ?? `${base}/authorize`, token_endpoint: `${base}/token`,
        ...(options.registration ? { registration_endpoint: `${base}/register` } : {}), code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: options.authMethods, response_types_supported: ['code'],
      });
    }
    if (path === '/register' && req.method === 'POST') {
      const body = JSON.parse(raw); requests.register.push(body);
      return json(201, { client_id: 'dyn-client', ...(options.authMethods.includes('none') ? {} : { client_secret: 'dyn-secret' }), registration_access_token: 'reg-token', redirect_uris: body.redirect_uris, token_endpoint_auth_method: options.authMethods[0] });
    }
    if (path === '/token' && req.method === 'POST') {
      const body = new URLSearchParams(raw); requests.token.push({ headers: req.headers, body });
      if (body.get('grant_type') === 'authorization_code' && body.get('code') !== 'good-code') return json(400, { error: 'invalid_grant', error_description: 'bad code' });
      const access = `access-${++n}`; issued.push(access);
      return json(200, { access_token: access, token_type: 'Bearer', expires_in: options.expiresIn, refresh_token: `refresh-${n}` });
    }
    if (path === '/mcp' && req.method === 'POST') {
      const auth = req.headers.authorization?.replace(/^Bearer /, '');
      if (!auth || auth !== issued[issued.length - 1]) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      const msg = JSON.parse(raw);
      if (msg.method === 'initialize') return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }, { 'mcp-session-id': 's1' });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search', description: 'Search pages', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] } });
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, mcpUrl: `${url}/mcp`, requests, issued, options, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) };
}
