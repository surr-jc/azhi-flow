import { spawn } from 'node:child_process';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

/**
 * A local git host for tests: `git http-backend` (smart HTTP, fetch only) over the bare
 * repositories under `root` (`<root>/<owner>/<name>.git`). With `token`, requests must carry the
 * `Authorization: Basic x-access-token:<token>` header GitHub accepts; every request's headers
 * are recorded so a test can check what a client sent. With `dropFetches: n`, the first n requests that
 * ask for a pack (not the ref listing before them) get some bytes back and then a destroyed connection,
 * which git reports as a real transport failure; `packRequests` counts every such request, dropped or not (only when `dropFetches` is set, even to 0).
 */
export async function startFakeGit(root: string, opts: { token?: string; dropFetches?: number } = {}) {
  let toDrop = opts.dropFetches ?? 0;
  let packRequests = 0;
  const requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });
    const expected = opts.token ? `Basic ${Buffer.from(`x-access-token:${opts.token}`).toString('base64')}` : undefined;
    if (expected && req.headers.authorization !== expected) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="fake-git"' });
      return res.end('unauthorized');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.includes('git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack') {
      res.writeHead(403);
      return res.end('read-only');
    }
    const isPack = req.method === 'POST' && url.pathname.endsWith('/git-upload-pack');
    if (isPack && opts.dropFetches !== undefined) {
      // Protocol v2 also POSTs the ref listing to git-upload-pack; only the request that names the wanted commits asks for a pack.
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
        const wantsPack = /command=fetch|want [0-9a-f]{40}/.test(body.toString('latin1'));
        if (wantsPack) packRequests++;
        if (wantsPack && toDrop > 0) {
          toDrop--;
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
          res.write('0008NAK\n');
          setTimeout(() => res.destroy(), 20);
          return;
        }
        serve(req, res, url, body);
      });
      return;
    }
    serve(req, res, url);
  });
  const serve = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, body?: Buffer) => {
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (body) cgi.stdin!.end(body);
    else req.pipe(cgi.stdin!);
    let head = Buffer.alloc(0);
    let headersSent = false;
    cgi.stdout!.on('data', (chunk: Buffer) => {
      if (headersSent) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      let status = 200;
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const i = line.indexOf(':');
        const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0]);
        else res.setHeader(k, v);
      }
      res.writeHead(status);
      headersSent = true;
      res.write(head.subarray(end + 4));
    });
    cgi.on('close', () => res.end());
  };
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, get packRequests() { return packRequests; }, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
