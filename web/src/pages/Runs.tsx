import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, atLeast, type Overview, type RunRow, type WorkflowSummary } from '../api';
import { useMe } from '../App';
import { useRoute } from '../router';
import { ErrorNote, Loading, PageHead, Panel } from '../ui';
import { RunTable, StatusTiles } from './Overview';

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
      {o.data ? <StatusTiles o={o.data} active={state} /> : null}
      <div className="filters">
        <select aria-label="State" value={state} onChange={(e) => set('state', e.target.value)}>
          {states.map((s) => <option key={s} value={s}>{LABEL[s] ?? s}</option>)}
        </select>
        <select aria-label="Workflow" value={workflow} onChange={(e) => set('workflow', e.target.value)}>
          <option value="">All workflows</option>
          {workflows.data?.map((w) => <option key={w.slug} value={w.slug}>{w.slug}</option>)}
        </select>
        <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); set('q', typed.trim()); }}>
          <label className="lbl"><span>Search runs</span><input type="search" placeholder="Inputs or run id" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        </form>
        <label className="row small">From <input type="date" aria-label="From" value={from} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="row small">To <input type="date" aria-label="To" value={to} onChange={(e) => set('to', e.target.value)} /></label>
        <label className="row small"><input type="checkbox" checked={subs} onChange={(e) => set('subs', e.target.checked ? '1' : '')} /> Show subworkflow runs</label>
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
