// The read-only run page (implementation plan, Phase 3). No framework and no build step: it reads
// the same API the CLI uses, with the token kept in this tab's sessionStorage, and follows a run
// through the SSE event stream, resuming from the last event ID after a disconnect.

const TERMINAL = ['succeeded', 'delivery_failed', 'failed', 'cancelled', 'expired'];
const app = document.getElementById('app');
const live = document.getElementById('live');

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k !== undefined && k !== null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const badge = (text, cls) => el('span', { class: `badge ${cls ?? ''}` }, text);
const when = (t) => (t ? new Date(t).toLocaleString() : '—');
const num = (n) => (n === null || n === undefined ? 'unknown' : Number(n).toLocaleString());
const table = (head, rows) => el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows));
const empty = (text) => el('p', { class: 'muted' }, text);

// ---- token -------------------------------------------------------------------------------------

function token() {
  const m = location.hash.match(/token=([^&]+)/);
  if (m) {
    try { sessionStorage.setItem('azhi-token', decodeURIComponent(m[1])); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    return decodeURIComponent(m[1]);
  }
  try { return sessionStorage.getItem('azhi-token'); } catch { return null; }
}

function askToken(message) {
  const input = el('input', { type: 'password', placeholder: 'API token', autocomplete: 'off', 'aria-label': 'API token' });
  app.replaceChildren(
    el('h1', {}, 'Sign in'),
    el('p', { class: 'muted' }, message ?? 'Paste an API token. `azhi open <run>` prints a link that carries it for you.'),
    el('form', { class: 'token', onsubmit: (e) => { e.preventDefault(); try { sessionStorage.setItem('azhi-token', input.value.trim()); } catch {} route(); } }, input, el('button', { type: 'submit' }, 'Open')),
  );
}

async function api(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token()}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

// ---- runs list ---------------------------------------------------------------------------------

async function runsPage() {
  live.textContent = '';
  const runs = await api('/v1/runs?limit=50');
  app.replaceChildren(
    el('h1', {}, 'Runs'),
    el('div', { class: 'panel' }, runs.length
      ? table(['Run', 'Workflow', 'State', 'Trigger', 'Created'], runs.map((r) => el('tr', {},
          el('td', {}, el('a', { href: `/ui/runs/${r.id}`, class: 'mono' }, r.id)),
          el('td', {}, `${r.workflow}@${r.version}`),
          el('td', {}, badge(r.state, `s-${r.state}`)),
          el('td', {}, r.trigger),
          el('td', {}, when(r.created_at)))))
      : empty('No runs yet.')),
  );
}

// ---- run page ----------------------------------------------------------------------------------

const view = { detail: null, version: null, events: [], cursor: 0, tab: 'timeline', refresh: null, stream: null };

async function runPage(id) {
  view.events = []; view.cursor = 0;
  view.detail = await api(`/v1/runs/${encodeURIComponent(id)}`);
  view.version = await api(`/v1/versions/${encodeURIComponent(view.detail.run.workflow_version_id)}`).catch(() => null);
  render();
  follow(id);
}

function scheduleRefresh(id) {
  clearTimeout(view.refresh);
  view.refresh = setTimeout(async () => {
    try { view.detail = await api(`/v1/runs/${encodeURIComponent(id)}`); render(); } catch {}
  }, 250);
}

/** Follows the event stream, resuming from the last seen event after any disconnect. */
async function follow(id) {
  const mine = {};
  view.stream = mine;
  let backoff = 500;
  while (view.stream === mine) {
    live.textContent = view.cursor ? 'live' : 'connecting';
    try {
      const res = await fetch(`/v1/runs/${encodeURIComponent(id)}/events`, { headers: { authorization: `Bearer ${token()}`, accept: 'text/event-stream', 'last-event-id': String(view.cursor) } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      backoff = 500;
      live.textContent = 'live';
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done || view.stream !== mine) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          const ev = JSON.parse(data);
          if (ev.seq <= view.cursor) continue;
          view.cursor = ev.seq;
          view.events.push(ev);
          scheduleRefresh(id);
        }
      }
    } catch {
      live.textContent = 'reconnecting';
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 8000);
      continue;
    }
    // The server closes the stream once the run has ended and every event has been sent.
    const d = await api(`/v1/runs/${encodeURIComponent(id)}`).catch(() => null);
    if (d) { view.detail = d; render(); }
    if (d && TERMINAL.includes(d.run.state)) { live.textContent = 'finished'; return; }
    await new Promise((r) => setTimeout(r, backoff));
  }
}

