import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commentOnPullRequest, fallbackFor, reviewComments, type FailureKind, type GithubConfig } from '../src/gateway/tools/github.js';
import { ErrorClass } from '../src/lib/errors.js';
import { GhApiError, ghApi, parseGhApiOutput, setGhRunnerForTests, type GhRunOptions } from '../src/server/gh-cli.js';

/**
 * The GitHub tools call the REST API first and `gh api` second (cli_fallback). The rules that matter: a write is
 * never sent twice (only a failure that sent nothing, or a rejected token, may be retried), a blocked host stays
 * blocked, a definite answer is final, and gh never inherits a token variable it was not given on purpose.
 */
const CFG = (extra: Partial<GithubConfig> = {}): GithubConfig => ({ repos: ['acme/shop'], api_url: 'https://api.github.com', ...extra });
const ok = (stdout = '[]') => ({ stdout: `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${stdout}`, stderr: '' });

let fetchMock: ReturnType<typeof vi.spyOn>;
let ghCalls: Array<{ args: string[]; opts: GhRunOptions }>;

const netFail = (code: string) => fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code } }));
const answer = (status: number, headers: Record<string, string> = {}, body = '{"message":"no"}') => fetchMock.mockImplementation(async () => new Response(body, { status, headers }));
const gh = (reply: { stdout: string; stderr: string } = ok()) =>
  setGhRunnerForTests(async (args, _t, opts = {}) => {
    ghCalls.push({ args, opts });
    return reply;
  });

beforeEach(() => {
  process.env.AZHI_EGRESS_ALLOW = 'api.github.com';
  delete process.env.AZHI_GH_FALLBACK;
  fetchMock = vi.spyOn(globalThis, 'fetch');
  ghCalls = [];
  gh();
});
afterEach(() => {
  fetchMock.mockRestore();
  setGhRunnerForTests();
  delete process.env.AZHI_EGRESS_ALLOW;
  delete process.env.AZHI_GH_FALLBACK;
  delete process.env.GH_TOKEN;
});

// `null` means no token (a default parameter would turn `undefined` back into one).
const get = (cfg: GithubConfig, token: string | null = 'ghp_api') => reviewComments(cfg, { repo: 'acme/shop', number: 1 }, token ?? undefined, 2000);
const post = (cfg: GithubConfig, token: string | null = 'ghp_api') => commentOnPullRequest(cfg, { repo: 'acme/shop', number: 1, body: 'hello' }, token ?? undefined, 'act_1', 2000);

describe('which failures the GitHub CLI may retry', () => {
  const cases: Array<[string, FailureKind, 'off' | 'network' | 'login', boolean]> = [
    ['GET', 'connect', 'off', false],
    ['GET', 'connect', 'network', true],
    ['POST', 'connect', 'network', true],
    ['POST', 'tls', 'network', true],
    ['GET', 'reset', 'network', true],
    ['POST', 'reset', 'login', false],
    ['PATCH', 'reset', 'login', false],
    ['GET', 'timeout', 'login', false],
    ['POST', 'timeout', 'login', false],
    ['GET', 'auth', 'network', false],
    ['POST', 'auth', 'login', true],
    ['GET', 'no-token', 'login', true],
    ['GET', 'no-token', 'network', false],
    ['GET', 'http', 'login', false],
    ['POST', 'http', 'login', false],
  ];
  it.each(cases)('%s after %s with cli_fallback %s: %s', (method, kind, mode, expected) => {
    expect(fallbackFor(method, kind, mode)).toBe(expected);
  });
});

