import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type WorkflowSummary } from '../api';
import { Badge, ErrorNote, Loading, useConfirm } from '../ui';
import { Link } from '../router';
import { signVersion } from '../signing';
import { DatasetPage, ToolForm } from '../pages/Authoring';
import { SystemPanel } from '../pages/Connections';
import { HarnessGuides, type Guide } from './LibraryParts';
import { McpStatusBadge, useReconnect, type McpStatus } from './McpSignIn';

/**
 * Everything you do to one toolbox item, in its own dialog: view, edit, publish, attach to a workflow
 * and delete for library items; sign in and remove for hosted connections; tokens, repositories and
 * actions for apps; documents and revisions for knowledge. Nothing here sends you to another page.
 */
interface ItemRef { id: string; name: string; kind: string; status: string; details: Record<string, any> }
interface Props { item: ItemRef; canEdit: boolean; admin: boolean; onGone: () => void }

export function ManagePanel({ item, canEdit, admin, onGone }: Props) {
  const [kind, key] = [item.id.slice(0, item.id.indexOf(':')), item.id.slice(item.id.indexOf(':') + 1)];
  if (kind === 'asset') return <AssetPanel id={key} canEdit={canEdit} onGone={onGone} />;
  if (kind === 'connection') return <ConnectionPanel name={key} admin={admin} onGone={onGone} />;
  if (kind === 'app') return <AppPanel system={key} admin={admin} />;
  if (kind === 'dataset') return <DatasetPage name={key} canEdit={canEdit} />;
  return null;
}

// ---- library items: skills, roles, commands and MCP servers ----------------------------------------------------------
interface Asset { id: string; kind: 'mcp' | 'agent' | 'skill' | 'command'; slug: string; name: string; description: string; status: string; current_version: number; versions: Array<{ version: number; published: boolean; definition: Record<string, any> }> }
const TEXT_FIELD: Record<string, { key: string; label: string }> = { agent: { key: 'prompt', label: 'Prompt' }, skill: { key: 'instructions', label: 'Instructions' }, command: { key: 'template', label: 'Prompt template' } };

