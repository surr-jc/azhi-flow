import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Badge, ErrorNote, Loading, PageHead, Panel, Table } from '../ui';

export function Health() {
  const q = useQuery({ queryKey: ['doctor'], queryFn: () => api<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }>('/v1/doctor'), refetchInterval: 15_000 });
  return (
    <>
      <PageHead title="Health" sub={<>The same checks as <code>azhi doctor</code>.</>} />
      <ErrorNote error={q.error} />
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['Check', 'Status', 'Detail']}>
            {q.data.checks.map((c) => (
              <tr key={c.name}><td>{c.name}</td><td>{c.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="bad">problem</Badge>}</td><td>{c.detail}</td></tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