describe('request() with the CLI fallback', () => {
  it('does not use gh at all by default', async () => {
    netFail('ECONNREFUSED');
    await expect(get(CFG())).rejects.toThrow(/GitHub request failed: fetch failed$/);
    expect(ghCalls).toHaveLength(0);
  });

  it('retries a read through gh after a certificate failure, with the same token and nothing from the host environment', async () => {
    process.env.GH_TOKEN = 'ghp_host_leak';
    netFail('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    expect(await get(CFG({ cli_fallback: 'network' }))).toEqual({ comments: [] });
    expect(ghCalls).toHaveLength(1);
    const { args, opts } = ghCalls[0]!;
    expect(args.slice(0, 5)).toEqual(['api', '--method', 'GET', '--hostname', 'github.com']);
    expect(args.at(-1)).toBe('repos/acme/shop/pulls/1/comments?per_page=100&page=1');
    expect(args).not.toContain('--input');
    expect(opts.env?.GH_TOKEN).toBe('ghp_api');
    expect(opts.env?.GITHUB_TOKEN).toBeUndefined();
    expect(opts.cwd).toMatch(/azhi-gh-/);
  });

  it('retries a write after a refused connection and sends the body on stdin, not on the command line', async () => {
    netFail('ECONNREFUSED');
    gh({ stdout: 'HTTP/2.0 201 Created\r\n\r\n{"id":7,"html_url":"https://github.com/acme/shop/pull/1#c7"}', stderr: '' });
    expect(await post(CFG({ cli_fallback: 'network' }))).toMatchObject({ id: 7, updated: false });
    const { args, opts } = ghCalls[0]!;
    expect(args).toContain('--input');
    expect(args.join(' ')).not.toContain('hello');
    expect(JSON.parse(opts.input!).body).toContain('hello');
  });

  it('never resends a write whose connection broke after it may have been sent', async () => {
    netFail('ECONNRESET');
    const err = (await post(CFG({ cli_fallback: 'login' })).catch((e) => e)) as { message: string; definite: boolean };
    expect(err.message).toMatch(/GitHub request failed/);
    expect(err.definite).toBe(false);
    expect(ghCalls).toHaveLength(0);
  });

  it('does not retry a timeout, a 404, a rate limit or a server error', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(get(CFG({ cli_fallback: 'login' }))).rejects.toThrow(/GitHub request failed/);
    for (const [status, headers] of [[404, {}], [429, {}], [403, { 'x-ratelimit-remaining': '0' }], [502, {}]] as const) {
      answer(status, headers);
      await expect(get(CFG({ cli_fallback: 'login' }))).rejects.toThrow(new RegExp(`GitHub HTTP ${status}`));
    }
    expect(ghCalls).toHaveLength(0);
  });

  it('after a 401 uses the gh login (no token handed over) only in login mode', async () => {
    process.env.GH_TOKEN = 'ghp_host_leak';
    answer(401);
    await expect(get(CFG({ cli_fallback: 'network' }))).rejects.toMatchObject({ errorClass: ErrorClass.authorization });
    expect(ghCalls).toHaveLength(0);
    expect(await get(CFG({ cli_fallback: 'login' }))).toEqual({ comments: [] });
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]!.opts.env?.GH_TOKEN).toBeUndefined();
    expect(ghCalls[0]!.opts.env?.GH_ENTERPRISE_TOKEN).toBeUndefined();
  });

  it('retries after an SSO 403 but not after a plain 403', async () => {
    answer(403, { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' });
    await get(CFG({ cli_fallback: 'login' }));
    expect(ghCalls).toHaveLength(1);
    answer(403);
    await expect(get(CFG({ cli_fallback: 'login' }))).rejects.toThrow(/GitHub HTTP 403/);
    expect(ghCalls).toHaveLength(1);
  });

  it('answers with gh when there is no token in login mode, and asks for one otherwise', async () => {
    expect(await get(CFG({ cli_fallback: 'login' }), null)).toEqual({ comments: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(get(CFG({ cli_fallback: 'network' }), null)).rejects.toThrow(/need a token credential/);
  });

  it('keeps the original error and says why when gh cannot help', async () => {
    netFail('ENOTFOUND');
    setGhRunnerForTests(async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    });
    await expect(get(CFG({ cli_fallback: 'network' }))).rejects.toThrow(/GitHub request failed: fetch failed \(gh fallback unavailable: the GitHub CLI \(gh\) was not found/);
    answer(401);
    await expect(get(CFG({ cli_fallback: 'login' }))).rejects.toThrow(/GitHub HTTP 401.*gh fallback unavailable/);
  });

  it('reports the status gh got when it exits non-zero with an HTTP answer', async () => {
    answer(401);
    setGhRunnerForTests(async () => {
      throw Object.assign(new Error('exit 1'), { stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)' });
    });
    await expect(get(CFG({ cli_fallback: 'login' }))).rejects.toThrow(/GitHub HTTP 404/);
  });

  it('never reaches a host the egress rules block, through fetch or through gh', async () => {
    process.env.AZHI_EGRESS_ALLOW = '';
    await expect(get(CFG({ api_url: 'http://10.0.0.5', cli_fallback: 'login' }))).rejects.toThrow(/egress to private address/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ghCalls).toHaveLength(0);
  });

  it('is switched off by AZHI_GH_FALLBACK=off, and refuses an unknown mode', async () => {
    process.env.AZHI_GH_FALLBACK = 'off';
    netFail('ECONNREFUSED');
    await expect(get(CFG({ cli_fallback: 'login' }))).rejects.toThrow(/GitHub request failed/);
    expect(ghCalls).toHaveLength(0);
    delete process.env.AZHI_GH_FALLBACK;
    await expect(get(CFG({ cli_fallback: 'always' as never }))).rejects.toThrow(/cli_fallback must be off, network or login/);
  });

  it('names an Enterprise host for gh and uses the Enterprise token variable', async () => {
    process.env.AZHI_EGRESS_ALLOW = 'git.example.com';
    netFail('ECONNREFUSED');
    await get(CFG({ api_url: 'https://git.example.com/api/v3', cli_fallback: 'network' }));
    expect(ghCalls[0]!.args.slice(3, 5)).toEqual(['--hostname', 'git.example.com']);
    expect(ghCalls[0]!.opts.env?.GH_ENTERPRISE_TOKEN).toBe('ghp_api');
    expect(ghCalls[0]!.opts.env?.GH_TOKEN).toBeUndefined();
  });
});

describe('ghApi', () => {
  it('refuses a path gh would fill from a repository or that is not a plain path', async () => {
    for (const path of ['/repos/{owner}/{repo}/pulls', 'repos/a/b', '/repos/a/b pulls']) {
      await expect(ghApi({ host: 'github.com', method: 'GET', path, timeoutMs: 1000 })).rejects.toBeInstanceOf(GhApiError);
    }
    expect(ghCalls).toHaveLength(0);
  });

  it('reads the status, headers and body of gh --include output', () => {
    const r = parseGhApiOutput('HTTP/2.0 403 Forbidden\r\nX-GitHub-SSO: required; url=https://x\r\nContent-Type: application/json\r\n\r\n{"message":"sso"}')!;
    expect(r.status).toBe(403);
    expect(r.header('x-github-sso')).toBe('required; url=https://x');
    expect(r.text).toBe('{"message":"sso"}');
    expect(parseGhApiOutput('gh: To get started with GitHub CLI, please run: gh auth login')).toBeUndefined();
  });

  it('says gh gave no answer, without the token, when it fails before any HTTP reply', async () => {
    setGhRunnerForTests(async () => {
      throw Object.assign(new Error('x'), { stdout: '', stderr: 'dial tcp: lookup api.github.com ghp_secret1: no such host' });
    });
    const err = await ghApi({ host: 'github.com', method: 'GET', path: '/user', token: 'ghp_secret1', timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(GhApiError);
    expect(err.message).toContain('no such host');
    expect(err.message).not.toContain('ghp_secret1');
  });
});