function AssetPanel({ id, canEdit, onGone }: { id: string; canEdit: boolean; onGone: () => void }) {
  const qc = useQueryClient();
  const [ask, dialog] = useConfirm();
  const q = useQuery({ queryKey: ['portable-asset', id], queryFn: () => api<Asset>(`/v1/assets/${encodeURIComponent(id)}`) });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary') });
  const guides = useQuery({ queryKey: ['harness-guides', id, q.data?.current_version], queryFn: () => api<Guide[]>(`/v1/assets/${encodeURIComponent(id)}/harness-guides`), enabled: Boolean(q.data) });
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['toolbox'] }), qc.invalidateQueries({ queryKey: ['portable-asset', id] }), qc.invalidateQueries({ queryKey: ['portable-assets'] })]); };
  const publish = useMutation({ mutationFn: () => api(`/v1/assets/${encodeURIComponent(id)}/publish`, { method: 'POST' }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api(`/v1/assets/${encodeURIComponent(id)}/archive`, { method: 'POST' }), onSuccess: async () => { await refresh(); onGone(); } });
  const [target, setTarget] = useState('');
  const [attached, setAttached] = useState<string>();
  const attach = useMutation({
    mutationFn: (slug: string) => api(`/v1/workflows/${encodeURIComponent(slug)}/assets`, { method: 'POST', body: { asset_id: id } }),
    onSuccess: async (_r, slug) => { setAttached(slug); await qc.invalidateQueries({ queryKey: ['workflow-assets', slug] }); await qc.invalidateQueries({ queryKey: ['toolbox'] }); },
  });
  if (q.error) return <ErrorNote error={q.error} />;
  const a = q.data;
  if (!a) return <Loading />;
  const current = a.versions.find((v) => v.version === a.current_version);
  const published = a.status === 'published';
  return (
    <div className="tb-manage">
      {dialog}
      <h4 className="tb-h">Manage</h4>
      <p className="small">
        <span className="muted">Version {a.current_version}, {published ? 'published' : 'draft: review it, then publish so workflows can use it'}.</span>
        {canEdit && !published ? <> <button type="button" className="primary small" disabled={publish.isPending} onClick={() => publish.mutate()}>{publish.isPending ? 'Publishing…' : 'Publish'}</button></> : null}
      </p>
      {published && workflows.data?.length ? (
        <div className="row">
          <select aria-label={`Workflow to attach ${a.name} to`} value={target} onChange={(e) => { setTarget(e.target.value); setAttached(undefined); }}>
            <option value="">Attach to a workflow…</option>
            {workflows.data.map((w) => <option key={w.slug} value={w.slug}>{w.slug}</option>)}
          </select>
          <button type="button" disabled={!target || attach.isPending} onClick={() => attach.mutate(target)}>{attach.isPending ? 'Attaching…' : 'Attach'}</button>
          {attached ? <span className="ok-note" role="status">Attached to {attached}. It shows under Library items in that workflow's settings.</span> : null}
        </div>
      ) : null}
      {canEdit && current ? <EditAsset key={`${a.id}:${a.current_version}`} asset={a} definition={current.definition} onSaved={refresh} /> : null}
      {guides.data ? <details><summary className="small">Use it in OpenCode or Claude Code</summary><HarnessGuides guides={guides.data} /></details> : null}
      {canEdit ? (
        <p>
          <button type="button" className="danger" disabled={remove.isPending} onClick={async () => (await ask({ title: `Delete ${a.name}?`, text: 'It leaves the toolbox and workflows stop finding it. You can install it from the Library again.', confirm: 'Delete' })) && remove.mutate()}>Delete</button>
        </p>
      ) : null}
      <ErrorNote error={publish.error ?? remove.error ?? attach.error} />
    </div>
  );
}

function EditAsset({ asset, definition, onSaved }: { asset: Asset; definition: Record<string, any>; onSaved: () => Promise<void> }) {
  const field = TEXT_FIELD[asset.kind];
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description);
  const [text, setText] = useState(field ? String(definition[field.key] ?? '') : JSON.stringify(withoutProvenance(definition), null, 2));
  const [bad, setBad] = useState<string>();
  const save = useMutation({
    mutationFn: (def: Record<string, any>) => api(`/v1/assets/${encodeURIComponent(asset.id)}`, { method: 'PUT', body: { name, description, definition: def } }),
    onSuccess: onSaved,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBad(undefined);
    if (field) return save.mutate({ ...definition, description, [field.key]: text });
    try { save.mutate({ ...(definition.provenance ? { provenance: definition.provenance } : {}), ...JSON.parse(text) }); } catch (err) { setBad((err as Error).message); }
  };
  return (
    <details>
      <summary className="small">Edit</summary>
      <form onSubmit={submit} className="lib-form">
        <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="wide">Description<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="wide">{field?.label ?? 'Definition (JSON)'}<textarea className="mono" rows={field ? 10 : 12} required value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} /></label>
        <div className="wide row"><button className="primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save as a new version'}</button><span className="muted small">Saving makes a draft; publish it again to update workflows.</span></div>
        {bad ? <div className="error">Not valid JSON: {bad}</div> : null}
        <ErrorNote error={save.error} />
      </form>
    </details>
  );
}
const withoutProvenance = (d: Record<string, any>) => { const { provenance: _p, ...rest } = d; return rest; };

