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
 * lister keeps only conflicting same-repository pull requests, and the two scripts fail closed on unreadable children.
 */
const PKG = 'examples/pr-conflict-sweep';

describe('pr-conflict-sweep example', () => {
  it('compiles with no error and is listed by the marketplace', () => {
    const pkg = packageFromDirectory(PKG);
    const tools = parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools;
    const result = compile(loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!, { pkg, catalog: staticCatalog(tools) });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const e = loadExample('pr-conflict-sweep')!;
    expect(e.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['queue', 'route', 'resolve_each', 'summary']));
    expect((e.config.tools ?? []).map((t) => t.id)).toEqual(['github.conflicted-prs']);
  });

  const py = (script: string, input: unknown) => {
    const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', `${PKG}/scripts/${script}`], { input: JSON.stringify(input), encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  it('round_outcome reads the resolver child and fails closed', () => {
    const base = { repo: 'acme/shop', number: 7, last: false };
    const child = (nodes: unknown, state = 'succeeded') => ({ ...base, child: { state, nodes } });
    expect(py('round_outcome.py', child({ open_pr: { repo: 'acme/shop', number: 31, draft: true } }))).toMatchObject({ status: 'resolved', url: 'https://github.com/acme/shop/pull/31', draft: true, last: false });
    expect(py('round_outcome.py', child({ open_pr: { output: { repo: 'acme/shop', number: 31 } } }))).toMatchObject({ status: 'resolved' });
    expect(py('round_outcome.py', child({ give_up: {} }))).toMatchObject({ status: 'needs_manual' });
    expect(py('round_outcome.py', child({ skip_report: {} }))).toMatchObject({ status: 'skipped' });
    expect(py('round_outcome.py', child({}, 'failed'))).toMatchObject({ status: 'failed' });
    expect(py('round_outcome.py', child({ open_pr: { repo: 'evil/other', number: 31 } }))).toMatchObject({ status: 'unknown' });
    expect(py('round_outcome.py', { ...base, child: 'nope' })).toMatchObject({ status: 'unknown', last: false });
    // Unknown whether another follows: the loop ends.
    expect(py('round_outcome.py', { repo: 'acme/shop', number: 7, child: null }).last).toBe(true);
  });

  it('summarize counts every pull request and never calls an untried one resolved', () => {
    const items = [1, 2, 3].map((number) => ({ number, title: `T${number} <b>x</b>`, url: `https://github.com/acme/shop/pull/${number}`, author: 'a' }));
    const s = py('summarize.py', { repo: 'acme/shop', dry_run: false, items, unknown: [9], truncated: true, rounds: [{ number: 1, status: 'resolved', reason: 'ok', url: 'https://github.com/acme/shop/pull/40' }, { number: 2, status: 'failed', reason: 'not_completed' }] });
    expect(s.counts).toMatchObject({ resolved: 1, failed: 1, not_tried: 1 });
    expect(s.headline).toBe('1 of 3 conflicting pull request(s) resolved');
    expect(s.prs[0]).toMatchObject({ title: 'T1 b x /b', resolution_url: 'https://github.com/acme/shop/pull/40' });
    expect(s.prs[2].status).toBe('not_tried');
    expect(s.unknown).toEqual([9]);
    expect(py('summarize.py', { repo: 'acme/shop', dry_run: true, items, rounds: [] }).headline).toContain('dry run');
    expect(py('summarize.py', { repo: 'acme/shop', items: [], rounds: [] }).headline).toBe('No conflicting pull request found');
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
