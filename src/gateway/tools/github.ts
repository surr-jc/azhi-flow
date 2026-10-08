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
  /** Branches the push and pull request tools may create or move start with this. Default `azhi/`. */
  branch_prefix?: string;
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

async function request(cfg: GithubConfig, token: string | undefined, method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown, timeoutMs: number): Promise<any> {
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
const MERGEABLE_RETRIES = 4;
const MERGEABLE_BACKOFF_MS = 400;

/** One pull request (`github.pull-request`): metadata, refs and the changed files with line counts. */
export async function pullRequest(cfg: GithubConfig, args: { repo?: unknown; number?: unknown }, token: string | undefined, timeoutMs: number) {
  const repo = argRepo(cfg, args.repo);
  const number = argNumber(args.number);
  const deadline = Date.now() + timeoutMs;
  let pr = await get(cfg, token, `/repos/${repo}/pulls/${number}`, timeoutMs);
  // GitHub computes mergeability lazily: null means "not yet", so ask again a few times.
  for (let i = 1; pr.mergeable == null && i <= MERGEABLE_RETRIES && Date.now() + MERGEABLE_BACKOFF_MS * i < deadline; i++) {
    await new Promise((r) => setTimeout(r, MERGEABLE_BACKOFF_MS * i));
    pr = await get(cfg, token, `/repos/${repo}/pulls/${number}`, Math.max(1000, deadline - Date.now()));
  }
  const files = await pages(cfg, token, `/repos/${repo}/pulls/${number}/files`, undefined, timeoutMs);
  return {
    repo,
    number,
    title: String(pr.title ?? ''),
    body: String(pr.body ?? '').slice(0, MAX_BODY),
    author: String(pr.user?.login ?? ''),
    state: String(pr.state ?? ''),
    draft: Boolean(pr.draft),
    // null while GitHub has not computed it; mergeable_state is 'unknown' then, never 'clean'.
    mergeable: pr.mergeable ?? null,
    mergeable_state: pr.mergeable == null ? 'unknown' : String(pr.mergeable_state ?? 'unknown'),
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

/** A lookup that answers 404 when the thing is not there (a branch, a commit). */
async function getOrNull(cfg: GithubConfig, token: string | undefined, path: string, timeoutMs: number): Promise<any | null> {
  try {
    return await get(cfg, token, path, timeoutMs);
  } catch (err) {
    if (err instanceof SendError && /GitHub HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

const TRAILER = 'Azhi-Action:';
const trailer = (key: string) => `${TRAILER} ${key}`;
const MAX_PUSH_FILES = 300;
const MAX_PUSH_BYTES = 1_500_000;

/**
 * A branch name the tools may write: under the configured prefix (default `azhi/`), and made git-safe here
 * (lower case; anything but letters, digits, `.`, `_`, `-` and `/` becomes `-`), so a ticket key can name it.
 */
export function branchName(cfg: GithubConfig, raw: unknown): string {
  const prefix = cfg.branch_prefix ?? 'azhi/';
  if (!/^[a-z0-9][a-z0-9._/-]*\/$/.test(prefix)) throw new SendError(`branch_prefix must be lower-case letters, digits, '.', '_', '-' and '/', ending in '/', got '${prefix}'`, true, ErrorClass.invalidInput);
  const given = String(raw ?? '').trim();
  if (!given.toLowerCase().startsWith(prefix)) throw new SendError(`branch must start with ${prefix} (this tool only writes its own branches), got '${given.slice(0, 100)}'`, true, ErrorClass.authorization);
  const rest = given
    .slice(prefix.length)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .split('/')
    .map((p) => p.replace(/^[.-]+|[.-]+$/g, '').replace(/\.lock$/, ''))
    .filter(Boolean)
    .join('/')
    .slice(0, 100);
  if (!rest) throw new SendError(`branch needs a name after ${prefix}`, true, ErrorClass.invalidInput);
  return `${prefix}${rest}`;
}

function filePath(p: unknown): string {
  const s = String(p ?? '');
  const parts = s.split('/');
  if (!s || s.length > 400 || s.startsWith('/') || s.includes('\\') || /[\u0000-\u001f]/.test(s) || parts.some((x) => !x || x === '.' || x === '..' || x.toLowerCase() === '.git')) {
    throw new SendError(`file path '${s.slice(0, 200)}' is not a plain path inside the repository`, true, ErrorClass.invalidInput);
  }
  return s;
}

interface PushFile {
  path?: unknown;
  status?: unknown;
  mode?: unknown;
  content?: unknown;
  encoding?: unknown;
}

/**
 * Commits a set of changed files onto `base_sha` and points a branch at the commit (`github.push-branch`,
 * write-dedupable), with the Git Data API: no clone and no git on the gateway. `files` is the shape a
 * write-mode workspace step returns (path, status, mode, content, encoding). The branch is created, or
 * moved when Azhi made its current commit (a re-run after a send-back); a branch someone else made is
 * refused. The commit message carries the ledger action ID as a trailer, which the lookup finds.
 */
export async function pushBranch(cfg: GithubConfig, args: { repo?: unknown; branch?: unknown; base_sha?: unknown; message?: unknown; files?: unknown }, token: string | undefined, key: string, timeoutMs: number) {
  const repo = argRepo(cfg, args.repo);
  const branch = branchName(cfg, args.branch);
  const base = String(args.base_sha ?? '');
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base)) throw new SendError(`base_sha must be a full commit SHA, got '${base.slice(0, 80)}'`, true, ErrorClass.invalidInput);
  const files = Array.isArray(args.files) ? (args.files as PushFile[]) : [];
  if (!files.length) throw new SendError('there are no changed files to push', true, ErrorClass.invalidInput);
  if (files.length > MAX_PUSH_FILES) throw new SendError(`at most ${MAX_PUSH_FILES} files per push, got ${files.length}`, true, ErrorClass.invalidInput);
  const title = String(args.message ?? '').trim();
  if (!title) throw new SendError('the commit message is empty', true, ErrorClass.invalidInput);
  const message = `${title.slice(0, 5000)}\n\n${trailer(key)}`;

  // Everything is checked before anything is written.
  let bytes = 0;
  const entries = files.map((f) => {
    const path = filePath(f.path);
    if (f.status === 'deleted') return { path, deleted: true as const };
    if (f.status !== 'added' && f.status !== 'modified') throw new SendError(`file ${path}: status must be added, modified or deleted`, true, ErrorClass.invalidInput);
    const mode = f.mode === undefined ? '100644' : String(f.mode);
    if (mode !== '100644' && mode !== '100755') throw new SendError(`file ${path}: only regular files (mode 100644 or 100755) are pushed, got ${mode}`, true, ErrorClass.invalidInput);
    const encoding = f.encoding === 'base64' ? 'base64' : 'utf-8';
    const content = typeof f.content === 'string' ? f.content : '';
    bytes += encoding === 'base64' ? Math.floor((content.length * 3) / 4) : Buffer.byteLength(content);
    return { path, mode, content, encoding };
  });
  if (new Set(entries.map((e) => e.path)).size !== entries.length) throw new SendError('a file is listed twice', true, ErrorClass.invalidInput);
  if (bytes > MAX_PUSH_BYTES) throw new SendError(`the change has ${bytes} bytes of content; at most ${MAX_PUSH_BYTES} per push`, true, ErrorClass.invalidInput);

  const existing = await getOrNull(cfg, token, `/repos/${repo}/git/ref/heads/${branch}`, timeoutMs);
  if (existing) {
    const head = await get(cfg, token, `/repos/${repo}/git/commits/${existing.object?.sha}`, timeoutMs);
    if (!String(head.message ?? '').includes(TRAILER)) {
      throw new SendError(`branch ${branch} already exists in ${repo} and its last commit was not made by Azhi; delete it or use another branch name`, true, ErrorClass.invalidInput);
    }
  }
  const baseCommit = await get(cfg, token, `/repos/${repo}/git/commits/${base}`, timeoutMs);
  const tree: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    if ('deleted' in e) tree.push({ path: e.path, mode: '100644', type: 'blob', sha: null });
    else {
      const blob = await request(cfg, token, 'POST', `/repos/${repo}/git/blobs`, { content: e.content, encoding: e.encoding }, timeoutMs);
      tree.push({ path: e.path, mode: e.mode, type: 'blob', sha: String(blob.sha) });
    }
  }
  const newTree = await request(cfg, token, 'POST', `/repos/${repo}/git/trees`, { base_tree: String(baseCommit.tree?.sha ?? ''), tree }, timeoutMs);
  const commit = await request(cfg, token, 'POST', `/repos/${repo}/git/commits`, { message, tree: String(newTree.sha), parents: [base] }, timeoutMs);
  if (existing) await request(cfg, token, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: String(commit.sha), force: true }, timeoutMs);
  else await request(cfg, token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: String(commit.sha) }, timeoutMs);
  return pushResult(cfg, repo, branch, commit, base, entries.length, !existing);
}

/** The web address of the repository's host, from a commit's html_url (GitHub Enterprise included). */
function webBase(cfg: GithubConfig, repo: string, htmlUrl: unknown): string {
  const u = String(htmlUrl ?? '');
  const at = u.indexOf(`/${repo}/commit/`);
  if (at > 0) return u.slice(0, at);
  const api = (cfg.api_url ?? 'https://api.github.com').replace(/\/$/, '');
  return api === 'https://api.github.com' ? 'https://github.com' : api.replace(/\/api\/v3$/, '');
}

function pushResult(cfg: GithubConfig, repo: string, branch: string, commit: any, base: string, files: number, created: boolean) {
  const web = webBase(cfg, repo, commit.html_url);
  return { repo, branch, commit_sha: String(commit.sha), base_sha: base, files, created, url: `${web}/${repo}/tree/${branch}`, commit_url: `${web}/${repo}/commit/${commit.sha}` };
}

/** Finds a push by its ledger action ID: the branch's current commit carries it as a trailer. */
export async function findPush(cfg: GithubConfig, args: { repo?: unknown; branch?: unknown; base_sha?: unknown; files?: unknown }, token: string | undefined, key: string, timeoutMs: number) {
  const repo = argRepo(cfg, args.repo);
  const branch = branchName(cfg, args.branch);
  const ref = await getOrNull(cfg, token, `/repos/${repo}/git/ref/heads/${branch}`, timeoutMs);
  if (!ref) return null;
  const head = await get(cfg, token, `/repos/${repo}/git/commits/${ref.object?.sha}`, timeoutMs);
  if (!String(head.message ?? '').includes(trailer(key))) return null;
  return pushResult(cfg, repo, branch, head, String(args.base_sha ?? ''), Array.isArray(args.files) ? args.files.length : 0, true);
}

async function openPullRequestFor(cfg: GithubConfig, token: string | undefined, repo: string, head: string, timeoutMs: number) {
  const owner = repo.split('/')[0]!;
  const open = await get(cfg, token, `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&per_page=10`, timeoutMs);
  const pr = (Array.isArray(open) ? open : []).find((p: any) => p.head?.ref === head);
  return pr ? { repo, number: Number(pr.number), url: String(pr.html_url ?? ''), head, base: String(pr.base?.ref ?? ''), draft: Boolean(pr.draft), created: false } : null;
}

/**
 * Opens a pull request from one of Azhi's branches (`github.create-pull-request`, write-dedupable). When
 * the branch already has an open pull request (a re-run moved the branch), that one is returned: it shows
 * the new commit already. `base` empty means the repository's default branch.
 */
export async function createPullRequest(cfg: GithubConfig, args: { repo?: unknown; head?: unknown; base?: unknown; title?: unknown; body?: unknown; draft?: unknown }, token: string | undefined, key: string, timeoutMs: number) {
  const repo = argRepo(cfg, args.repo);
  const head = branchName(cfg, args.head);
  const title = String(args.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 250);
  if (!title) throw new SendError('the pull request title is empty', true, ErrorClass.invalidInput);
  const already = await openPullRequestFor(cfg, token, repo, head, timeoutMs);
  if (already) return already;
  let base = String(args.base ?? '').trim();
  if (!base) base = String((await get(cfg, token, `/repos/${repo}`, timeoutMs)).default_branch ?? '');
  if (!/^(?!.*\.\.)(?!-)[A-Za-z0-9/_.-]{1,200}$/.test(base)) throw new SendError(`base must be a branch name, got '${base.slice(0, 100)}'`, true, ErrorClass.invalidInput);
  const body = `${String(args.body ?? '').slice(0, 60_000)}\n\n${marker(key)}`;
  const pr = await request(cfg, token, 'POST', `/repos/${repo}/pulls`, { title, head, base, body, draft: args.draft === true }, timeoutMs);
  return { repo, number: Number(pr.number), url: String(pr.html_url ?? ''), head, base, draft: Boolean(pr.draft), created: true };
}

export async function findPullRequest(cfg: GithubConfig, args: { repo?: unknown; head?: unknown }, token: string | undefined, _key: string, timeoutMs: number) {
  return openPullRequestFor(cfg, token, argRepo(cfg, args.repo), branchName(cfg, args.head), timeoutMs);
}


export type AccessStatus = 'ok' | 'unauthorized' | 'not_found' | 'sso' | 'forbidden' | 'insufficient' | 'error';
export interface RepoAccess {
  repo: string;
  ok: boolean;
  status: AccessStatus;
  /** What the check was for: reading the repository, or changing something in it (a comment, a push). */
  need: 'read' | 'write';
  token_kind: 'classic' | 'fine-grained' | 'unknown';
  /** A classic token's scopes, from GitHub; fine-grained tokens do not list theirs. */
  scopes?: string[];
  private?: boolean;
  permissions?: Record<string, boolean>;
  message: string;
  fix?: string;
  /** Something to double check when the token cannot be inspected further. */
  warning?: string;
}

const tokenKind = (token: string, scopes: string | null): RepoAccess['token_kind'] => (token.startsWith('github_pat_') ? 'fine-grained' : token.startsWith('ghp_') || scopes !== null ? 'classic' : 'unknown');

/**
 * Asks GitHub whether this token can use a repository for what a step needs, and says what to
 * change when it cannot: the token's resource owner and repository access (fine-grained), its
 * scopes (classic), SSO authorization, or the account's own role on the repository.
 */
export async function checkRepoAccess(cfg: GithubConfig, token: string | undefined, repo: string, need: 'read' | 'write', timeoutMs = 10_000): Promise<RepoAccess> {
  const base = { repo, need };
  if (!token) return { ...base, ok: false, status: 'unauthorized', token_kind: 'unknown', message: 'No token is set for this tool.', fix: 'Set the secret the tool uses, then check again.' };
  const api = (cfg.api_url ?? 'https://api.github.com').replace(/\/$/, '');
  let res: Response;
  try {
    const url = `${api}/repos/${repo}`;
    await checkEgress(url);
    res = await fetch(url, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'azhi-flow' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ...base, ok: false, status: 'error', token_kind: tokenKind(token, null), message: `Could not reach GitHub at ${api}: ${(err as Error).message}`, fix: 'Check the API address of the tool and that the server can reach it.' };
  }
  const header = res.headers.get('x-oauth-scopes');
  const scopes = header === null ? undefined : header.split(',').map((x) => x.trim()).filter(Boolean);
  const kind = tokenKind(token, header);
  const common = { ...base, token_kind: kind, ...(scopes ? { scopes } : {}) };
  if (res.status === 401) return { ...common, ok: false, status: 'unauthorized', message: 'GitHub does not accept this token. It is wrong, expired or revoked.', fix: 'Create a new token and save it as the tool\'s secret.' };
  if (res.status === 403) {
    const sso = res.headers.get('x-github-sso');
    if (sso) return { ...common, ok: false, status: 'sso', message: 'The organization requires SSO and this token is not authorized for it.', fix: `Authorize the token for the organization: ${sso.replace(/^required;\s*url=/, '')}` };
    const limited = res.headers.get('x-ratelimit-remaining') === '0';
    return { ...common, ok: false, status: 'forbidden', message: limited ? 'GitHub is rate limiting this token. Try again in a few minutes.' : 'GitHub refuses this token for the repository.', fix: limited ? undefined : 'Check the organization\'s token policy and that the token is approved.' };
  }
  if (res.status === 404) {
    return {
      ...common,
      ok: false,
      status: 'not_found',
      message: `GitHub cannot find ${repo} for this token. Either the name is wrong or the token cannot see the repository.`,
      fix: kind === 'classic' ? 'Check the spelling, then that the token has the "repo" scope (private repositories) and is SSO-authorized.' : 'Check the spelling, then that the token\'s resource owner is the organization and that "Only select repositories" includes this one.',
    };
  }
  if (!res.ok) return { ...common, ok: false, status: 'error', message: `GitHub answered HTTP ${res.status}.` };
  let body: { private?: boolean; permissions?: Record<string, boolean> } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ...common, ok: false, status: 'error', message: 'GitHub returned an answer that is not JSON. Check the API address.' };
  }
  const found = { ...common, ...(body.private !== undefined ? { private: body.private } : {}), ...(body.permissions ? { permissions: body.permissions } : {}) };
  if (need === 'write') {
    const p = body.permissions;
    if (p && !(p.push || p.maintain || p.admin || p.triage)) {
      return { ...found, ok: false, status: 'insufficient', message: 'The token can read this repository but not change it. Posting a comment needs write or triage access.', fix: kind === 'fine-grained' ? 'Grant the token "Pull requests: Read and write" (and "Contents: Read and write" to push) on this repository, and make sure your account has write or triage access to it.' : 'Use a token with the "repo" scope, from an account with write or triage access to the repository.' };
    }
    if (scopes && !scopes.includes('repo') && !(body.private === false && scopes.includes('public_repo'))) {
      return { ...found, ok: false, status: 'insufficient', message: `This token's scopes (${scopes.join(', ') || 'none'}) do not allow changes to ${body.private ? 'a private repository' : 'this repository'}.`, fix: body.private ? 'Add the "repo" scope.' : 'Add the "public_repo" or "repo" scope.' };
    }
    if (kind === 'fine-grained') return { ...found, ok: true, status: 'ok', message: `The token can see ${repo} and your account may change it.`, warning: 'GitHub does not list a fine-grained token\'s permissions. Make sure "Pull requests: Read and write" is granted for this repository.' };
    return { ...found, ok: true, status: 'ok', message: `The token can change ${repo}.` };
  }
  if (body.permissions && body.permissions.pull === false) return { ...found, ok: false, status: 'insufficient', message: 'The token cannot read this repository.', fix: 'Grant read access (Contents and Pull requests: Read).' };
  if (scopes && body.private && !scopes.includes('repo')) return { ...found, ok: false, status: 'insufficient', message: `This token's scopes (${scopes.join(', ') || 'none'}) do not include "repo", which a private repository needs.`, fix: 'Add the "repo" scope.' };
  return { ...found, ok: true, status: 'ok', message: `The token can read ${repo}.` };
}