// ---- hosted connections --------------------------------------------------------------------------------------------------
function ConnectionPanel({ name, admin, onGone }: { name: string; admin: boolean; onGone: () => void }) {
  const qc = useQueryClient();
  const [ask, dialog] = useConfirm();
  const list = useQuery({ queryKey: ['mcp-connections'], queryFn: () => api<Array<McpStatus & { url: string; auth_kind: 'none' | 'oauth' }>>('/v1/mcp/connections'), enabled: admin, refetchInterval: (s) => (s.state.data?.some((c) => c.status === 'authorizing') ? 2000 : false) });
  const re = useReconnect();
  const c = list.data?.find((x) => x.name === name);
  const remove = useMutation({ mutationFn: (id: string) => api(`/v1/mcp/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['toolbox'] }); await qc.invalidateQueries({ queryKey: ['mcp-connections'] }); onGone(); } });
  if (!admin) return <p className="muted small">An admin manages hosted connections.</p>;
  if (list.error) return <ErrorNote error={list.error} />;
  if (!c) return <Loading />;
  return (
    <div className="tb-manage">
      {dialog}
      <h4 className="tb-h">Manage</h4>
      <p className="small"><McpStatusBadge c={c} /> <span className="muted">{c.auth_kind === 'oauth' ? 'Signs in with OAuth' : 'No sign-in'}</span>{c.last_error ? <span className="muted"> · {c.last_error}</span> : null}</p>
      <div className="row">
        {c.auth_kind === 'oauth' ? <button type="button" disabled={re.isPending} onClick={() => re.reconnect(c.id)}>{c.status === 'ready' ? 'Sign in again' : 'Reconnect'}</button> : null}
        <button type="button" className="danger" disabled={remove.isPending} onClick={async () => (await ask({ title: `Delete ${c.name}?`, text: 'Workflows can no longer reach this server. A connection with registered actions cannot be removed, because runs may have pinned them.', confirm: 'Delete' })) && remove.mutate(c.id)}>Delete</button>
      </div>
      <ErrorNote error={re.error ?? remove.error} />
      {c.status === 'ready' ? <ConnectionTools id={c.id} name={c.name} /> : <p className="muted small">Finish signing in to see the tools this server offers.</p>}
    </div>
  );
}

// ---- the tools a signed-in server offers, and putting one in a workflow step -----------------------------------------------
interface RemoteTool { name: string; description: string }
interface Registered { id: string; version: number; effect: string; transport?: { kind?: string; connection?: string; tool?: string } }
const EFFECTS = ['read', 'write-idempotent', 'write-dedupable', 'write-unsafe'];
const toolId = (conn: string, tool: string) => `${conn}_${tool}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

function ConnectionTools({ id, name }: { id: string; name: string }) {
  const remote = useQuery({ queryKey: ['mcp-remote-tools', id], queryFn: () => api<RemoteTool[]>(`/v1/mcp/connections/${encodeURIComponent(id)}/tools`), retry: false });
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<Registered[]>('/v1/tools') });
  if (remote.error) return <ErrorNote error={remote.error} />;
  if (!remote.data || !tools.data) return <Loading />;
  const mine = tools.data.filter((t) => t.transport?.kind === 'mcp-streamable-http' && (t.transport.connection === id || t.transport.connection === name));
  return (
    <>
      <h4 className="tb-h">Tools this server offers ({remote.data.length})</h4>
      {!remote.data.length ? <p className="muted small">The server lists no tools.</p> : null}
      <ul className="tb-offered">
        {remote.data.map((t) => <OfferedTool key={t.name} conn={{ id, name }} tool={t} registered={mine.find((r) => r.transport?.tool === t.name)} />)}
      </ul>
    </>
  );
}

function OfferedTool({ conn, tool, registered }: { conn: { id: string; name: string }; tool: RemoteTool; registered?: Registered }) {
  const qc = useQueryClient();
  const [effect, setEffect] = useState('');
  const [adding, setAdding] = useState(false);
  const register = useMutation({
    mutationFn: () => api(`/v1/mcp/connections/${encodeURIComponent(conn.id)}/tools`, { method: 'POST', body: { id: toolId(conn.name, tool.name), version: 1, name: tool.name, description: tool.description || tool.name, effect, output_schema: { type: 'object' } } }),
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['tools'] }), qc.invalidateQueries({ queryKey: ['toolbox'] })]); },
  });
  const ref = registered ? `${registered.id}@${registered.version}` : null;
  return (
    <li>
      <div className="row">
        <span className="mono">{tool.name}</span>
        {registered ? <Badge tone={registered.effect === 'read' ? 'ok' : 'warn'}>{registered.effect === 'read' ? 'read' : 'writes'}</Badge> : null}
        {ref ? <button type="button" className="small" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : 'Add to a workflow step'}</button> : (
          <>
            <select aria-label={`What ${tool.name} does`} value={effect} onChange={(e) => setEffect(e.target.value)}>
              <option value="">What does it do?</option>
              {EFFECTS.map((x) => <option key={x} value={x}>{x === 'read' ? 'Only reads' : x}</option>)}
            </select>
            <button type="button" className="small" disabled={!effect || register.isPending} onClick={() => register.mutate()}>{register.isPending ? 'Adding…' : 'Make available to workflows'}</button>
          </>
        )}
      </div>
      {tool.description ? <p className="muted small">{tool.description}</p> : null}
      <ErrorNote error={register.error} />
      {ref && adding ? <AddToStep refName={ref} /> : null}
    </li>
  );
}

