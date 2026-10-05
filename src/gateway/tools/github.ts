import { ErrorClass } from '../../lib/errors.js';
import { checkEgress } from '../egress.js';
import { SendError } from '../ledger.js';

/**
 * Read-only GitHub tools for the flagship workflow (`builtin` transports `github.ci-runs`,
 * `github.flaky-tests` and `github.incidents`). Each returns the same shape the fixture tools
 * return, so a workspace swaps fixtures for real data by registering a new tool revision.
 *
 * Config (in the tool registration): `repos: ["owner/name"]`, optional `api_url` (GitHub
 * Enterprise Server, default https://api.github.com), and per tool `label` (flaky tests default
 * `flaky-test`, incidents default `incident`). The credential is a workspace secret holding a
 * token with read access to Actions and Issues.
 */
export interface GithubConfig {
  repos?: string[];
  api_url?: string;
  label?: string;
  quarantine_label?: string;
  /** At most this many failed runs get a jobs lookup, to bound API use. */
  failed_run_details?: number;
}

const MAX_PAGES = 3;

function repos(cfg: GithubConfig): string[] {
  const list = cfg.repos ?? [];
  if (!list.length || list.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) throw new SendError('github tool config needs repos: ["owner/name", ...]', true, ErrorClass.invalidInput);
  return list;
}

async function get(cfg: GithubConfig, token: string | undefined, path: string, timeoutMs: number): Promise<any> {
  return request(cfg, token, 'GET', path, undefined, timeoutMs);
}

async function request(cfg: GithubConfig, token: string | undefined, method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<any> {
  if (!token) throw new SendError('the GitHub tools need a token credential', true, ErrorClass.authorization);
  const url = `${(cfg.api_url ?? 'https://api.github.com').replace(/\/$/, '')}${path}`;
  await checkEgress(url);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'azhi-flow', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A POST whose response was lost may have landed: not definite, so the ledger looks it up.
    throw new SendError(`GitHub request failed: ${(err as Error).message}`, false);
  }
  const text = await res.text();
  if (!res.ok) {
    const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
    const definite = res.status >= 400 && res.status < 500 && res.status !== 408 && !limited;
    const cls = res.status === 401 || (res.status === 403 && !limited) ? ErrorClass.authorization : definite ? ErrorClass.invalidInput : ErrorClass.transient;
    const sso = res.headers.get('x-github-sso');
    const hint =
      res.status === 404
        ? ` (GitHub answers 404 when the pull request or repository does not exist, and also when this token cannot see the repository: check the number, then that the token's resource owner is the organization and that it is approved and SSO-authorized. Test it with: curl -H "Authorization: Bearer $TOKEN" ${(cfg.api_url ?? 'https://api.github.com').replace(/\/$/, '')}/repos/OWNER/REPO)`
        : res.status === 403 && sso
          ? ` (the organization requires SSO: authorize the token for it, ${sso.replace(/^required;\s*url=/, '')})`
          : '';
    throw new SendError(`GitHub HTTP ${res.status}: ${text.slice(0, 200)}${hint}`, definite, cls);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SendError('GitHub returned a response that is not JSON', false);
  }
}

