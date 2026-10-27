import { spawn } from 'node:child_process';
import http from 'node:http';

/**
 * A local git host for tests: `git http-backend` (smart HTTP, fetch only) over the bare
 * repositories under `root` (`<root>/<owner>/<name>.git`). With `token`, requests must carry the
 * `Authorization: Basic x-access-token:<token>` header GitHub accepts; every request's headers
 * are recorded so a test can check what a client sent.
 */
export async function startFakeGit(root: string, opts: { token?: string } = {}) {
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
    req.pipe(cgi.stdin!);
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
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
