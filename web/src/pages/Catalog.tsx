import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Badge, ErrorNote, Loading, PageHead, Panel, Table } from '../ui';

interface Dataset { name: string; trusted: boolean; latest_revision: number | null; tags: Record<string, number>; documents: number }

export function Datasets() {
  const q = useQuery({ queryKey: ['datasets'], queryFn: () => api<Dataset[]>('/v1/datasets') });
  return (
    <>
      <PageHead title="Datasets" sub={<>Knowledge that agent and retrieve nodes read, pinned per run. Manage them with <code>azhi dataset</code>.</>} />
      <ErrorNote error={q.error} />
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['Dataset', 'Trust', 'Documents', 'Latest revision', 'Tags']} empty="No datasets yet.">
            {q.data.map((d) => (
              <tr key={d.name}>
                <td className="mono">{d.name}</td>
                <td>{d.trusted ? <Badge tone="ok">trusted</Badge> : <Badge tone="warn">untrusted</Badge>}</td>
                <td>{d.documents}</td>
                <td>{d.latest_revision ? `r${d.latest_revision}` : <span className="muted">unpublished</span>}</td>
                <td>{Object.entries(d.tags ?? {}).map(([t, r]) => <Badge key={t}>{t} → r{r}</Badge>)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}

interface Tool { id: string; version: number; description: string; effect: string; output_trusted?: boolean; transport?: { kind?: string } }

export function Tools() {
  const q = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/v1/tools') });
  return (
    <>
      <PageHead title="Tools" sub="Every external call goes through the gateway as one of these tools. Writes are recorded in each run's action ledger." />
      <ErrorNote error={q.error} />
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['Tool', 'Effect', 'Output', 'Transport', 'Description']} empty="No tools registered.">
            {[...q.data].sort((a, b) => a.id.localeCompare(b.id)).map((t) => (
              <tr key={`${t.id}@${t.version}`}>
                <td className="mono">{t.id}@{t.version}</td>
                <td><Badge tone={t.effect === 'read' ? 'ok' : t.effect === 'write-unsafe' ? 'bad' : 'warn'}>{t.effect}</Badge></td>
                <td>{t.output_trusted ? 'trusted' : 'untrusted'}</td>
                <td>{t.transport?.kind ?? '—'}</td>
                <td>{t.description}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
