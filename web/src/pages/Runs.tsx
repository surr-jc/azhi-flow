import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, atLeast, type Overview, type RunRow, type WorkflowSummary } from '../api';
import { useMe } from '../App';
import { useRoute } from '../router';
import { Link } from '../router';
import { ErrorNote, Loading, money, num, PageHead, Panel } from '../ui';
import { RunTable } from './Overview';

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
  // Subworkflow runs show inside their parent's run page; this lists them as rows of their own.
  const subs = search.get('subs') === '1';
  const me = useMe();
  const [typed, setTyped] = useState(text);
  useEffect(() => setTyped(text), [text]);
  const o = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/v1/overview'), refetchInterval: 5_000 });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary') });
  const q = useInfiniteQuery({
    queryKey: ['runs', state, workflow, text, from, to, subs],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(PAGE) });
      if (!subs && !text) p.set('top_level', 'true');
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
  const filtered = Boolean(state || workflow || text || from || to || subs);
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
        <label className="row small subs-toggle"><input type="checkbox" checked={subs} onChange={(e) => set('subs', e.target.checked ? '1' : '')} /> Show subworkflow runs</label>
        {state || workflow || text || from || to || subs ? <button type="button" className="small" onClick={() => navigate('/ui/runs')}>Clear all filters</button> : null}
      </div>
      <Panel>
        <ErrorNote error={q.error} />
        {q.data ? <RunTable runs={q.data.pages.flat()} empty={filtered ? 'No runs match these filters' : 'No runs yet'} emptyHint={filtered ? 'Widen the date range or pick another state.' : 'Start a workflow from its page and the run shows up here.'} emptyAction={filtered ? <button type="button" onClick={() => navigate('/ui/runs')}>Clear all filters</button> : undefined} cancel={atLeast(me.data?.role, 'operator')} inputs={Boolean(text)} /> : <Loading />}
        {q.hasNextPage ? <button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load more</button> : null}
      </Panel>
    </>
  );
}
