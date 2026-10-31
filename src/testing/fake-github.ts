import { createHash } from 'node:crypto';
import http from 'node:http';

/**
 * A minimal stand-in for the parts of the GitHub REST API the built-in tools use: Actions runs
 * and their jobs, open issues by label, pull requests with their files, and PR comments (which
 * it stores). Used by tests and local demos; point a tool's `api_url` at it.
 */
export interface FakeGithubData {
  runs: Array<{ id: number; conclusion: string; head_branch: string; run_started_at: string; updated_at: string; jobs?: Array<{ name: string; conclusion: string }> }>;
  issues: Array<{ number: number; title: string; labels: string[]; comments?: number; created_at?: string; pull_request?: boolean; body?: string; user?: string; repo?: string; id?: number; state?: 'open' | 'closed' }>;
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
    /** `open` unless set (a merged pull request is `closed`). */
    state?: 'open' | 'closed';
    draft?: boolean;
    /** Set when the pull request was merged (by `PUT .../merge`, or to start merged). */
    merged?: boolean;
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
  /** The author's login; comments the gateway posts are by `BOT_LOGIN`. */
  user?: string;
  /** How many times the comment was edited. */
  edits?: number;
}

/** The account every token of the fake belongs to (what `GET /user` answers). */
export const BOT_LOGIN = 'azhi-bot';

