import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Mission control (docs/mission-control-plan.md): a React app built by `npm run build:web` into
 * src/web/dist. The page and its assets carry no data, so they are served without
 * authentication; everything shown comes from the authenticated API, with the token held in the
 * browser tab (passed once in the URL fragment by `azhi open`). Every /ui path returns the app,
 * which routes in the browser.
 */
const DIST = fileURLToPath(new URL('./dist/', import.meta.url));
const TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2', png: 'image/png' };
// Build output names only (name-hash.ext): no slashes or dots that could leave the folder.
const ASSET_NAME = /^[A-Za-z0-9_-]+\.(js|css|svg|woff2|png)$/;
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const NOT_BUILT = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Azhi Flow</title>
<body style="font:15px system-ui;max-width:560px;margin:15vh auto;padding:16px">
<h1>The web app is not built</h1>
<p>Run <code>npm run build:web</code> in the Azhi Flow folder, then reload this page. The Docker image builds it for you.</p>`);

export function isWebPath(url: string): boolean {
  return url === '/ui' || url.startsWith('/ui/') || url.startsWith('/ui?');
}

export function registerWebRoutes(app: FastifyInstance) {
  // Read per request while the bundle is missing, so building it needs no server restart.
  let page: Buffer | undefined;
  const index = () => (page ??= existsSync(`${DIST}index.html`) ? readFileSync(`${DIST}index.html`) : undefined);
  const html = (_req: unknown, reply: FastifyReply) => reply.headers({ ...SECURITY_HEADERS, 'cache-control': 'no-cache' }).type('text/html; charset=utf-8').send(index() ?? NOT_BUILT);
  app.get('/ui', html);
  app.get('/ui/*', html);
  app.get('/ui/assets/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const path = `${DIST}assets/${file}`;
    if (!ASSET_NAME.test(file) || !existsSync(path)) return reply.status(404).send({ error: 'not_found', message: 'no such asset' });
    // Names carry a content hash, so they can be cached for good.
    return reply.headers({ ...SECURITY_HEADERS, 'cache-control': 'public, max-age=31536000, immutable' }).type(TYPES[file.split('.').pop()!]!).send(readFileSync(path));
  });
}