async function pages(cfg: GithubConfig, token: string | undefined, path: string, key: string | undefined, timeoutMs: number): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await get(cfg, token, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, timeoutMs);
    const items: any[] = key ? (body?.[key] ?? []) : Array.isArray(body) ? body : [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

const outcome = (c: string | null): string => (c === 'success' ? 'success' : c === 'cancelled' || c === 'skipped' ? 'cancelled' : 'failure');

/** CI runs on GitHub Actions: completed runs since `since`, with the names of failed jobs. */
export async function ciRuns(cfg: GithubConfig, args: { since?: string }, token: string | undefined, timeoutMs: number) {
  const since = args.since ? `&created=%3E%3D${encodeURIComponent(args.since)}` : '';
  const detail = cfg.failed_run_details ?? 20;
  const out: any[] = [];
  for (const repo of repos(cfg)) {
    const runs = await pages(cfg, token, `/repos/${repo}/actions/runs?status=completed${since}`, 'workflow_runs', timeoutMs);
    let looked = 0;
    for (const r of runs) {
      const status = outcome(r.conclusion);
      let failed: string[] = [];
      if (status === 'failure' && looked < detail) {
        looked++;
        const jobs = await get(cfg, token, `/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`, timeoutMs);
        failed = (jobs.jobs ?? []).filter((j: any) => j.conclusion === 'failure').map((j: any) => String(j.name));
      }
      out.push({ id: `${repo}#${r.id}`, status, branch: String(r.head_branch ?? ''), started_at: r.run_started_at ?? r.created_at, finished_at: r.updated_at, failed_tests: failed });
    }
  }
  return out.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

async function issues(cfg: GithubConfig, token: string | undefined, label: string, timeoutMs: number): Promise<Array<{ repo: string; issue: any }>> {
  const out: Array<{ repo: string; issue: any }> = [];
  for (const repo of repos(cfg)) {
    const found = await pages(cfg, token, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`, undefined, timeoutMs);
    // The issues API also returns pull requests.
    for (const issue of found) if (!issue.pull_request) out.push({ repo, issue });
  }
  return out;
}

/** Flaky tests tracked as issues with the flaky label: title is the test, comments count failures. */
export async function flakyTests(cfg: GithubConfig, token: string | undefined, timeoutMs: number) {
  const quarantine = cfg.quarantine_label ?? 'quarantined';
  return (await issues(cfg, token, cfg.label ?? 'flaky-test', timeoutMs)).map(({ issue }) => ({
    test: String(issue.title),
    failures: Number(issue.comments ?? 0) + 1,
    quarantined: (issue.labels ?? []).some((l: any) => (typeof l === 'string' ? l : l.name) === quarantine),
  }));
}

/** Open incidents tracked as issues with the incident label; severity from a sevN label. */
export async function incidents(cfg: GithubConfig, token: string | undefined, timeoutMs: number) {
  return (await issues(cfg, token, cfg.label ?? 'incident', timeoutMs)).map(({ repo, issue }) => ({
    id: `${repo}#${issue.number}`,
    title: String(issue.title),
    severity: ((issue.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)).find((n: string) => /^sev[1-5]$/i.test(n)) ?? 'unknown').toLowerCase(),
    opened_at: issue.created_at,
  }));
}

/** A repository named in tool arguments: owner/name, and in `repos` when the registration lists any. */
function argRepo(cfg: GithubConfig, repo: unknown): string {
  const r = String(repo ?? '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new SendError(`repo must be owner/name, got '${r}'`, true, ErrorClass.invalidInput);
  if (cfg.repos?.length && !cfg.repos.some((x) => x.toLowerCase() === r.toLowerCase())) {
    throw new SendError(
      `repo ${r} is not one of the repositories this tool may use (${cfg.repos.join(', ')}). Add it on the Examples page (Allowed repositories) or with: azhi example repos <example> --add ${r} (or azhi tool repos <tool> --add ${r})`,
      true,
      ErrorClass.authorization,
    );
  }
  return r;
}

function argNumber(n: unknown): number {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1) throw new SendError(`number must be a positive integer, got '${String(n)}'`, true, ErrorClass.invalidInput);
  return v;
}

const MAX_BODY = 20_000;

/** One pull request (`github.pull-request`): metadata, refs and the changed files with line counts. */
export async function pullRequest(cfg: GithubConfig, args: { repo?: unknown; number?: unknown }, token: string | undefined, timeoutMs: number) {
  const repo = argRepo(cfg, args.repo);
  const number = argNumber(args.number);
  const pr = await get(cfg, token, `/repos/${repo}/pulls/${number}`, timeoutMs);
  const files = await pages(cfg, token, `/repos/${repo}/pulls/${number}/files`, undefined, timeoutMs);
  return {
    repo,
    number,
    title: String(pr.title ?? ''),
    body: String(pr.body ?? '').slice(0, MAX_BODY),
    author: String(pr.user?.login ?? ''),
    state: String(pr.state ?? ''),
    draft: Boolean(pr.draft),
    url: String(pr.html_url ?? ''),
    base_ref: String(pr.base?.ref ?? ''),
    base_sha: String(pr.base?.sha ?? ''),
    head_ref: String(pr.head?.ref ?? ''),
    head_sha: String(pr.head?.sha ?? ''),
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    changed_files: files.map((f: any) => ({ path: String(f.filename), status: String(f.status), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })),
  };
}