/** `token`: the accepted bearer token, or a list whose first entry may only read and the rest may also write. */
/** `comments`: comments that already exist (on issues or pull requests). */
export async function startFakeGithub(data: FakeGithubData, opts: { token?: string | string[]; host?: string; comments?: Array<FakeComment & { user?: string }>; defaultBranch?: string; refs?: Record<string, { sha: string; message: string }>; repos?: Record<string, { private?: boolean; permissions?: Record<string, boolean> }>; scopes?: string; noSubIssues?: boolean; links?: Array<{ repo: string; parent: number; child: number }>; files?: Record<string, string[]> } = {}) {
  const requests: string[] = [];
  const git: FakeGitState = { blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map(), pulls: [] };
  for (const [name, c] of Object.entries(opts.refs ?? {})) {
    git.refs.set(name, c.sha);
    git.commits.set(c.sha, { message: c.message, tree: `tree-${c.sha}`, parents: [] });
  }
  const sha = (...parts: unknown[]) => createHash('sha1').update(JSON.stringify(parts)).digest('hex');
  const comments: Array<FakeComment & { user?: string }> = [...(opts.comments ?? [])];
  /** What the issue splitter created, and the sub-issue links it made. */
  const created: FakeGithubData['issues'] = [];
  const links: Array<{ repo: string; parent: number; child: number }> = [...(opts.links ?? [])];
  /** Merges made through the API. */
  const merges: Array<{ repo: string; number: number; sha: string; method: string }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url ?? '/', 'http://localhost');
    // GitHub Enterprise Server serves the same API under /api/v3.
    url.pathname = url.pathname.replace(/^\/api\/v3(?=\/)/, '');
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
    // Every token is the same account here; comments it writes are by that login.
    if (url.pathname === '/user') return send(200, { login: BOT_LOGIN, type: 'User' });
    // Repository contents (`opts.files`: repo to the file paths it has): a file, or the entries of a directory.
    const content = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
    if (content) {
      const path = decodeURIComponent(content[2]!).replace(/\/$/, '');
      const have = opts.files?.[content[1]!] ?? [];
      if (have.includes(path)) return send(200, { type: 'file', path, name: path.split('/').pop(), size: 1 });
      const kids = have.filter((f) => f.startsWith(`${path}/`)).map((f) => f.slice(path.length + 1).split('/')[0]!);
      if (kids.length) return send(200, [...new Set(kids)].map((name) => ({ type: 'file', name, path: `${path}/${name}` })));
      return send(404, { message: 'Not Found' });
    }
    let m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/);
    if (m && req.method === 'PATCH') {
      const c = comments.find((x) => x.repo === m![1] && x.id === Number(m![2]));
      if (!c) return send(404, { message: 'Not Found' });
      if ((c.user ?? 'octocat') !== BOT_LOGIN) return send(403, { message: 'You can only edit your own comments' });
      c.body = String(JSON.parse(raw || '{}').body ?? '');
      c.edits = (c.edits ?? 0) + 1;
      return send(200, { id: c.id, body: c.body, html_url: `https://github.com/${c.repo}/pull/${c.number}#issuecomment-${c.id}` });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/);
    if (m) {
      const since = url.searchParams.get('created')?.replace(/^>=/, '');
      const runs = data.runs.filter((r) => !since || Date.parse(r.run_started_at) >= Date.parse(since));
      return send(200, { total_count: runs.length, workflow_runs: slice(runs).map(({ jobs: _j, ...r }) => ({ ...r, status: 'completed', created_at: r.run_started_at })) });
    }
    m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/);
    if (m) return send(200, { jobs: data.runs.find((r) => r.id === Number(m![1]))?.jobs ?? [] });
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/);
    if (m && req.method === 'POST') {
      // Create an issue (the issue splitter): numbered after the highest one, with an id for sub-issue links.
      const b = JSON.parse(raw || '{}');
      const number = Math.max(99, ...data.issues.map((i) => i.number)) + 1;
      const issue = { number, id: 5000 + number, repo: m[1]!, title: String(b.title ?? ''), body: String(b.body ?? ''), labels: ((b.labels ?? []) as string[]).map(String), user: 'azhi-bot', created_at: '2026-10-01T00:00:00Z' };
      data.issues.push(issue);
      created.push(issue);
      return send(201, { number, id: issue.id, title: issue.title, html_url: `https://github.com/${m[1]}/issues/${number}` });
    }
    if (m) {
      const label = url.searchParams.get('labels');
      const state = url.searchParams.get('state');
      const found = data.issues.filter((i) => (!label || i.labels.includes(label)) && (!i.repo || i.repo === m![1]) && (!state || state === 'all' || (i.state ?? 'open') === state));
      return send(200, slice(found).map((i) => ({ number: i.number, id: i.id ?? 4000 + i.number, title: i.title, body: i.body ?? null, state: i.state ?? 'open', comments: i.comments ?? 0, created_at: i.created_at ?? '2026-09-25T04:10:00Z', labels: i.labels.map((name) => ({ name })), html_url: `https://github.com/${m![1]}/issues/${i.number}`, ...(i.pull_request ? { pull_request: {} } : {}) })));
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/sub_issues$/);
    if (m && req.method === 'GET') {
      if (opts.noSubIssues) return send(404, { message: 'Not Found' });
      const kids = links.filter((l) => l.repo === m![1] && l.parent === Number(m![2])).map((l) => data.issues.find((i) => (i.id ?? 4000 + i.number) === l.child && (!i.repo || i.repo === m![1])));
      return send(200, slice(kids.filter((i): i is NonNullable<typeof i> => Boolean(i))).map((i) => ({ number: i.number, id: i.id ?? 4000 + i.number, title: i.title, body: i.body ?? null, state: i.state ?? 'open', html_url: `https://github.com/${m![1]}/issues/${i.number}` })));
    }
    if (m && req.method === 'POST') {
      const child = Number(JSON.parse(raw || '{}').sub_issue_id);
      const link = { repo: m[1]!, parent: Number(m[2]), child };
      if (opts.noSubIssues) return send(404, { message: 'Not Found' });
      if (links.some((l) => l.repo === link.repo && l.child === child)) return send(422, { message: 'Validation Failed: sub-issue already has a parent' });
      links.push(link);
      return send(201, { number: link.parent });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels$/);
    if (m && req.method === 'POST') {
      const i = data.issues.find((x) => x.number === Number(m![2]) && (!x.repo || x.repo === m![1]));
      if (!i) return send(404, { message: 'Not Found' });
      for (const l of (JSON.parse(raw || '{}').labels ?? []) as string[]) if (!i.labels.includes(l)) i.labels.push(l);
      return send(200, i.labels.map((name) => ({ name })));
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
    if (m && req.method === 'GET') {
      const [repo, number] = [m[1]!, Number(m[2])];
      const i = data.issues.find((x) => x.number === number && (!x.repo || x.repo === repo));
      if (!i) return send(404, { message: 'Not Found' });
      const count = comments.filter((c) => c.repo === repo && c.number === number).length;
      return send(200, { number, title: i.title, body: i.body ?? null, state: i.state ?? 'open', user: { login: i.user ?? 'octocat' }, comments: count, labels: i.labels.map((name) => ({ name })), html_url: `https://github.com/${repo}/issues/${number}`, ...(i.pull_request ? { pull_request: {} } : {}) });
    }
    const body = () => JSON.parse(raw || '{}');
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (m && req.method === 'GET') {
      // `repos` lists the repositories this token can see, with what it may do there; without it every repository exists.
      const known = opts.repos?.[m[1]!];
      if (opts.repos && !known) return send(404, { message: 'Not Found' });
      if (opts.scopes !== undefined) res.setHeader('x-oauth-scopes', opts.scopes);
      return send(200, { full_name: m[1], default_branch: opts.defaultBranch ?? 'main', ...(known?.private !== undefined ? { private: known.private } : {}), ...(known?.permissions ? { permissions: known.permissions } : {}) });
    }
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
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/);
    if (m && req.method === 'PUT') {
      const pr = data.pulls?.find((p) => p.number === Number(m![2]));
      if (!pr) return send(404, { message: 'Not Found' });
      const b = body();
      if (pr.state === 'closed' || pr.mergeable === false || pr.mergeable_state === 'dirty') return send(405, { message: 'Pull Request is not mergeable' });
      if (b.sha && b.sha !== pr.head.sha) return send(409, { message: 'Head branch was modified. Review and try the merge again.' });
      pr.state = 'closed';
      pr.merged = true;
      const merge = { repo: m[1]!, number: pr.number, sha: b.sha as string, method: String(b.merge_method ?? 'merge') };
      merges.push(merge);
      return send(200, { merged: true, sha: sha('merge', merge), message: 'Pull Request successfully merged' });
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
      return send(200, { number: pr.number, title: pr.title, body: pr.body ?? null, state: pr.state ?? 'open', draft: pr.draft ?? false, merged: pr.merged ?? false, ...(pr.merged ? { merge_commit_sha: sha('merge', pr.number) } : {}), user: { login: pr.user ?? 'octocat' }, html_url: `https://github.com/${m[1]}/pull/${pr.number}`, base: pr.base, head: pr.head, mergeable, mergeable_state: mergeable === null ? 'unknown' : pr.mergeable_state ?? (mergeable ? 'clean' : 'dirty'), additions: sum('additions'), deletions: sum('deletions') });
    }
    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
    if (m) {
      const [repo, number] = [m[1]!, Number(m[2])];
      if (req.method === 'POST') {
        const c = { id: 9000 + comments.length, repo, number, body: String(JSON.parse(raw || '{}').body ?? ''), user: BOT_LOGIN };
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
  return { url: `http://${opts.host ?? '127.0.0.1'}:${port}`, requests, comments, created, links, merges, issues: data.issues, git, branchFiles, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
