import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { api, atLeast, type WorkflowSummary } from '../api';
import { useMe } from '../App';
import { Badge, ErrorNote, Loading, PageHead, Panel, Table } from '../ui';

type Kind = 'mcp' | 'agent' | 'skill' | 'command';
type Asset = { id: string; kind: Kind; slug: string; name: string; description: string; status: string; current_version: number; definition?: Record<string, unknown>; version_id?: string };
const example: Record<Kind, Record<string, unknown>> = {
  mcp: { transport: 'remote', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer {env:MY_API_KEY}' }, enabled: true },
  agent: { description: 'A focused helper', mode: 'subagent', prompt: 'You are a careful specialist. Explain your findings clearly.' },
  skill: { description: 'Reusable operating instructions', instructions: '## When to use\n\nUse this skill when the task matches its purpose.' },
  command: { description: 'A repeatable prompt', template: 'Review $ARGUMENTS and report the important findings.' },
};

export function Assets() {
  const me = useMe(); const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>('mcp'); const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [description, setDescription] = useState(''); const [definition, setDefinition] = useState(JSON.stringify(example.mcp, null, 2)); const [error, setError] = useState<string>(); const [guide, setGuide] = useState<any>();
  const assets = useQuery({ queryKey: ['portable-assets'], queryFn: () => api<Asset[]>('/v1/assets') });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary') });
  const save = useMutation({ mutationFn: (body: any) => api('/v1/assets', { method: 'POST', body }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['portable-assets'] }); setName(''); setSlug(''); setDescription(''); setError(undefined); } });
  const publish = useMutation({ mutationFn: (id: string) => api(`/v1/assets/${id}/publish`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['portable-assets'] }) });
  const archive = useMutation({ mutationFn: (id: string) => api(`/v1/assets/${id}/archive`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['portable-assets'] }) });
  const attach = useMutation({ mutationFn: ({ slug, id }: { slug: string; id: string }) => api(`/v1/workflows/${encodeURIComponent(slug)}/assets`, { method: 'POST', body: { asset_id: id } }) });
  const canEdit = atLeast(me.data?.role, 'author');
  const shown = useMemo(() => assets.data?.filter((a) => a.kind === kind) ?? [], [assets.data, kind]);
  const changeKind = (next: Kind) => { setKind(next); setDefinition(JSON.stringify(example[next], null, 2)); setError(undefined); };
  const submit = (e: FormEvent) => { e.preventDefault(); try { save.mutate({ kind, name, slug, description, definition: JSON.parse(definition) }); } catch { setError('Definition must be valid JSON.'); } };
  return <>
    <PageHead title="Portable assets" sub="Create MCP servers, agents, skills, and commands once; publish a version and attach it to a workflow when needed." />
    <div className="asset-tabs" role="tablist">{(['mcp', 'agent', 'skill', 'command'] as Kind[]).map((k) => <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => changeKind(k)}>{k === 'mcp' ? 'MCP servers' : `${k.charAt(0).toUpperCase()}${k.slice(1)}s`}</button>)}</div>
    {canEdit ? <Panel title={`Add ${kind === 'mcp' ? 'MCP server' : kind}`}><form onSubmit={submit} className="asset-form"><label>Name<input required value={name} onChange={(e) => { setName(e.target.value); if (!slug) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} /></label><label>Slug<input required pattern="[a-z0-9][a-z0-9-]*" value={slug} onChange={(e) => setSlug(e.target.value)} /></label><label className="wide">Description<input value={description} onChange={(e) => setDescription(e.target.value)} /></label><label className="wide">Definition (JSON)<textarea className="mono" rows={10} value={definition} onChange={(e) => setDefinition(e.target.value)} /></label><div className="wide row"><button className="primary" disabled={save.isPending}>Save draft</button>{error ? <span className="error inline">{error}</span> : null}{save.error ? <span className="error inline">{(save.error as Error).message}</span> : null}</div></form></Panel> : null}
    <ErrorNote error={assets.error} />
    <Panel title={`${kind === 'mcp' ? 'MCP servers' : `${kind.charAt(0).toUpperCase()}${kind.slice(1)}s`} library`}>
      {!assets.data ? <Loading /> : <Table head={['Name', 'Version', 'Status', 'Actions']} empty={`No ${kind} assets yet.`}>{shown.map((a) => <tr key={a.id}><td><b>{a.name}</b><div className="muted small mono">{a.slug}</div>{a.description ? <div className="muted small">{a.description}</div> : null}</td><td>v{a.current_version}</td><td><Badge tone={a.status === 'published' ? 'ok' : a.status === 'archived' ? 'idle' : 'warn'}>{a.status}</Badge></td><td><div className="row asset-actions">{canEdit && a.status !== 'published' && a.status !== 'archived' ? <button onClick={() => publish.mutate(a.id)}>Publish</button> : null}{canEdit && a.status !== 'archived' ? <button onClick={() => archive.mutate(a.id)}>Archive</button> : null}{a.kind === 'mcp' ? <button onClick={async () => setGuide(await api(`/v1/assets/${a.id}/opencode-guide`))}>OpenCode guide</button> : null}{a.status === 'published' && workflows.data?.length ? <select aria-label={`Attach ${a.name}`} defaultValue="" onChange={(e) => { if (e.target.value) attach.mutate({ slug: e.target.value, id: a.id }); e.currentTarget.value = ''; }}><option value="">Attach to workflow…</option>{workflows.data.map((w) => <option value={w.slug} key={w.slug}>{w.slug}</option>)}</select> : null}</div></td></tr>)}</Table>}
    </Panel>
    {guide ? <Panel title={guide.title} action={<button onClick={() => setGuide(undefined)}>Close</button>}><ol>{guide.steps.map((s: string) => <li key={s}><code>{s}</code></li>)}</ol><p className="muted">{guide.note}</p></Panel> : null}
  </>;
}
