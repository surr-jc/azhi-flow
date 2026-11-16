import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { nodeStates } from '../components/WorkflowCanvas';
import { api, atLeast, TERMINAL, type Overview, type RunRow, type WorkflowSummary } from '../api';
import { useMe } from '../App';
import { useRoute } from '../router';
import { Link } from '../router';
import { ago, Badge, ErrorNote, Loading, money, num, PageHead, Panel, RunLink, StateBadge, useConfirm, when } from '../ui';
import { duration } from './Overview';

/** One quiet line of system state. Zeros stay grey; only counts that need a person get colour. */
function StatusBar({ o, active }: { o: Overview; active: string }) {
  const day = o.last_24h;
  const running = (o.open.running ?? 0) + (o.open.queued ?? 0);
  const failed = (day.failed ?? 0) + (day.delivery_failed ?? 0) + (day.expired ?? 0);
  const items = [
    { key: 'running,queued', label: 'running', n: running, tone: 'run', to: '/ui/runs?state=running,queued' },
    { key: 'waiting', label: 'waiting', n: o.open.waiting ?? 0, tone: 'warn', to: '/ui/runs?state=waiting' },
    { key: 'approvals', label: 'need you', n: o.approvals.mine, tone: 'warn', to: '/ui/approvals' },
    { key: 'succeeded', label: 'succeeded', n: day.succeeded ?? 0, tone: 'ok', to: '/ui/runs?state=succeeded' },
    { key: 'failed,delivery_failed,expired', label: 'failed', n: failed, tone: 'bad', to: '/ui/runs?state=failed,delivery_failed,expired' },
  ];
  return (
    <nav className="status-bar" aria-label="System status">
      {items.map((i) => (
        <Link key={i.key} to={i.to} className={`status-item${i.n ? ` ${i.tone}` : ''}${active === i.key ? ' active' : ''}`} aria-current={active === i.key ? 'true' : undefined}>
          <b>{num(i.n)}</b> {i.label}
        </Link>
      ))}
      <span className="status-note">last 24 hours</span>
      <Link to="/ui/workers" className={`status-aside${o.workers.online ? '' : ' bad'}`}>{o.workers.online}/{o.workers.total} workers</Link>
      <Link to="/ui/usage" className="status-aside">{money(o.spend.week.amount, o.spend.week.currency, o.spend.week.complete)} this week</Link>
    </nav>
  );
}

/** Shown only when something is waiting on the signed-in person, so an idle system stays quiet. */
function NeedsYou({ o }: { o: Overview }) {
  if (!o.approvals.mine) return null;
  return (
    <div className="needs-you" role="status">
      <span><b>{num(o.approvals.mine)}</b> approval{o.approvals.mine === 1 ? '' : 's'} waiting for you</span>
      <Link to="/ui/approvals" className="button">Review approvals</Link>
    </div>
  );
}

const GLYPH: Record<string, string> = { succeeded: '✓', failed: '✕', delivery_failed: '✕', expired: '✕', cancelled: '–', waiting: '…', running: '▶', queued: '…', cancelling: '…' };
const tone = (s: string) => (s === 'succeeded' ? 'ok' : ['failed', 'delivery_failed', 'expired'].includes(s) ? 'bad' : ['waiting', 'queued', 'cancelling'].includes(s) ? 'warn' : s === 'running' ? 'run' : 'idle');
const secs = (r: RunRow) => (r.ended_at ? Math.max(0, Math.round((new Date(r.ended_at).getTime() - new Date(r.created_at).getTime()) / 1000)) : null);

