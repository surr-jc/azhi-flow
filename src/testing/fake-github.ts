import http from 'node:http';

/**
 * A minimal stand-in for the parts of the GitHub REST API the flagship tools read: Actions runs
 * and their jobs, and open issues by label. Used by tests and local demos; point a tool's
 * `api_url` at it.
 */
export interface FakeGithubData {
  runs: Array<{ id: number; conclusion: string; head_branch: string; run_started_at: string; updated_at: string; jobs?: Array<{ name: string; conclusion: string }> }>;
  issues: Array<{ number: number; title: string; labels: string[]; comments?: number; created_at?: string; pull_request?: boolean }>;
}

export async function startFakeGithub(data: FakeGithubData, opts: { token?: string; host?: string } = {}) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { message: 'Bad credentials' });
    const page = Number(url.searchParams.get('page') ?? 1);
    const per = Number(url.searchParams.get('per_page') ?? 30);
    const slice = <T>(xs: T[]) => xs.slice((page - 1) * per, page * per);
    let m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/);
    if (m) {
      const since = url.searchParams.get('created')?.replace(/^>=/, '');
      const runs = data.runs.filter((r) => !since || Date.parse(r.run_started_at) >= Date.parse(since));
      return send(200, { total_count: runs.length, workflow_runs: slice(runs).map(({ jobs: _j, ...r }) => ({ ...r, status: 'completed', created_at: r.run_started_at })) });
    }
    m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/);
    if (m) return send(200, { jobs: data.runs.find((r) => r.id === Number(m![1]))?.jobs ?? [] });
    m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues$/);
    if (m) {
      const label = url.searchParams.get('labels');
      const found = data.issues.filter((i) => !label || i.labels.includes(label));
      return send(200, slice(found).map((i) => ({ number: i.number, title: i.title, comments: i.comments ?? 0, created_at: i.created_at ?? '2026-09-25T04:10:00Z', labels: i.labels.map((name) => ({ name })), ...(i.pull_request ? { pull_request: {} } : {}) })));
    }
    send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, opts.host ?? '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://${opts.host ?? '127.0.0.1'}:${port}`, requests, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