interface Step { id: string; type: string; [k: string]: unknown }
/** Puts a registered tool into a workflow's latest version as a new draft: either a new tool step or an existing tool step. */
function AddToStep({ refName }: { refName: string }) {
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary') });
  const [slug, setSlug] = useState('');
  const [where, setWhere] = useState('new');
  const versions = useQuery({ queryKey: ['versions', slug], queryFn: () => api<Array<{ id: string; version: number }>>(`/v1/workflows/${encodeURIComponent(slug)}/versions`), enabled: Boolean(slug) });
  const latest = versions.data?.[0];
  const base = useQuery({ queryKey: ['version', latest?.id], queryFn: () => api<{ definition: { nodes: Step[] } & Record<string, unknown> }>(`/v1/versions/${latest!.id}`), enabled: Boolean(latest) });
  const toolSteps = (base.data?.definition.nodes ?? []).filter((n) => n.type === 'tool');
  const save = useMutation({
    mutationFn: async () => {
      const def = structuredClone(base.data!.definition);
      if (where === 'new') {
        let i = 1;
        while (def.nodes.some((n) => n.id === `tool_${i}`)) i++;
        def.nodes.push({ id: `tool_${i}`, type: 'tool', tool: refName });
      } else {
        const step = def.nodes.find((n) => n.id === where);
        if (step) step.tool = refName;
      }
      const r = await api<{ ok: boolean; diagnostics: Array<{ message: string }>; version?: { id: string; version: number } }>(`/v1/versions/${latest!.id}/drafts`, { method: 'POST', body: { definition: def, profiles: {}, files: {} } });
      // Workers run signed packages only; the workflow page offers signing again if this fails.
      if (r.ok && r.version) await signVersion(r.version.id).catch(() => undefined);
      return r;
    },
  });
  const r = save.data;
  return (
    <div className="tb-addstep">
      <div className="row">
        <select aria-label="Workflow" value={slug} onChange={(e) => { setSlug(e.target.value); setWhere('new'); save.reset(); }}>
          <option value="">Choose a workflow…</option>
          {workflows.data?.map((w) => <option key={w.slug} value={w.slug}>{w.slug}</option>)}
        </select>
        {slug && base.data ? (
          <select aria-label="Step" value={where} onChange={(e) => { setWhere(e.target.value); save.reset(); }}>
            <option value="new">As a new tool step</option>
            {toolSteps.map((n) => <option key={n.id} value={n.id}>Replace the tool in step {n.id}</option>)}
          </select>
        ) : null}
        <button type="button" className="primary small" disabled={!base.data || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Add'}</button>
      </div>
      <p className="muted small">This saves a new draft of the workflow. Agent steps pick their tools in the step's own settings; this tool is listed there once it is registered.</p>
      {r?.ok ? <p className="ok-note" role="status">Saved as draft v{r.version?.version}. <Link to={`/ui/workflows/${encodeURIComponent(slug)}/edit?from=${encodeURIComponent(r.version?.id ?? '')}`}>Open it in the editor</Link> to fill in the step's input.</p> : null}
      {r && !r.ok ? <ul className="lib-warn">{r.diagnostics.map((d, i) => <li key={i}>{d.message}</li>)}</ul> : null}
      <ErrorNote error={save.error ?? versions.error ?? base.error} />
    </div>
  );
}

// ---- apps: the gateway's systems -----------------------------------------------------------------------------------------
interface RegisteredTool { id: string; version: number; revision?: number; [k: string]: unknown }

function AppPanel({ system, admin }: { system: string; admin: boolean }) {
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<RegisteredTool[]>('/v1/tools'), enabled: admin });
  const [editing, setEditing] = useState<{ key: string; spec: Record<string, unknown> }>();
  const own = (tools.data ?? []).filter((t) => t.id.split('.')[0] === system && t.revision !== undefined);
  return (
    <div className="tb-manage">
      <SystemPanel system={system} />
      {admin && own.length ? (
        <details>
          <summary className="small">Edit registered actions ({own.length})</summary>
          <ul className="tb-tools">
            {own.map((t) => (
              <li key={`${t.id}@${t.version}`}>
                <span className="mono">{t.id}@{t.version}</span>
                <button type="button" className="small" onClick={() => { const { revision: _r, ...spec } = t; setEditing({ key: `${t.id}@${t.version}/${t.revision}`, spec }); }}>Change</button>
              </li>
            ))}
          </ul>
          {editing ? <ToolForm key={editing.key} from={editing.spec} /> : null}
        </details>
      ) : null}
    </div>
  );
}
