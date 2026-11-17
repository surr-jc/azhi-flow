import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { executorFor } from '../src/gateway/executors.js';
import { staticCatalog, type ToolSpec } from '../src/gateway/types.js';
import { loadExample } from '../src/api/examples.js';

/**
 * The PR conflict sweep example (examples/pr-conflict-sweep): it compiles against its own tool registration, the
 * lister keeps only conflicting same-repository pull requests, the fan-out is one parallel step, and the summary script fails closed on unreadable children.
 */
const PKG = 'examples/pr-conflict-sweep';

describe('pr-conflict-sweep example', () => {
  it('compiles with no error and is listed by the marketplace', () => {
    const pkg = packageFromDirectory(PKG);
    const tools = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools;
    const result = compile(loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!, { pkg, catalog: staticCatalog(tools) });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const e = loadExample('pr-conflict-sweep')!;
    expect(e.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['mode', 'one_pr', 'queue', 'targets', 'route', 'resolve_each', 'summary']));
    expect((e.config.tools ?? []).map((t) => t.id)).toEqual(['github.conflicted-prs', 'github.get-pull-request']);
  });

  const py = (script: string, input: unknown) => {
    const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', `${PKG}/scripts/${script}`], { input: JSON.stringify(input), encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  it('fans out with one parallel step over the list, not a loop written out per round', () => {
    const pkg = packageFromDirectory(PKG);
    const tools = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools;
    const plan = compile(loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!, { pkg, catalog: staticCatalog(tools) }).plan!;
    expect(plan.nodes.map((n) => n.id)).toEqual(['mode', 'one_pr', 'queue', 'targets', 'route', 'resolve_each', 'summary', 'summary_report']);
    const each = plan.nodes.find((n) => n.id === 'resolve_each')!;
    expect(each.type).toBe('parallel');
    expect(each.def).toMatchObject({ for_each: { ref: 'nodes.targets.output.items' }, max_concurrency: 1, node: { type: 'subworkflow', workflow: 'pr-conflict-resolver', on_failure: 'continue', input: { pr: { ref: 'item.number' } } } });
    // What the children return is untrusted, like any subworkflow's output.
    expect(plan.taint.untrusted.resolve_each).toMatch(/subworkflow/);
  });

  it('takes the one pull request named in pr, or sweeps the repository when none is named', () => {
    const pkg = packageFromDirectory(PKG);
    const wf = parse(pkg.readText(pkg.manifest.workflow)!);
    const node = (id: string) => wf.nodes.find((n: any) => n.id === id);
    expect(node('mode').routes).toEqual({ one: ['one_pr'], all: ['queue'] });
    expect(node('one_pr').arguments).toEqual({ repo: { ref: 'inputs.repo' }, number: { ref: 'inputs.pr' } });
    expect(wf.inputs.properties.pr).toMatchObject({ type: 'integer', minimum: 1 });
    expect(wf.inputs.required).toEqual(['repo']);
    // Both ways in meet in one merge step, and everything after reads that.
    expect(node('targets').merge).toBe('any');
    expect(JSON.stringify([node('route'), node('resolve_each'), node('summary')])).not.toContain('nodes.queue');
  });

  it('targets passes the listing through, and applies the listing rules to a named pull request', () => {
    const repo = 'acme/shop';
    const listed = { repo, items: [{ number: 3, title: 'T' }], unknown: [4], scanned: 5, skipped_forks: 1, truncated: true };
    expect(py('targets.py', { repo, pr: null, queue: listed, one: null })).toEqual({ items: [{ number: 3, title: 'T' }], unknown: [4], scanned: 5, skipped_forks: 1, truncated: true, skipped: [] });
    const one = (o: Record<string, unknown> = {}) => ({ repo, number: 7, title: 'Fix <b>it</b>', author: 'dev', state: 'open', draft: false, mergeable_state: 'dirty', url: 'https://github.com/acme/shop/pull/7', base_ref: 'main', head_ref: 'f7', head_sha: 's7', head_is_fork: false, ...o });
    const take = (o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => py('targets.py', { repo, pr: 7, queue: null, one: one(o), ...extra });
    expect(take().items).toEqual([{ number: 7, title: 'Fix b it /b', url: 'https://github.com/acme/shop/pull/7', author: 'dev', draft: false, base_ref: 'main', head_ref: 'f7', head_sha: 's7' }]);
    const why = (o: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const r = take(o, extra);
      expect(r.items).toEqual([]);
      return r.skipped;
    };
    expect(why({ state: 'closed' })).toEqual([{ number: 7, reason: 'not_open' }]);
    expect(why({ head_is_fork: true })).toEqual([{ number: 7, reason: 'fork' }]);
    expect(why({ draft: true })).toEqual([{ number: 7, reason: 'draft' }]);
    expect(take({ draft: true }, { include_drafts: true }).items).toHaveLength(1);
    expect(why({ mergeable_state: 'clean' })).toEqual([{ number: 7, reason: 'not_conflicting' }]);
    expect(why({ mergeable_state: 'unknown' })).toEqual([{ number: 7, reason: 'unknown' }]);
    expect(take({ mergeable_state: 'unknown' }).unknown).toEqual([7]);
    // Anything else is skipped, never resolved: another number, another repository, or an unreadable result.
    expect(why({ number: 8 })).toEqual([{ number: 7, reason: 'unreadable' }]);
    expect(why({ repo: 'evil/other' })).toEqual([{ number: 7, reason: 'unreadable' }]);
    expect(py('targets.py', { repo, pr: 7, queue: null, one: 'nope' }).skipped).toEqual([{ number: 7, reason: 'unreadable' }]);
    expect(py('targets.py', { repo: 'not a repo', pr: 7, queue: null, one: one() }).items).toEqual([]);
  });

  it('the summary says why a named pull request was not taken', () => {
    const s = py('summarize.py', { repo: 'acme/shop', items: [], children: [], skipped: [{ number: 7, reason: 'not_conflicting' }, { number: 9, reason: 'made up' }] });
    expect(s.headline).toBe('Pull request #7 was not resolved: GitHub does not report merge conflicts on it');
    expect(s.not_taken).toEqual([{ number: 7, reason: 'not_conflicting', explanation: 'GitHub does not report merge conflicts on it' }]);
    expect(s.total).toBe(0);
  });

  it('summarize reads each resolver child, fails closed, and never calls an untried one resolved', () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map((number) => ({ number, title: `T${number} <b>x</b>`, url: `https://github.com/acme/shop/pull/${number}`, author: 'a' }));
    const ok = (nodes: unknown) => ({ state: 'succeeded', nodes });
    const children = [
      ok({ open_pr: { repo: 'acme/shop', number: 40, draft: true } }),
      ok({ open_pr: { output: { repo: 'acme/shop', number: 41 } } }),
      ok({ give_up: {} }),
      ok({ skip_report: {} }),
      { state: 'failed', nodes: {} },
      ok({ open_pr: { repo: 'evil/other', number: 42 } }),
      // The seventh pull request has no child: the fan-out ended before it.
    ];
    const s = py('summarize.py', { repo: 'acme/shop', dry_run: false, items, unknown: [9], truncated: true, children });
    expect(s.prs.map((p: any) => p.status)).toEqual(['resolved', 'resolved', 'needs_manual', 'skipped', 'failed', 'unknown', 'not_tried']);
    expect(s.counts).toEqual({ resolved: 2, needs_manual: 1, skipped: 1, failed: 1, unknown: 1, not_tried: 1 });
    expect(s.headline).toBe('2 of 7 conflicting pull request(s) resolved');
    expect(s.prs[0]).toMatchObject({ title: 'T1 b x /b', resolution_url: 'https://github.com/acme/shop/pull/40', draft: true, reason: 'ok' });
    expect(s.prs[5]).toMatchObject({ resolution_url: '', reason: 'unreadable' });
    expect(s.unknown).toEqual([9]);
    expect(py('summarize.py', { repo: 'acme/shop', items: items.slice(0, 1), children: ['nope'] }).prs[0].status).toBe('unknown');
    expect(py('summarize.py', { repo: 'acme/shop', dry_run: true, items, children: [] }).headline).toContain('dry run');
    expect(py('summarize.py', { repo: 'acme/shop', items: [], children: [] }).headline).toBe('No conflicting pull request found');
  });

  describe('github.conflicted-prs', () => {
    let server: Server;
    let url = '';
    const pr = (number: number, o: Record<string, unknown> = {}) => ({ number, title: `PR ${number}`, html_url: `https://github.com/acme/shop/pull/${number}`, draft: false, user: { login: 'dev' }, base: { ref: 'main', repo: { full_name: 'acme/shop' } }, head: { ref: `f${number}`, sha: `s${number}`, repo: { full_name: 'acme/shop' } }, ...o });
    const state: Record<number, string | null> = { 1: 'dirty', 2: 'clean', 3: 'dirty', 4: 'dirty', 5: null, 6: 'dirty', 7: 'dirty' };
    const list = [
      pr(1),
      pr(2),
      pr(3, { draft: true }),
      pr(4, { head: { ref: 'f4', sha: 's4', repo: { full_name: 'someone/shop' } } }),
      pr(5),
      pr(6, { head: { ref: 'azhi/resolve-6', sha: 's6', repo: { full_name: 'acme/shop' } } }),
      pr(7, { user: { login: 'other' } }),
    ];
    beforeAll(async () => {
      process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
      server = createServer((req, res) => {
        const u = new URL(req.url!, 'http://x');
        const one = u.pathname.match(/\/pulls\/(\d+)$/);
        res.setHeader('content-type', 'application/json');
        if (one) {
          const n = Number(one[1]);
          const mergeable_state = state[n] ?? 'unknown';
          return res.end(JSON.stringify({ ...list.find((p) => p.number === n), mergeable: state[n] === null ? null : state[n] !== 'dirty', mergeable_state }));
        }
        res.end(JSON.stringify(u.searchParams.get('page') && u.searchParams.get('page') !== '1' ? [] : list));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      delete process.env.AZHI_EGRESS_ALLOW;
      await new Promise((r) => server.close(r));
    });
    const call = (args: Record<string, unknown>) => {
      const spec = { id: 'github.conflicted-prs', version: 1, description: 'x', effect: 'read', source: 'github', transport: { kind: 'builtin', name: 'github.conflicted-prs', config: { repos: ['acme/shop'], api_url: url } }, input_schema: { type: 'object' }, output_schema: { type: 'object' } } as ToolSpec;
      return executorFor(spec).call(spec, args, { credential: 'ghp_x', timeoutMs: 8000 });
    };

    it('keeps conflicting same-repository pull requests, skips forks, drafts and its own branches, and names unknown ones', async () => {
      const r = (await call({ repo: 'acme/shop' })).value as any;
      expect(r.items.map((i: any) => i.number)).toEqual([1, 7]);
      expect(r.unknown).toEqual([5]);
      expect(r.skipped_forks).toBe(1);
      expect(r.truncated).toBe(false);
    });

    it('filters by author, includes drafts on request and stops at the limit', async () => {
      expect(((await call({ repo: 'acme/shop', author: 'other' })).value as any).items.map((i: any) => i.number)).toEqual([7]);
      expect(((await call({ repo: 'acme/shop', include_drafts: true })).value as any).items.map((i: any) => i.number)).toEqual([1, 3, 7]);
      const one = (await call({ repo: 'acme/shop', limit: 1 })).value as any;
      expect(one.items.map((i: any) => i.number)).toEqual([1]);
      expect(one.truncated).toBe(true);
    });

    it('refuses another repository and a bad limit', async () => {
      await expect(call({ repo: 'evil/other' })).rejects.toThrow(/not one of the repositories/);
      await expect(call({ repo: 'acme/shop', limit: 99 })).rejects.toThrow(/1 to 20/);
    });
  });
});
