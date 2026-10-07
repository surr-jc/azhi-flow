import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, atLeast } from '../api';
import { useMe } from '../App';
import { Link, useRoute } from '../router';
import { Badge, ErrorNote, Loading, PageHead, Panel, Table } from '../ui';
import { McpForm, NewDataset, ToolForm } from './Authoring';

interface Dataset { name: string; trusted: boolean; latest_revision: number | null; tags: Record<string, number>; documents: number }

export function Datasets() {
  const me = useMe();
  const { navigate } = useRoute();
  const q = useQuery({ queryKey: ['datasets'], queryFn: () => api<Dataset[]>('/v1/datasets') });
  return (
    <>
      <PageHead title="Datasets" sub="Knowledge that agent and retrieve nodes read, pinned per run. Add documents, then publish a revision to index them." />
      <ErrorNote error={q.error} />
      {atLeast(me.data?.role, 'author') ? <Panel title="New dataset"><NewDataset onCreated={(n) => navigate(`/ui/datasets/${encodeURIComponent(n)}`)} /></Panel> : null}
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['Dataset', 'Trust', 'Documents', 'Latest revision', 'Tags']} empty="No datasets yet.">
            {q.data.map((d) => (
              <tr key={d.name}>
                <td><Link to={`/ui/datasets/${encodeURIComponent(d.name)}`} className="mono">{d.name}</Link></td>
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

interface Tool { id: string; version: number; description: string; effect: string; output_trusted?: boolean; transport?: { kind?: string }; revision?: number; [k: string]: unknown }

export function Tools() {
  const me = useMe();
  const q = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/v1/tools') });
  const [editing, setEditing] = useState<{ key: string; spec?: Record<string, unknown>; mode: 'tool' | 'mcp' }>();
  const admin = atLeast(me.data?.role, 'admin');
  return (
    <>
      <PageHead
        title="Tools"
        sub="Every external call goes through the gateway as one of these tools. Writes are recorded in each run's action ledger."
        actions={admin ? <div className="row"><button type="button" onClick={() => setEditing({ key: `mcp-${Date.now()}`, mode: 'mcp' })}>Add remote MCP</button><button type="button" onClick={() => setEditing({ key: `new-${Date.now()}`, mode: 'tool' })}>Register a tool</button></div> : undefined}
      />
      <ErrorNote error={q.error} />
      {editing ? (
        <Panel title={editing.mode === 'mcp' ? 'Add remote MCP' : editing.spec ? `Change ${editing.spec.id}@${editing.spec.version}` : 'Register a tool'} action={<button type="button" className="small" onClick={() => setEditing(undefined)}>Close</button>}>
          {editing.mode === 'mcp' ? <McpForm key={editing.key} /> : <ToolForm key={editing.key} from={editing.spec} />}
        </Panel>
      ) : null}
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['Tool', 'Effect', 'Output', 'Transport', 'Description', '']} empty="No tools registered.">
            {[...q.data].sort((a, b) => a.id.localeCompare(b.id)).map((t) => (
              <tr key={`${t.id}@${t.version}`}>
                <td className="mono">{t.id}@{t.version}</td>
                <td><Badge tone={t.effect === 'read' ? 'ok' : t.effect === 'write-unsafe' ? 'bad' : 'warn'}>{t.effect}</Badge></td>
                <td>{t.output_trusted ? 'trusted' : 'untrusted'}</td>
                <td>{t.transport?.kind ?? '—'}</td>
                <td>{t.description}</td>
                <td>
                  {admin && t.revision !== undefined ? (
                    <button type="button" className="small" onClick={() => {
                      const { revision: _r, ...spec } = t;
                       setEditing({ key: `${t.id}@${t.version}/${t.revision}`, spec, mode: 'tool' });
                    }}>Change</button>
                  ) : t.revision === undefined ? <span className="muted small">built in</span> : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
