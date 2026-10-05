import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ago, Badge, ErrorNote, Json, Loading, PageHead, Panel, Table, when } from '../ui';

interface Worker { id: string; name: string; owner_id: string; task_queue: string; capabilities: Record<string, any>; trust_policy: Record<string, any>; last_heartbeat: string; online: boolean }

export function Workers() {
  const q = useQuery({ queryKey: ['workers'], queryFn: () => api<Worker[]>('/v1/workers'), refetchInterval: 5_000 });
  return (
    <>
      <PageHead title="Workers" sub={<>Workers run scripts and harness agents on their own machines. Start one with <code>azhi worker start</code>.</>} />
      <ErrorNote error={q.error} />
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['Worker', 'Status', 'Last heartbeat', 'Queue', 'Runtimes', 'Trust policy', 'Capabilities']} empty="No worker has registered yet.">
            {q.data.map((w) => (
              <tr key={w.id}>
                <td>{w.name}<div className="muted small mono">{w.id}</div></td>
                <td>{w.online ? <Badge tone="ok">online</Badge> : <Badge tone="bad">offline</Badge>}</td>
                <td title={when(w.last_heartbeat)}>{new Date(w.last_heartbeat).getTime() <= 0 ? 'stopped' : ago(w.last_heartbeat)}</td>
                <td className="mono small">{w.task_queue}</td>
                <td>{Object.entries(w.capabilities?.runtimes ?? {}).map(([k, v]: [string, any]) => <Badge key={k}>{k} {v?.version ?? ''}</Badge>)}</td>
                <td>{w.trust_policy?.kind ?? '—'}</td>
                <td><details><summary>details</summary><Json value={w.capabilities} /></details></td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
