import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

/**
 * The read-only run page (implementation plan, Phase 3). The page itself is static and carries no
 * data, so it is served without authentication; everything it shows comes from the authenticated
 * API, with the token held in the browser tab (passed once in the URL fragment by `azhi open`).
 */
const ASSETS: Record<string, string> = { 'app.js': 'text/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8' };
const asset = (name: string) => readFileSync(new URL(`./assets/${name}`, import.meta.url));
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-cache',
};

export function isWebPath(url: string): boolean {
  return url === '/ui' || url.startsWith('/ui/') || url.startsWith('/ui?');
}

export function registerWebRoutes(app: FastifyInstance) {
  const page = asset('index.html');
  const html = (_req: unknown, reply: { headers(h: object): { type(t: string): { send(b: Buffer): unknown } } }) => reply.headers(SECURITY_HEADERS).type('text/html; charset=utf-8').send(page);
  app.get('/ui', html);
  app.get('/ui/', html);
  app.get('/ui/runs/:id', html);
  app.get('/ui/assets/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!ASSETS[file]) return reply.status(404).send({ error: 'not_found', message: 'no such asset' });
    return reply.headers(SECURITY_HEADERS).type(ASSETS[file]!).send(asset(file));
  });
}