function nodeStates(d) {
  const s = {};
  for (const a of d.attempts) s[a.node_id] = { state: a.state, attempts: (s[a.node_id]?.attempts ?? 0) + 1 };
  for (const a of d.approvals) if (a.decision === null && s[a.node_id]?.state !== 'succeeded') s[a.node_id] = { state: 'waiting', attempts: s[a.node_id]?.attempts ?? 0 };
  return s;
}

function render() {
  const d = view.detail;
  const r = d.run;
  const flags = Object.entries(r.flags ?? {}).filter(([, v]) => v);
  app.replaceChildren(...[
    el('h1', {}, `${r.workflow}@${r.workflow_version}`),
    el('div', {}, el('span', { class: 'mono muted' }, r.id), ' ', badge(r.state, `s-${r.state}`), r.test ? badge('test run', 's-waiting') : null),
    flags.length ? el('div', { class: 'flags' }, flags.map(([k, v]) => badge(k === 'waiting_reason' ? `waiting for ${v.reason}${v.node ? ` on ${v.node}` : ''}` : k.replaceAll('_', ' '), 's-waiting'))) : null,
    el('div', { class: 'meta' },
      el('div', {}, el('span', {}, 'Trigger'), r.trigger),
      el('div', {}, el('span', {}, 'Created'), when(r.created_at)),
      el('div', {}, el('span', {}, 'Ended'), when(r.ended_at)),
      el('div', {}, el('span', {}, 'Usage'), usageLine(d.usage)),
      el('div', {}, el('span', {}, 'Package'), el('span', { class: 'mono' }, (r.snapshot?.package_hash ?? '').slice(0, 19))),
    ),
    r.error ? el('div', { class: 'error' }, el('strong', {}, r.error.class), ': ', r.error.message) : null,
    el('h2', {}, 'Graph'),
    el('div', { class: 'panel' }, graph(d)),
    tabs(),
  ].filter(Boolean));
}

function usageLine(u) {
  if (!u.turns) return 'no model turns';
  const cost = u.cost.amount === null ? 'cost unavailable' : `${u.cost.currency} ${u.cost.amount.toFixed(4)} estimated`;
  return `${u.completeness_pct}% complete · ${cost}`;
}

function graph(d) {
  const nodes = view.version?.plan?.nodes;
  if (!nodes) return empty('The workflow version could not be loaded.');
  const depth = {};
  for (const n of nodes) depth[n.id] = n.deps.length ? Math.max(...n.deps.map((x) => depth[x] ?? 0)) + 1 : 0;
  const cols = {};
  const pos = {};
  const W = 150, H = 46, GX = 50, GY = 18;
  for (const n of nodes) {
    const c = depth[n.id];
    const row = (cols[c] = (cols[c] ?? 0) + 1) - 1;
    pos[n.id] = { x: 10 + c * (W + GX), y: 10 + row * (H + GY) };
  }
  const width = 20 + (Math.max(...Object.values(depth)) + 1) * (W + GX) - GX;
  const height = 20 + Math.max(...Object.values(cols)) * (H + GY) - GY;
  const states = nodeStates(d);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'workflow graph' });
  for (const n of nodes) for (const dep of n.deps) {
    const a = pos[dep], b = pos[n.id];
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    root.append(svg('path', { class: 'edge', d: `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}` }));
  }
  for (const n of nodes) {
    const st = states[n.id]?.state ?? 'pending';
    const tries = states[n.id]?.attempts ?? 0;
    const g = svg('g', { class: `node st-${st}`, transform: `translate(${pos[n.id].x},${pos[n.id].y})` });
    g.append(svg('title', {}, `${n.id} (${n.type}): ${st}${tries > 1 ? `, ${tries} attempts` : ''}`));
    g.append(svg('rect', { width: W, height: H, rx: 6 }));
    g.append(svg('text', { x: 10, y: 19 }, n.id.length > 20 ? n.id.slice(0, 19) + '…' : n.id));
    g.append(svg('text', { x: 10, y: 35, class: 'sub' }, `${n.type} · ${st}${tries > 1 ? ` ×${tries}` : ''}`));
    root.append(g);
  }
  return root;
}

