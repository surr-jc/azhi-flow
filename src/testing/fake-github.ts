import http from 'node:http';

/**
 * A minimal stand-in for the parts of the GitHub REST API the built-in tools use: Actions runs
 * and their jobs, open issues by label, pull requests with their files, and PR comments (which
 * it stores). Used by tests and local demos; point a tool's `api_url` at it.
 */
export interface FakeGithubData {
  runs: Array<{ id: number; conclusion: string; head_branch: string; run_started_at: string; updated_at: string; jobs?: Array<{ name: string; conclusion: string }> }>;
  issues: Array<{ number: number; title: string; labels: string[]; comments?: number; created_at?: string; pull_request?: boolean; body?: string; user?: string; repo?: string }>;
  pulls?: Array<{
    number: number;
    title: string;
    body?: string;
    user?: string;
    base: { ref: string; sha: string };
    head: { ref: string; sha: string };
    /** `mergeable`: what GitHub reports; an array is one value per GET (the last repeats), so null can resolve later. */
    mergeable?: boolean | null | Array<boolean | null>;
    mergeable_state?: string;
    files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  }>;
}

export interface FakeComment {
  id: number;
  repo: string;
  number: number;
  body: string;
}

/** `token`: the accepted bearer token, or a list whose first entry may only read and the rest may also write. */
/** `comments`: comments that already exist (on issues or pull requests). */
export async function startFakeGithub(data: FakeGithubData, opts: { token?: string | string[]; host?: string; comments?: Array<FakeComment & { user?: string }> } = {}) {
  const requests: string[] = [];
  const comments: Array<FakeComment & { user?: string }> = [...(opts.comments ?? [])];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (opts.token && ![opts.token].flat().some((t) => req.headers.authorization === `Bearer ${t}`)) return send(401, { message: 'Bad credentials' });
    const writeTokens = [opts.token].flat().slice(1);
    if (req.method === 'POST' && writeTokens.length && !writeTokens.some((t) => req.headers.authorization === `Bearer ${t}`)) return send(403, { message: 'Resource not accessible by personal access token' });
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
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
    if (m && req.method === 'GET') {
      const [repo, number] = [m[1]!, Number(m[2])];
      const i = data.issues.find((x) => x.number === number && (!x.repo || x.repo === repo));
      if (!i) return send(404, { message: 'Not Found' });
      const count = comments.filter((c) => c.repo === repo && c.number === number).length;
      return send(200, { number, title: i.title, body: i.body ?? null, state: 'open', user: { login: i.user ?? 'octocat' }, comments: count, labels: i.labels.map((name) => ({ name })), html_url: `https://github.com/${repo}/issues/${number}`, ...(i.pull_request ? { pull_request: {} } : {}) });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/files)?$/);
    if (m) {
      const pr = data.pulls?.find((p) => p.number === Number(m![2]));
      if (!pr) return send(404, { message: 'Not Found' });
      if (m[3]) return send(200, slice(pr.files));
      const seq = Array.isArray(pr.mergeable) ? pr.mergeable : [pr.mergeable === undefined ? true : pr.mergeable];
      const reads = ((pr as any).reads = ((pr as any).reads ?? 0) + 1);
      const mergeable = seq[Math.min(reads, seq.length) - 1] ?? null;
      const sum = (k: 'additions' | 'deletions') => pr.files.reduce((n, f) => n + f[k], 0);
      return send(200, { number: pr.number, title: pr.title, body: pr.body ?? null, state: 'open', draft: false, user: { login: pr.user ?? 'octocat' }, html_url: `https://github.com/${m[1]}/pull/${pr.number}`, base: pr.base, head: pr.head, mergeable, mergeable_state: mergeable === null ? 'unknown' : pr.mergeable_state ?? (mergeable ? 'clean' : 'dirty'), additions: sum('additions'), deletions: sum('deletions') });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
    if (m) {
      const [repo, number] = [m[1]!, Number(m[2])];
      if (req.method === 'POST') {
        const c = { id: 9000 + comments.length, repo, number, body: String(JSON.parse(raw || '{}').body ?? '') };
        comments.push(c);
        return send(201, { id: c.id, body: c.body, html_url: `https://github.com/${repo}/pull/${number}#issuecomment-${c.id}` });
      }
      return send(200, slice(comments.filter((c) => c.repo === repo && c.number === number)).map((c) => ({ id: c.id, body: c.body, user: { login: c.user ?? 'octocat' }, html_url: `https://github.com/${repo}/pull/${number}#issuecomment-${c.id}` })));
    }
    send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, opts.host ?? '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://${opts.host ?? '127.0.0.1'}:${port}`, requests, comments, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