/** Compact run list; selecting a row opens its details beside it. Run text stays plain text, never a command. */
function RunConsole({ runs, empty, emptyHint, emptyAction, cancel }: { runs: RunRow[]; empty: string; emptyHint: string; emptyAction?: ReactNode; cancel: boolean }) {
  const [picked, setPicked] = useState('');
  const [copied, setCopied] = useState(false);
  const qc = useQueryClient();
  const [ask, dialog] = useConfirm();
  const stop = useMutation({
    mutationFn: (id: string) => api(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  });
  // Subworkflow runs always sit directly under their parent, oldest first; a child whose parent
  // is not in the loaded set stays at the top level so nothing disappears.
  const { rows, byId } = useMemo(() => {
    const ids = new Set(runs.map((r) => r.id));
    const kids = new Map<string, RunRow[]>();
    for (const r of runs) if (r.parent_run_id && ids.has(r.parent_run_id)) kids.set(r.parent_run_id, [...(kids.get(r.parent_run_id) ?? []), r]);
    const out: Array<{ run: RunRow; depth: number; orphan: boolean }> = [];
    const walk = (r: RunRow, depth: number, orphan: boolean) => {
      out.push({ run: r, depth, orphan });
      for (const k of [...(kids.get(r.id) ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))) walk(k, depth + 1, false);
    };
    for (const r of runs) if (!r.parent_run_id || !ids.has(r.parent_run_id)) walk(r, 0, Boolean(r.parent_run_id));
    return { rows: out, byId: new Map(runs.map((r) => [r.id, r])) };
  }, [runs]);
  const sel = byId.get(picked) ?? rows[0]?.run;
  const detail = useQuery({ queryKey: ['run', sel?.id], queryFn: () => api<any>(`/v1/runs/${encodeURIComponent(sel!.id)}`), enabled: Boolean(sel), refetchInterval: sel && !TERMINAL.includes(sel.state) ? 5_000 : false });
  if (!sel) return <div className="runs-empty"><b>{empty}</b><span className="muted">{emptyHint}</span>{emptyAction}</div>;
  const d = detail.data;
  const steps = d ? Object.entries(nodeStates(d)) : [];
  const count = (s: string) => steps.filter(([, v]) => v.state === s).length;
  const failedStep = steps.find(([, v]) => v.state === 'failed')?.[0];
  const u = d?.usage;
  const children = ((d?.children ?? []) as Array<{ id: string }>);
  const approvals = (d?.approvals ?? []) as Array<{ decision: string | null }>;
  const siblings = runs.filter((r) => r.workflow === sel.workflow && secs(r) !== null).slice(0, 8);
  const longest = Math.max(1, ...siblings.map((r) => secs(r) ?? 0));
  const open = !TERMINAL.includes(sel.state) && sel.state !== 'cancelling';
  const copy = () => { void navigator.clipboard?.writeText(sel.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return (
    <div className="run-console">
      {dialog}
      <ul className="run-list" aria-label="Runs">
        {rows.map(({ run: r, depth, orphan }) => (
          <li key={r.id} className={depth ? 'run-child' : undefined}>
            <button type="button" className={`run-item ${tone(r.state)}${r.id === sel.id ? ' selected' : ''}`} style={depth ? { paddingLeft: 13 + depth * 26 } : undefined} aria-pressed={r.id === sel.id} onClick={() => setPicked(r.id)}>
              <span className="run-glyph" aria-hidden="true">{GLYPH[r.state] ?? '·'}</span>
              <span className="run-main"><b>{depth || orphan ? <span className="muted" title={orphan ? 'Subworkflow run; its parent is not in this list' : 'Subworkflow run'}>↳ </span> : null}{r.workflow}<span className="muted">@{r.version}</span></b><span className="mono small muted">{r.id}</span></span>
              <span className="run-meta"><span>{r.ended_at ? duration(r.created_at, r.ended_at) : '—'}</span><span className="muted">{ago(r.created_at)}</span></span>
              <span className="sr-only">{r.state.replaceAll('_', ' ')}</span>
            </button>
          </li>
        ))}
      </ul>
      <aside className="run-detail" aria-label="Selected run">
        <div className="run-detail-head"><span className="eyebrow">Selected run</span><StateBadge state={sel.state} />{sel.test ? <Badge tone="idle">test</Badge> : null}</div>
        <h2><Link to={`/ui/workflows/${encodeURIComponent(sel.workflow)}`}>{sel.workflow}</Link><span className="muted">@{sel.version}</span></h2>
        <code className="mono small muted run-id">{sel.id}</code>
        {sel.flags?.waiting_reason ? <p className="small muted">Waiting: {String(sel.flags.waiting_reason.reason).replace('_', ' ')}</p> : null}
        <dl className="run-facts">
          <div><dt>Started</dt><dd title={when(sel.created_at)}>{ago(sel.created_at)}</dd></div>
          <div><dt>Took</dt><dd>{sel.ended_at ? duration(sel.created_at, sel.ended_at) : '—'}</dd></div>
          <div><dt>Trigger</dt><dd>{sel.parent_run_id ? <>↳ <RunLink id={sel.parent_run_id} /></> : sel.trigger}</dd></div>
          <div><dt>Started at</dt><dd>{when(sel.created_at)}</dd></div>
          {sel.ended_at ? <div><dt>Ended at</dt><dd>{when(sel.ended_at)}</dd></div> : null}
          <div><dt>Workflow version</dt><dd>v{sel.version}</dd></div>
        </dl>
        {detail.isLoading ? <p className="small muted">Loading summary…</p> : null}
        {d?.run?.error ? <div className="error run-error"><strong>{String(d.run.error.class)}</strong>: {String(d.run.error.message)}</div> : null}
        {d ? (
          <dl className="run-facts">
            <div><dt>Steps</dt><dd>{steps.length ? [count('succeeded') && `${count('succeeded')} done`, count('failed') && `${count('failed')} failed`, count('running') && `${count('running')} running`, count('waiting') && `${count('waiting')} waiting`].filter(Boolean).join(' · ') || 'None finished' : 'None started'}</dd></div>
            <div><dt>{failedStep ? 'Failed at' : 'Approvals'}</dt><dd>{failedStep ?? (approvals.length ? `${approvals.filter((a) => a.decision !== null).length} of ${approvals.length} decided` : 'None')}</dd></div>
            <div><dt>Estimated cost</dt><dd>{!u?.turns ? 'No model calls' : u.cost.amount === null ? 'Unavailable' : `${u.cost.currency} ${u.cost.amount.toFixed(4)}`}</dd></div>
            <div><dt>Model calls</dt><dd>{u?.turns ? `${num(u.turns)} · ${num(u.input_tokens)} in / ${num(u.output_tokens)} out` : '—'}</dd></div>
          </dl>
        ) : null}
        {children.length ? (
          <div className="run-subs">
            <span className="eyebrow">Subworkflow runs ({children.length})</span>
            {children.map((c) => {
              const row = byId.get(c.id);
              return row
                ? <button key={c.id} type="button" className="link small" onClick={() => setPicked(c.id)}>{row.workflow}@{row.version} · {row.state.replaceAll('_', ' ')}</button>
                : <RunLink key={c.id} id={c.id} />;
            })}
          </div>
        ) : null}
        {sel.parent_run_id ? <p className="small muted">Part of <RunLink id={sel.parent_run_id} /></p> : null}
        {siblings.length > 1 ? (
          <div className="run-compare">
            <span className="eyebrow">Other {sel.workflow} runs</span>
            {siblings.map((r) => (
              <div key={r.id} className={`run-bar ${tone(r.state)}${r.id === sel.id ? ' me' : ''}`}>
                <span className="mono">@{r.version}</span>
                <span className="run-track"><span style={{ width: `${Math.max(4, Math.round(((secs(r) ?? 0) / longest) * 100))}%` }} /></span>
                <span>{duration(r.created_at, r.ended_at!)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {sel.inputs && Object.keys(sel.inputs).length ? <details className="run-inputs"><summary>Inputs</summary><pre className="mono small">{JSON.stringify(sel.inputs, null, 2)}</pre></details> : null}
        <div className="row run-actions">
          <Link to={`/ui/runs/${encodeURIComponent(sel.id)}`} className="button primary">Open run</Link>
          <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy run id'}</button>
          {cancel && open ? <button type="button" className="danger" disabled={stop.isPending} onClick={async () => (await ask({ title: `Cancel run ${sel.id}?`, text: 'Steps that have not started will not run.', confirm: 'Cancel run' })) && stop.mutate(sel.id)}>Cancel run</button> : null}
        </div>
        <ErrorNote error={stop.error} />
      </aside>
    </div>
  );
}

const STATES = ['', 'running,queued', 'waiting', 'succeeded', 'failed,delivery_failed,expired', 'cancelled'];
const LABEL: Record<string, string> = { '': 'All states', 'running,queued': 'Running', waiting: 'Waiting', succeeded: 'Succeeded', 'failed,delivery_failed,expired': 'Failed', cancelled: 'Cancelled' };
const PAGE = 50;

export function Runs() {
  const { search, navigate } = useRoute();
  const state = search.get('state') ?? '';
  const workflow = search.get('workflow') ?? '';
  const text = search.get('q') ?? '';
  const from = search.get('from') ?? '';
  const to = search.get('to') ?? '';
  const me = useMe();
  const [typed, setTyped] = useState(text);
  useEffect(() => setTyped(text), [text]);
  const o = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/v1/overview'), refetchInterval: 5_000 });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary') });
  const q = useInfiniteQuery({
    queryKey: ['runs', state, workflow, text, from, to],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(PAGE) });
      if (state) p.set('state', state);
      if (workflow) p.set('workflow', workflow);
      if (text) p.set('q', text);
      // Dates are local days: from the start of `from` to the end of `to`.
      if (from) p.set('since', new Date(`${from}T00:00:00`).toISOString());
      const end = to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : '';
      const before = pageParam && (!end || pageParam < end) ? pageParam : end;
      if (before) p.set('before', before);
      return api<RunRow[]>(`/v1/runs?${p}`);
    },
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.created_at : undefined),
    refetchInterval: 5_000,
  });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(search);
    if (v) p.set(k, v);
    else p.delete(k);
    navigate(`/ui/runs${p.size ? `?${p}` : ''}`);
  };
  const filtered = Boolean(state || workflow || text || from || to);
  const states = STATES.includes(state) ? STATES : [...STATES, state];
  return (
    <>
      <PageHead title="Runs" />
      {o.data ? <><StatusBar o={o.data} active={state} /><NeedsYou o={o.data} /></> : null}
      <div className="filters runs-filters">
        <select aria-label="State" value={state} onChange={(e) => set('state', e.target.value)}>
          {states.map((s) => <option key={s} value={s}>{LABEL[s] ?? s}</option>)}
        </select>
        <select aria-label="Workflow" value={workflow} onChange={(e) => set('workflow', e.target.value)}>
          <option value="">All workflows</option>
          {workflows.data?.map((w) => <option key={w.slug} value={w.slug}>{w.slug}</option>)}
        </select>
        <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); set('q', typed.trim()); }}>
          <input type="search" aria-label="Search runs" placeholder="Search inputs or run id" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </form>
        <label className="row small">From <input type="date" aria-label="From" value={from} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="row small">To <input type="date" aria-label="To" value={to} onChange={(e) => set('to', e.target.value)} /></label>
        {filtered ? <button type="button" className="small" onClick={() => navigate('/ui/runs')}>Clear all filters</button> : null}
      </div>
      <ErrorNote error={q.error} />
      {q.data ? <RunConsole runs={q.data.pages.flat()} empty={filtered ? 'No runs match these filters' : 'No runs yet'} emptyHint={filtered ? 'Widen the date range or pick another state.' : 'Start a workflow from its page and the run shows up here.'} emptyAction={filtered ? <button type="button" onClick={() => navigate('/ui/runs')}>Clear all filters</button> : undefined} cancel={atLeast(me.data?.role, 'operator')} /> : <Loading />}
      {q.hasNextPage ? <button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load more</button> : null}
    </>
  );
}
