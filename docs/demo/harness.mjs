// Serves the built web app (src/web/dist) and answers /v1 with the sample data in mock.mjs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from './mock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'src/web/dist');
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

export function serve(port) {
  const srv = http.createServer((q, r) => {
    const f = q.url.split('?')[0].replace(/^\/ui\/?/, '');
    let p = path.join(dist, f || 'index.html');
    if (!p.startsWith(dist) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dist, 'index.html');
    r.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
    r.end(fs.readFileSync(p));
  });
  return new Promise((res) => srv.listen(port, () => res(srv)));
}

const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

/** Routes every /v1 call to sample data. `state` lets the script change answers (for example a decided approval). */
export async function mockApi(context, state = { approved: false }) {
  await context.addInitScript(() => sessionStorage.setItem('azhi-token', 'demo'));
  await context.route('**/v1/**', async (rt) => {
    const req = rt.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const body = () => { try { return JSON.parse(req.postData() ?? '{}'); } catch { return {}; } };
    if (p === '/v1/me') return rt.fulfill(json({ kind: 'user', workspaceId: 'acme', userId: 'suresh', role: 'owner' }));
    if (p === '/v1/overview') return rt.fulfill(json({ ...M.overview, approvals: { pending: state.approved ? 0 : 1, mine: state.approved ? 0 : 1 } }));
    if (p === '/v1/alerts') return rt.fulfill(json(M.alerts));
    if (p === '/v1/alerts/history') return rt.fulfill(json([]));
    if (p === '/v1/approvals') return rt.fulfill(json(state.approved ? [] : M.approvals));
    if (/\/runs\/[^/]+\/approvals$/.test(p) && req.method() === 'POST') { state.approved = true; return rt.fulfill(json({ ok: true })); }
    if (p === '/v1/runs') {
      const st = u.searchParams.get('state')?.split(',');
      const wf = u.searchParams.get('workflow');
      let rows = M.runs;
      if (st) rows = rows.filter((x) => st.includes(x.state));
      if (wf) rows = rows.filter((x) => x.workflow === wf);
      if (state.approved) rows = rows.map((x) => (x.id === 'run_71ab09d2' ? { ...x, state: 'running' } : x));
      return rt.fulfill(json(rows.slice(0, Number(u.searchParams.get('limit') ?? 50))));
    }
    if (p === '/v1/runs/run_8f21c4e7' || p === '/v1/runs/run_5d03ee19') return rt.fulfill(json({ ...M.runDetail, run: { ...M.runDetail.run, id: p.split('/').pop() } }));
    if (/\/v1\/runs\/[^/]+\/events$/.test(p)) return rt.fulfill({ status: 200, contentType: 'text/event-stream', body: M.events.map((e) => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`).join('') });
    if (/\/v1\/runs\/[^/]+\/transcript/.test(p)) return rt.fulfill(json({ enabled: false, entries: [], cursor: 0 }));
    if (p === '/v1/workflows/summary') return rt.fulfill(json(M.summaries));
    if (/\/v1\/workflows\/[^/]+\/versions$/.test(p)) { const s = M.summaries.find((x) => p.includes(`/${x.slug}/`)) ?? M.summaries[0]; return rt.fulfill(json([{ id: s.latest.id, version: s.latest.version, draft: false, signed: true, created_at: s.latest.created_at, name: s.latest.name }])); }
    if (/\/v1\/versions\/[^/]+$/.test(p)) return rt.fulfill(json({ id: 'ver_pr4', version: 4, draft: false, definition: M.baseDefinition, plan: { nodes: M.planNodes, inputsSchema: M.baseDefinition.inputs } }));
    if (/\/v1\/versions\/[^/]+\/plan$/.test(p)) return rt.fulfill(json(M.planFor()));
    if (/\/v1\/versions\/[^/]+\/source$/.test(p)) return rt.fulfill(json({ workflow: 'workflow.yaml', files: [{ path: 'schemas/findings.json', size: 10, text: '{}' }, { path: 'profiles/correctness-reviewer@1.yaml', size: 10, text: 'name: correctness-reviewer\n' }] }));
    if (/\/v1\/versions\/[^/]+\/check$/.test(p)) return rt.fulfill(json(M.check(body())));
    if (p === '/v1/tools') return rt.fulfill(json(M.tools));
    if (p === '/v1/executors') return rt.fulfill(json({ executors: [] }));
    if (p === '/v1/usage/summary') return rt.fulfill(json(M.usage));
    if (p === '/v1/budgets') return rt.fulfill(json(M.budgets));
    if (p === '/v1/schedules/summary') return rt.fulfill(json(M.overview.schedules));
    if (p === '/v1/examples') return rt.fulfill(json([]));
    if (p === '/v1/copilot/quota') return rt.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return rt.fulfill(json([]));
  });
  return state;
}
