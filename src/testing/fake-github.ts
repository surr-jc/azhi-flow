import { createHash } from 'node:crypto';
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

/** What the push and pull request tools wrote. */
export interface FakeGitState {
  blobs: Map<string, Buffer>;
  trees: Map<string, { base_tree?: string; tree: Array<{ path: string; mode: string; type: string; sha: string | null }> }>;
  commits: Map<string, { message: string; tree: string; parents: string[] }>;
  /** Branch name to commit SHA. */
  refs: Map<string, string>;
  /** Pull requests opened through the API. */
  pulls: Array<{ number: number; repo: string; title: string; head: string; base: string; body: string; draft: boolean }>;
}

export interface FakeComment {
  id: number;
  repo: string;
  number: number;
  body: string;
}

/** `token`: the accepted bearer token, or a list whose first entry may only read and the rest may also write. */
/** `comments`: comments that already exist (on issues or pull requests). */
export async function startFakeGithub(data: FakeGithubData, opts: { token?: string | string[]; host?: string; comments?: Array<FakeComment & { user?: string }>; defaultBranch?: string; refs?: Record<string, { sha: string; message: string }> } = {}) {
  const requests: string[] = [];
  const git: FakeGitState = { blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map(), pulls: [] };
  for (const [name, c] of Object.entries(opts.refs ?? {})) {
    git.refs.set(name, c.sha);
    git.commits.set(c.sha, { message: c.message, tree: `tree-${c.sha}`, parents: [] });
  }
  const sha = (...parts: unknown[]) => createHash('sha1').update(JSON.stringify(parts)).digest('hex');
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
    if (req.method !== 'GET' && writeTokens.length && !writeTokens.some((t) => req.headers.authorization === `Bearer ${t}`)) return send(403, { message: 'Resource not accessible by personal access token' });
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
    const body = () => JSON.parse(raw || '{}');
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (m && req.method === 'GET') return send(200, { full_name: m[1], default_branch: opts.defaultBranch ?? 'main' });
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/);
    if (m && req.method === 'GET') {
      const at = git.refs.get(decodeURIComponent(m[2]!));
      return at ? send(200, { ref: `refs/heads/${m[2]}`, object: { sha: at, type: 'commit' } }) : send(404, { message: 'Not Found' });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/);
    if (m && req.method === 'PATCH') {
      const name = decodeURIComponent(m[2]!);
      if (!git.refs.has(name)) return send(422, { message: 'Reference does not exist' });
      const b = body();
      if (!git.commits.has(b.sha)) return send(422, { message: 'Object does not exist' });
      git.refs.set(name, b.sha);
      return send(200, { ref: `refs/heads/${name}`, object: { sha: b.sha } });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/refs$/);
    if (m && req.method === 'POST') {
      const b = body();
      const name = String(b.ref ?? '').replace(/^refs\/heads\//, '');
      if (git.refs.has(name)) return send(422, { message: 'Reference already exists' });
      if (!git.commits.has(b.sha)) return send(422, { message: 'Object does not exist' });
      git.refs.set(name, b.sha);
      return send(201, { ref: b.ref, object: { sha: b.sha } });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/commits\/([0-9a-f]+)$/);
    if (m && req.method === 'GET') {
      // A commit the fake did not make is taken to exist (the base commit of a checkout from the fake git host).
      const c = git.commits.get(m[2]!) ?? (m[2]!.length === 40 ? { message: 'base', tree: `tree-${m[2]}`, parents: [] } : undefined);
      return c ? send(200, { sha: m[2], message: c.message, tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })), html_url: `https://github.com/${m[1]}/commit/${m[2]}` }) : send(404, { message: 'Not Found' });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/(blobs|trees|commits)$/);
    if (m && req.method === 'POST') {
      const b = body();
      if (m[2] === 'blobs') {
        const data = Buffer.from(String(b.content ?? ''), b.encoding === 'base64' ? 'base64' : 'utf8');
        const id = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
        git.blobs.set(id, data);
        return send(201, { sha: id });
      }
      if (m[2] === 'trees') {
        for (const e of b.tree ?? []) if (e.sha !== null && !git.blobs.has(e.sha)) return send(422, { message: `blob ${e.sha} does not exist` });
        const id = sha('tree', b);
        git.trees.set(id, { base_tree: b.base_tree, tree: b.tree ?? [] });
        return send(201, { sha: id });
      }
      if (!git.trees.has(b.tree)) return send(422, { message: 'tree does not exist' });
      const id = sha('commit', b, git.commits.size);
      git.commits.set(id, { message: String(b.message ?? ''), tree: b.tree, parents: b.parents ?? [] });
      return send(201, { sha: id, message: b.message, html_url: `https://github.com/${m[1]}/commit/${id}` });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
    if (m) {
      const repo = m[1]!;
      const view = (p: FakeGitState['pulls'][number]) => ({ number: p.number, title: p.title, body: p.body, draft: p.draft, state: 'open', html_url: `https://github.com/${repo}/pull/${p.number}`, head: { ref: p.head, sha: git.refs.get(p.head) }, base: { ref: p.base } });
      if (req.method === 'POST') {
        const b = body();
        if (!git.refs.has(b.head)) return send(422, { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] });
        if (git.pulls.some((p) => p.repo === repo && p.head === b.head)) return send(422, { message: 'A pull request already exists' });
        const p = { number: 100 + git.pulls.length + 1, repo, title: String(b.title), head: String(b.head), base: String(b.base), body: String(b.body ?? ''), draft: b.draft === true };
        git.pulls.push(p);
        return send(201, view(p));
      }
      const head = url.searchParams.get('head')?.split(':').pop();
      return send(200, git.pulls.filter((p) => p.repo === repo && (!head || p.head === head)).map(view));
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
  /** The files a branch's commit sets: path to content (deleted paths map to null). */
  const branchFiles = (name: string): Record<string, string | null> => {
    const c = git.commits.get(git.refs.get(name) ?? '');
    const t = c && git.trees.get(c.tree);
    return Object.fromEntries((t?.tree ?? []).map((e) => [e.path, e.sha === null ? null : (git.blobs.get(e.sha)?.toString('utf8') ?? '')]));
  };
  return { url: `http://${opts.host ?? '127.0.0.1'}:${port}`, requests, comments, git, branchFiles, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
