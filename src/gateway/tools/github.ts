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
  if (!token) throw new SendError('the GitHub tools need a token credential', true, ErrorClass.authorization);
  const url = `${(cfg.api_url ?? 'https://api.github.com').replace(/\/$/, '')}${path}`;
  await checkEgress(url);
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'azhi-flow' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new SendError(`GitHub request failed: ${(err as Error).message}`, false);
  }
  const text = await res.text();
  if (!res.ok) {
    const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
    const definite = res.status >= 400 && res.status < 500 && res.status !== 408 && !limited;
    const cls = res.status === 401 || (res.status === 403 && !limited) ? ErrorClass.authorization : definite ? ErrorClass.invalidInput : ErrorClass.transient;
    throw new SendError(`GitHub HTTP ${res.status}: ${text.slice(0, 200)}`, definite, cls);
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