const marker = (key: string) => `<!-- azhi-action:${key} -->`;

/**
 * A comment on a pull request (`github.pr-comment`, write-dedupable): the body carries the ledger
 * action ID in a hidden marker, and a lookup finds the comment by it before any resend.
 */
export async function commentOnPullRequest(cfg: GithubConfig, args: { repo?: unknown; number?: unknown; body?: unknown }, token: string | undefined, key: string, timeoutMs: number) {
  const repo = argRepo(cfg, args.repo);
  const number = argNumber(args.number);
  const text = String(args.body ?? '').slice(0, 60_000);
  if (!text.trim()) throw new SendError('comment body is empty', true, ErrorClass.invalidInput);
  const c = await request(cfg, token, 'POST', `/repos/${repo}/issues/${number}/comments`, { body: `${text}\n\n${marker(key)}` }, timeoutMs);
  return { id: Number(c.id), url: String(c.html_url ?? '') };
}

export async function findPullRequestComment(cfg: GithubConfig, args: { repo?: unknown; number?: unknown }, token: string | undefined, key: string, timeoutMs: number) {
  const repo = argRepo(cfg, args.repo);
  const number = argNumber(args.number);
  const comments = await pages(cfg, token, `/repos/${repo}/issues/${number}/comments`, undefined, timeoutMs);
  const hit = comments.find((c: any) => String(c.body ?? '').includes(marker(key)));
  return hit ? { id: Number(hit.id), url: String(hit.html_url ?? '') } : null;
}

const MAX_COMMENTS = 20;

/**
 * One issue (`github.issue`), named `owner/name#123`, a github.com issue URL, or `#123` / `123`
 * when the registration lists exactly one repository. Includes the first comments, where the
 * details of a request often are. Pull requests are refused: this reads issues only.
 */
export async function issue(cfg: GithubConfig, args: { issue?: unknown }, token: string | undefined, timeoutMs: number) {
  const ref = String(args.issue ?? '').trim();
  const m = ref.match(/^(?:https?:\/\/[^/]+\/)?([\w.-]+\/[\w.-]+)(?:#|\/issues\/)(\d+)\/?$/) ?? ref.match(/^()#?(\d+)$/);
  if (!m) throw new SendError(`issue must be owner/name#number, got '${ref.slice(0, 100)}'`, true, ErrorClass.invalidInput);
  let repo = m[1]!;
  if (!repo) {
    if (cfg.repos?.length !== 1) throw new SendError(`name the repository: owner/name#${m[2]}`, true, ErrorClass.invalidInput);
    repo = cfg.repos[0]!;
  }
  repo = argRepo(cfg, repo);
  const number = argNumber(m[2]);
  const it = await get(cfg, token, `/repos/${repo}/issues/${number}`, timeoutMs);
  if (it.pull_request) throw new SendError(`${repo}#${number} is a pull request, not an issue`, true, ErrorClass.invalidInput);
  const comments = Number(it.comments ?? 0) > 0 ? await get(cfg, token, `/repos/${repo}/issues/${number}/comments?per_page=${MAX_COMMENTS}`, timeoutMs) : [];
  return {
    repo,
    number,
    title: String(it.title ?? ''),
    body: String(it.body ?? '').slice(0, MAX_BODY),
    author: String(it.user?.login ?? ''),
    state: String(it.state ?? ''),
    labels: (it.labels ?? []).map((l: any) => String(typeof l === 'string' ? l : l.name)),
    url: String(it.html_url ?? ''),
    comments: (Array.isArray(comments) ? comments : []).map((c: any) => ({ author: String(c.user?.login ?? ''), body: String(c.body ?? '').slice(0, 4000) })),
  };
}
