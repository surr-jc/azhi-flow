import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, atLeast, type RunRow, type WorkflowSummary } from '../api';
import { useMe } from '../App';
import { useRoute } from '../router';
import { ErrorNote, Loading, PageHead, Panel } from '../ui';
import { RunTable } from './Overview';

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
  const states = STATES.includes(state) ? STATES : [...STATES, state];
  return (
    <>
      <PageHead title="Runs" />
      <div className="filters">
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
        {state || workflow || text || from || to ? <button type="button" className="small" onClick={() => navigate('/ui/runs')}>Clear</button> : null}
      </div>
      <Panel>
        <ErrorNote error={q.error} />
        {q.data ? <RunTable runs={q.data.pages.flat()} empty="No runs match." cancel={atLeast(me.data?.role, 'operator')} inputs={Boolean(text)} /> : <Loading />}
        {q.hasNextPage ? <button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load more</button> : null}
      </Panel>
    </>
  );
}
