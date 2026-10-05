import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ago, ErrorNote, Loading, PageHead, Panel, Table, when } from '../ui';

interface AuditEvent { seq: number; actor: string | null; kind: string; data: Record<string, unknown>; at: string }

export function Audit() {
  const q = useInfiniteQuery({
    queryKey: ['audit'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<AuditEvent[]>(`/v1/audit?limit=100${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]!.seq : undefined),
  });
  return (
    <>
      <PageHead title="Audit log" sub="Credential changes, publications, approvals, schedule and trust-policy changes, and every change made from this app." />
      <ErrorNote error={q.error} />
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['When', 'Who', 'What', 'Detail']} empty="Nothing recorded yet.">
            {q.data.pages.flat().map((e) => (
              <tr key={e.seq}>
                <td title={when(e.at)}>{ago(e.at)}</td>
                <td className="mono small">{e.actor ?? 'system'}</td>
                <td className="mono">{e.kind}</td>
                <td className="mono small">{JSON.stringify(e.data)}</td>
              </tr>
            ))}
          </Table>
        )}
        {q.hasNextPage ? <button onClick={() => q.fetchNextPage()}>Load more</button> : null}
      </Panel>
    </>
  );
}