const TABS = {
  timeline: ['Timeline', timelineTab],
  ledger: ['Action ledger', ledgerTab],
  coverage: ['Policy coverage', coverageTab],
  context: ['Context manifest', contextTab],
  usage: ['Usage', usageTab],
};

function tabs() {
  const bar = el('div', { class: 'tabs', role: 'tablist' }, Object.entries(TABS).map(([k, [label]]) =>
    el('button', { role: 'tab', 'aria-selected': String(view.tab === k), onclick: () => { view.tab = k; render(); } }, label)));
  return el('div', {}, bar, el('div', { class: 'tab', role: 'tabpanel' }, TABS[view.tab][1](view.detail)));
}

function summarise(ev) {
  const d = ev.data ?? {};
  if (ev.kind === 'run.planned') return `run plan recorded: ${d.ok ? 'no blockers' : `${d.blockers?.length} blocker(s)`}, ${d.nodes?.length ?? 0} nodes`;
  const s = JSON.stringify(d);
  return s === '{}' ? '' : s.length > 160 ? s.slice(0, 159) + '…' : s;
}

function timelineTab() {
  if (!view.events.length) return empty('Waiting for events…');
  return el('div', { class: 'panel' }, table(['#', 'Time', 'Event', 'Node', 'Detail'], view.events.map((e) =>
    el('tr', {}, el('td', { class: 'mono' }, e.seq), el('td', {}, new Date(e.at).toLocaleTimeString()), el('td', { class: 'mono' }, e.kind), el('td', {}, e.node_id ?? ''), el('td', { class: 'mono' }, summarise(e))))));
}

function ledgerTab(d) {
  if (!d.actions.length) return empty('This run has made no external writes.');
  return el('div', { class: 'panel' }, table(['Action', 'Node', 'Tool', 'State', 'Transitions', 'Receipt'], d.actions.map((a) =>
    el('tr', {},
      el('td', { class: 'mono' }, a.id),
      el('td', {}, a.node_id),
      el('td', {}, a.tool, el('br'), el('span', { class: 'muted' }, a.effect)),
      el('td', {}, badge(a.state, `t-${a.state}`)),
      el('td', {}, a.transitions.map((t) => `${t.state} (fence ${t.fence})`).join(' → ')),
      el('td', { class: 'mono' }, a.receipt ? JSON.stringify(a.receipt) : a.error ? JSON.stringify(a.error) : '—')))));
}

