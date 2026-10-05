import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, type RunRow, type WorkflowSummary } from '../api';
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
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary') });
  const q = useInfiniteQuery({
    queryKey: ['runs', state, workflow],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(PAGE) });
      if (state) p.set('state', state);
      if (workflow) p.set('workflow', workflow);
      if (pageParam) p.set('before', pageParam);
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
      </div>
      <Panel>
        <ErrorNote error={q.error} />
        {q.data ? <RunTable runs={q.data.pages.flat()} empty="No runs match." /> : <Loading />}
        {q.hasNextPage ? <button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load more</button> : null}
      </Panel>
    </>
  );
}
