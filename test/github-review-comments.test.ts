import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executorFor } from '../src/gateway/executors.js';
import type { ToolSpec } from '../src/gateway/types.js';

/** `github.review-comments` calls the plain /repos/owner/name path (not %2F) and maps GitHub's fields to the declared shape. */
describe('github.review-comments', () => {
  let server: Server;
  const paths: string[] = [];
  const spec = (url: string): ToolSpec =>
    ({ id: 'github.review-comments', version: 1, effect: 'read', source: 'github', transport: { kind: 'builtin', name: 'github.review-comments', config: { repos: ['acme/shop'], api_url: url } }, input_schema: { type: 'object' }, output_schema: { type: 'object' } }) as unknown as ToolSpec;

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: 7, body: 'nit', path: 'a.ts', line: null, original_line: 12, user: { login: 'copilot', type: 'Bot' }, created_at: '2026-01-01T00:00:00Z' }]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    delete process.env.AZHI_EGRESS_ALLOW;
    await new Promise((r) => server.close(r));
  });

  it('lists comments in the declared shape and enforces the allowlist', async () => {
    const s = spec(`http://127.0.0.1:${(server.address() as any).port}`);
    const call = (repo: string) => executorFor(s).call(s, { repo, number: 714 }, { credential: 'ghp_read_only_7', timeoutMs: 5000 });
    const out = (await call('acme/shop')).value as any;
    expect(paths[0]).toMatch(/^\/repos\/acme\/shop\/pulls\/714\/comments\?/);
    expect(out.comments).toEqual([{ id: 7, body: 'nit', path: 'a.ts', line: 12, author: 'copilot', author_is_bot: true, created_at: '2026-01-01T00:00:00Z', in_reply_to_id: null }]);
    await expect(call('other/repo')).rejects.toThrow(/not one of the repositories/);
  });
});