function coverageTab(d) {
  const p = d.plan;
  if (!p) return empty('This run was created before run plans were recorded with runs.');
  const rows = p.nodes.flatMap((n) => [
    ...(n.coverage ?? []).map((c) => el('tr', {}, el('td', {}, n.id), el('td', {}, c.action), el('td', {}, badge(c.enforcement, `e-${c.enforcement}`)), el('td', { class: 'muted' }, c.detail ?? ''))),
  ]);
  const reqs = p.nodes.flatMap((n) => (n.requirements ?? []).map((q) => el('tr', {}, el('td', {}, n.id), el('td', {}, q.name), el('td', {}, badge(q.mark, `m-${q.mark}`)), el('td', { class: 'muted' }, q.detail ?? ''))));
  return el('div', {},
    el('p', {}, p.signer?.verified ? `Signed by ${p.signer.publisher}, verified.` : `Signature not verified${p.signer?.error ? `: ${p.signer.error}` : ''}.`, ' ', p.ok ? 'The plan had no blockers.' : `The plan had ${p.blockers.length} blocker(s).`),
    p.blockers?.length ? el('div', { class: 'error' }, p.blockers.map((b) => el('div', {}, `${b.node ? `${b.node}: ` : ''}${b.message}`))) : null,
    el('h2', {}, 'Controls on each action'),
    el('div', { class: 'panel' }, rows.length ? table(['Node', 'Action', 'Enforcement', 'How'], rows) : empty('No controlled actions.')),
    el('h2', {}, 'Requirements'),
    el('div', { class: 'panel' }, reqs.length ? table(['Node', 'Requirement', 'Mark', 'Detail'], reqs) : empty('No requirements.')),
    el('p', { class: 'muted' }, 'This is the plan as it stood when the run was created.'),
  );
}

function contextTab(d) {
  if (!d.context_manifests.length) return empty('No agent turns recorded a context manifest.');
  return el('div', {}, d.context_manifests.map((m) => el('details', { class: 'panel', open: d.context_manifests.length < 4, style: 'margin-bottom:8px' },
    el('summary', {}, `${m.node_id} · attempt ${m.attempt} · turn ${m.turn} · ${num(m.total_tokens)} tokens (${m.token_source})`, m.tainted ? ' · ' : '', m.tainted ? badge('tainted', 's-failed') : ''),
    table(['Kind', 'Source', 'Reason', 'Tokens', 'Hash'], (m.items ?? []).map((i) => el('tr', {}, el('td', {}, i.kind ?? ''), el('td', {}, i.source), el('td', {}, i.reason ?? ''), el('td', {}, num(i.tokens ?? i.token_estimate)), el('td', { class: 'mono' }, String(i.content_hash ?? '').slice(0, 19))))))));
}

function usageTab(d) {
  const u = d.usage;
  if (!u.turns) return empty('No model usage in this run.');
  return el('div', {},
    el('p', {}, `${u.turns} turn(s). Usage is known for ${u.completeness_pct}% of them. Tokens: ${num(u.input_tokens)} in, ${num(u.output_tokens)} out. `,
      u.cost.amount === null ? 'Cost is unavailable: at least one turn has no declared pricing or no token counts.' : `Estimated cost ${u.cost.currency} ${u.cost.amount.toFixed(4)} (pricing ${u.cost.pricing_revision}).`),
    el('div', { class: 'panel' }, table(['Node', 'Turn', 'Executor', 'Model', 'In', 'Out', 'Cache read', 'Reasoning', 'Cost'], u.records.map((x) =>
      el('tr', {}, el('td', {}, x.node_id), el('td', {}, `${x.attempt}.${x.turn}`), el('td', {}, x.executor), el('td', {}, x.model ?? '—'), el('td', {}, num(x.input_tokens)), el('td', {}, num(x.output_tokens)), el('td', {}, num(x.cache_read_tokens)), el('td', {}, num(x.reasoning_tokens)), el('td', {}, x.cost_label === 'unavailable' ? 'unavailable' : `${x.cost?.toFixed?.(4) ?? x.cost} (${x.cost_label})`))))),
  );
}

// ---- routing -----------------------------------------------------------------------------------

async function route() {
  view.stream = null;
  if (!token()) return askToken();
  try {
    const m = location.pathname.match(/^\/ui\/runs\/([^/]+)/);
    if (m) await runPage(decodeURIComponent(m[1]));
    else await runsPage();
  } catch (err) {
    if (err.status === 401 || (err.status === 403 && /token/.test(err.message))) {
      try { sessionStorage.removeItem('azhi-token'); } catch {}
      return askToken('That token was not accepted. Paste another one.');
    }
    app.replaceChildren(el('h1', {}, 'Could not load'), el('p', {}, err.message));
  }
}

route();
