import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { signVersion } from '../signing';
import { api, type JsonSchema, type ScheduleRow } from '../api';
import { Link } from '../router';
import { ago, Badge, ErrorNote, formValues, Loading, PageHead, Panel, SchemaFields, Table, when } from '../ui';

/**
 * Authoring in mission control (docs/mission-control-plan.md, increment 3): a version's files,
 * publishing a signed draft, a workflow's schedule, dataset documents and tool registration.
 * Every write is an existing API endpoint with its role check and audit entry.
 */

interface SourceFile { path: string; size: number; text?: string }

const formatSize = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

export function WorkflowFiles({ versionId }: { versionId: string }) {
  const q = useQuery({ queryKey: ['source', versionId], queryFn: () => api<{ workflow: string; files: SourceFile[] }>(`/v1/versions/${versionId}/source`), staleTime: Infinity });
  const [open, setOpen] = useState<string>();
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const shown = q.data.files.find((f) => f.path === (open ?? q.data.workflow));
  const groups = new Map<string, SourceFile[]>();
  for (const f of [...q.data.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const i = f.path.lastIndexOf('/');
    const dir = i < 0 ? '' : f.path.slice(0, i);
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  return (
    <div className="files">
      <nav className="file-list" aria-label="Package files">
        <div className="file-count muted small">{q.data.files.length} files</div>
        {dirs.map((dir) => (
          <section key={dir} className="file-group">
            {dir ? <h4 className="file-dir mono">{dir}/</h4> : null}
            <ul>
              {groups.get(dir)!.map((f) => (
                <li key={f.path}>
                  <button type="button" aria-label={f.path} title={f.path} className={`linkish file-item ${f.path === shown?.path ? 'current' : ''}`} onClick={() => setOpen(f.path)} aria-current={f.path === shown?.path}>
                    <span className="file-name">{f.path.slice(dir ? dir.length + 1 : 0)}</span>
                    <span className="file-size muted small">{formatSize(f.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
      <div className="file-view">
        {shown ? <div className="file-head mono small">{shown.path} <span className="muted">· {formatSize(shown.size)}</span></div> : null}
        {shown ? (shown.text !== undefined ? <pre className="code" aria-label={`Contents of ${shown.path}`}>{shown.text}</pre> : <p className="muted">{shown.path} is not shown here (binary or large).</p>) : null}
      </div>
    </div>
  );
}

/**
 * Publishing a draft, in the page header: a draft is signed in this browser first (workers run
 * signed packages only), then published, after which schedules and runs use it.
 */
export function PublishAction({ version, slug }: { version: { id: string; version: number; draft: boolean; signed: boolean }; slug: string }) {
  const qc = useQueryClient();
  const publish = useMutation({
    mutationFn: () => api(`/v1/versions/${version.id}/publish`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['versions', slug] });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['plan', version.id] });
    },
  });
  const sign = useMutation({
    mutationFn: () => signVersion(version.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['versions', slug] });
      void qc.invalidateQueries({ queryKey: ['plan', version.id] });
    },
  });
  if (!version.draft) return null;
  const err = (sign.error ?? publish.error) as Error | null;
  return (
    <>
      {version.signed ? (
        <button type="button" className="primary" disabled={publish.isPending} onClick={() => publish.mutate()} title={`Schedules and runs of ${slug} then use this version.`}>{publish.isPending ? 'Publishing…' : `Publish v${version.version}`}</button>
      ) : (
        <button type="button" className="primary" disabled={sign.isPending} onClick={() => sign.mutate()} title="Workers run signed packages only. This signs the draft with a key kept in this browser (or run azhi publish in the package folder).">{sign.isPending ? 'Signing…' : `Sign v${version.version}`}</button>
      )}
      {err ? <span className="error small" role="alert">{err.message}</span> : null}
    </>
  );
}

/** Inputs as stored to the strings the schema form edits. */
function toFormValues(inputs: Record<string, unknown> | undefined): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(inputs ?? {})) out[k] = typeof v === 'boolean' ? v : typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : typeof v === 'number' ? String(v) : JSON.stringify(v);
  return out;
}

export function ScheduleForm({ slug, schema, schedule }: { slug: string; schema?: JsonSchema; schedule?: ScheduleRow }) {
  const qc = useQueryClient();
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * 1');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [values, setValues] = useState(toFormValues(schedule?.inputs));
  const [formError, setFormError] = useState<string>();
  const save = useMutation({
    mutationFn: (inputs: Record<string, unknown>) => api<ScheduleRow>('/v1/schedules', { method: 'POST', body: { workflow: slug, cron: cron.trim(), timezone: timezone.trim(), inputs, enabled } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setFormError(undefined);
        try {
          save.mutate(formValues(schema, values));
        } catch (err) {
          setFormError((err as Error).message);
        }
      }}
    >
      <div className="fields">
        <div className="field"><label htmlFor="s-cron">Cron</label><input id="s-cron" className="mono" value={cron} onChange={(e) => setCron(e.target.value)} required /><span className="hint">Minute hour day month weekday, for example 0 9 * * 1 for Mondays at 09:00.</span></div>
        <div className="field"><label htmlFor="s-tz">Timezone</label><input id="s-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} required /></div>
        <div className="field inline"><input id="s-on" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><label htmlFor="s-on">On</label></div>
      </div>
      {schema?.properties && Object.keys(schema.properties).length ? <><h3 className="small">Inputs for each run</h3><SchemaFields schema={schema} values={values} onChange={setValues} idPrefix="s" /></> : null}
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>{schedule ? 'Save schedule' : 'Add schedule'}</button>
        {save.isSuccess ? <span className="ok-note">Saved. Next run {ago(save.data.next_occurrence_at)}.</span> : null}
      </div>
      {formError ? <div className="error">{formError}</div> : null}
      <ErrorNote error={save.error} />
      <p className="muted small">Each occurrence runs the latest published version. Publishing a version whose definition has a schedule trigger resets this to the definition's.</p>
    </form>
  );
}

interface DatasetDetail {
  name: string;
  trusted: boolean;
  acl: { roles?: string[]; users?: string[] };
  documents: Array<{ path: string; media_type: string; revoked: boolean; added_at: string; size: number | null; unpublished: boolean }>;
  revisions: Array<{ revision: number; documents: number; chunks: number; embedder: string; published_at: string; tags: string[] }>;
}

export function NewDataset({ onCreated }: { onCreated: (name: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [trusted, setTrusted] = useState(true);
  const create = useMutation({
    mutationFn: () => api('/v1/datasets', { method: 'POST', body: { name: name.trim(), trusted } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['datasets'] });
      onCreated(name.trim());
    },
  });
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <input aria-label="Dataset name" placeholder="name, for example runbooks" value={name} onChange={(e) => setName(e.target.value)} pattern="[a-z0-9][a-z0-9._\-]*" required />
      <label className="row"><input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} /> Trusted</label>
      <button type="submit" disabled={create.isPending}>Create dataset</button>
      <ErrorNote error={create.error} />
      {!trusted ? <span className="muted small">Untrusted content taints the agents that read it, so their writes need a gate.</span> : null}
    </form>
  );
}

export function DatasetPage({ name, canEdit }: { name: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dataset', name], queryFn: () => api<DatasetDetail>(`/v1/datasets/${encodeURIComponent(name)}`) });
  const input = useRef<HTMLInputElement>(null);
  const [tag, setTag] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['dataset', name] });
    void qc.invalidateQueries({ queryKey: ['datasets'] });
  };
  const add = useMutation({
    mutationFn: async (files: File[]) => api<{ documents: Array<{ path: string; changed: boolean }> }>(`/v1/datasets/${encodeURIComponent(name)}/documents`, { method: 'POST', body: { documents: await Promise.all(files.map(async (f) => ({ path: f.name, content: await f.text() }))) } }),
    onSuccess: () => {
      if (input.current) input.current.value = '';
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (path: string) => api(`/v1/datasets/${encodeURIComponent(name)}/documents?path=${encodeURIComponent(path)}`, { method: 'DELETE' }), onSuccess: refresh });
  const publish = useMutation({
    mutationFn: () => api<{ revision: number; documents: number; chunks: number }>(`/v1/datasets/${encodeURIComponent(name)}/publish`, { method: 'POST', body: tag.trim() ? { tag: tag.trim() } : {} }),
    onSuccess: () => {
      setTag('');
      refresh();
    },
  });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const pending = d.documents.filter((x) => x.unpublished).length;
  return (
    <>
      <PageHead title={d.name} sub={<>{d.trusted ? <Badge tone="ok">trusted</Badge> : <Badge tone="warn">untrusted</Badge>} Readable by {d.acl.roles?.length ? `role ${d.acl.roles.join(', ')} or higher` : 'listed users only'}. <Link to="/ui/datasets">All datasets</Link></>} />
      {canEdit ? (
        <Panel title="Add documents">
          <div className="row">
            <input ref={input} type="file" multiple accept=".md,.markdown,.txt,.text" aria-label="Documents" onChange={(e) => e.target.files?.length && add.mutate([...e.target.files])} />
            <span className="muted small">Markdown and plain text. A document with the same name is replaced.</span>
          </div>
          {add.data ? <p className="ok-note">{add.data.documents.filter((x) => x.changed).length} of {add.data.documents.length} changed. Publish to index them.</p> : null}
          <ErrorNote error={add.error ?? revoke.error} />
        </Panel>
      ) : null}
      <Panel title={`Documents (${d.documents.filter((x) => !x.revoked).length})`}>
        <Table head={['Document', 'Size', 'Added', 'State', '']} empty="No documents yet.">
          {d.documents.map((x) => (
            <tr key={x.path}>
              <td className="mono">{x.path}</td>
              <td>{x.size === null ? '—' : `${x.size.toLocaleString()} B`}</td>
              <td title={when(x.added_at)}>{ago(x.added_at)}</td>
              <td>{x.revoked ? <Badge tone="idle">revoked</Badge> : x.unpublished ? <Badge tone="warn">not published yet</Badge> : <Badge tone="ok">published</Badge>}</td>
              <td>{canEdit && !x.revoked ? <button type="button" className="small danger" disabled={revoke.isPending} onClick={() => confirm(`Revoke ${x.path}? It stops being retrievable at once, from every revision.`) && revoke.mutate(x.path)}>Revoke</button> : null}</td>
            </tr>
          ))}
        </Table>
      </Panel>
      <Panel title="Revisions">
        {canEdit ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); publish.mutate(); }}>
            <input aria-label="Tag" placeholder="tag (optional), for example approved" value={tag} onChange={(e) => setTag(e.target.value)} />
            <button type="submit" className="primary" disabled={publish.isPending || !d.documents.some((x) => !x.revoked)}>{publish.isPending ? 'Publishing…' : 'Publish a revision'}</button>
            {pending ? <span className="muted small">{pending} document(s) not in a revision yet.</span> : null}
            {publish.data ? <span className="ok-note">Published r{publish.data.revision}: {publish.data.documents} documents, {publish.data.chunks} chunks.</span> : null}
          </form>
        ) : null}
        <ErrorNote error={publish.error} />
        <Table head={['Revision', 'Documents', 'Chunks', 'Published', 'Tags']} empty="Nothing published yet.">
          {d.revisions.map((r) => (
            <tr key={r.revision}>
              <td>r{r.revision}</td>
              <td>{r.documents}</td>
              <td>{r.chunks}</td>
              <td title={when(r.published_at)}>{ago(r.published_at)}</td>
              <td>{r.tags.map((t) => <Badge key={t}>{t}</Badge>)}</td>
            </tr>
          ))}
        </Table>
        <p className="muted small">Runs pin a revision when they start; <span className="mono">{d.name}@approved</span> follows the approved tag.</p>
      </Panel>
    </>
  );
}

const TOOL_EXAMPLE = `{
  "id": "tracker.get-ticket",
  "version": 1,
  "description": "Read one ticket",
  "effect": "read",
  "input_schema": { "type": "object", "properties": { "key": { "type": "string" } }, "required": ["key"] },
  "output_schema": { "type": "object" },
  "transport": { "kind": "http", "method": "GET", "url": "https://tracker.example.com/api/tickets/{key}" }
}`;

/** Registers a tool, or changes one: the same id@version gets a new revision, audited, and runs pin the revision they started with. */
export function ToolForm({ from }: { from?: Record<string, unknown> }) {
  const qc = useQueryClient();
  const [text, setText] = useState(from ? JSON.stringify(from, null, 2) : TOOL_EXAMPLE);
  const [parseError, setParseError] = useState<string>();
  const register = useMutation({
    mutationFn: async (spec: { id: string; version: number }) => ({ ref: `${spec.id}@${spec.version}`, ...(await api<{ revision: number; changed: boolean }>('/v1/tools', { method: 'POST', body: spec })) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tools'] }),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setParseError(undefined);
        try {
          register.mutate(JSON.parse(text));
        } catch (err) {
          setParseError((err as Error).message);
        }
      }}
    >
      <textarea aria-label="Tool definition (JSON)" className="mono full" rows={14} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <p className="muted small">Credentials are named, never included: set <span className="mono">"credential": "secret-name"</span> and store the value on the Secrets page.</p>
      <div className="row">
        <button type="submit" className="primary" disabled={register.isPending}>Register tool</button>
        {register.isSuccess ? <span className="ok-note">{register.data.changed ? `Saved ${register.data.ref}, revision ${register.data.revision}.` : `No change to ${register.data.ref}.`}</span> : null}
      </div>
      {parseError ? <div className="error">Not valid JSON: {parseError}</div> : null}
      <ErrorNote error={register.error} />
    </form>
  );
}

interface RemoteConnection { id: string; name: string; url: string; auth_kind: 'none' | 'oauth'; status: string; oauth?: { connected: boolean } }
interface RemoteTool { name: string; description: string; input_schema: JsonSchema }

/** Guided registration keeps endpoints and OAuth tokens out of free-form tool JSON. */
export function McpForm() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'none' | 'oauth'>('none');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [tokenUrl, setTokenUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('');
  const [connection, setConnection] = useState<RemoteConnection>();
  const [tools, setTools] = useState<RemoteTool[]>([]);
  const [selected, setSelected] = useState('');
  const [toolId, setToolId] = useState('');
  const [effect, setEffect] = useState('read');
  const create = useMutation({
    mutationFn: () => api<RemoteConnection>('/v1/mcp/connections', { method: 'POST', body: { name, url, auth_kind: auth, ...(auth === 'oauth' ? { oauth: { authorization_url: authorizationUrl, token_url: tokenUrl, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), ...(scopes ? { scopes } : {}) } } : {}) } }),
    onSuccess: (r) => { setConnection(r); void qc.invalidateQueries({ queryKey: ['mcp-connections'] }); },
  });
  const connect = useMutation({ mutationFn: () => api<{ authorization_url: string }>(`/v1/mcp/connections/${connection!.id}/oauth/start`, { method: 'POST', body: {} }), onSuccess: (r) => window.open(r.authorization_url, '_blank', 'noopener') });
  const discover = useMutation({ mutationFn: () => api<RemoteTool[]>(`/v1/mcp/connections/${connection!.id}/tools`), onSuccess: (r) => { setTools(r); if (r[0]) choose(r[0]); } });
  const register = useMutation({
    mutationFn: () => {
      const remote = tools.find((t) => t.name === selected)!;
      return api(`/v1/mcp/connections/${connection!.id}/tools`, { method: 'POST', body: { id: toolId, version: 1, name: remote.name, description: remote.description || remote.name, effect, input_schema: remote.input_schema, output_schema: { type: 'object' } } });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tools'] }),
  });
  const choose = (tool: RemoteTool) => { setSelected(tool.name); setToolId(tool.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'remote-tool'); };
  return (
    <div className="fields">
      {!connection ? <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="fields">
          <div className="field"><label htmlFor="mcp-name">Connection name</label><input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="linear" pattern="[a-z0-9][a-z0-9._\-]*" required /></div>
          <div className="field"><label htmlFor="mcp-url">Streamable HTTP MCP URL</label><input id="mcp-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" required /></div>
          <div className="field"><label htmlFor="mcp-auth">Authentication</label><select id="mcp-auth" value={auth} onChange={(e) => setAuth(e.target.value as 'none' | 'oauth')}><option value="none">None</option><option value="oauth">OAuth 2.0</option></select></div>
          {auth === 'oauth' ? <>
            <div className="field"><label htmlFor="mcp-authorize">Authorization URL</label><input id="mcp-authorize" type="url" value={authorizationUrl} onChange={(e) => setAuthorizationUrl(e.target.value)} required /></div>
            <div className="field"><label htmlFor="mcp-token">Token URL</label><input id="mcp-token" type="url" value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} required /></div>
            <div className="field"><label htmlFor="mcp-client">Client ID</label><input id="mcp-client" value={clientId} onChange={(e) => setClientId(e.target.value)} required /></div>
            <div className="field"><label htmlFor="mcp-client-secret">Client secret</label><input id="mcp-client-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /><span className="hint">Stored encrypted; omit for public clients.</span></div>
            <div className="field"><label htmlFor="mcp-scopes">Scopes</label><input id="mcp-scopes" value={scopes} onChange={(e) => setScopes(e.target.value)} /></div>
          </> : null}
        </div>
        <button type="submit" className="primary" disabled={create.isPending}>Save connection</button><ErrorNote error={create.error} />
      </form> : <>
        <p><strong>{connection.name}</strong> is {connection.status}.</p>
        {connection.auth_kind === 'oauth' && connection.status !== 'ready' ? <div className="row"><button type="button" onClick={() => connect.mutate()} disabled={connect.isPending}>Connect with OAuth</button><span className="muted small">Complete authorization in the opened window, then discover tools.</span><ErrorNote error={connect.error} /></div> : null}
        <div className="row"><button type="button" onClick={() => discover.mutate()} disabled={discover.isPending}>Discover tools</button><ErrorNote error={discover.error} /></div>
        {tools.length ? <div className="fields"><div className="field"><label htmlFor="mcp-tool">MCP tool</label><select id="mcp-tool" value={selected} onChange={(e) => { const t = tools.find((x) => x.name === e.target.value); if (t) choose(t); }}>{tools.map((t) => <option key={t.name} value={t.name}>{t.name}{t.description ? ` — ${t.description}` : ''}</option>)}</select></div><div className="field"><label htmlFor="mcp-tool-id">Azhi tool ID</label><input id="mcp-tool-id" value={toolId} onChange={(e) => setToolId(e.target.value)} required /></div><div className="field"><label htmlFor="mcp-effect">Effect</label><select id="mcp-effect" value={effect} onChange={(e) => setEffect(e.target.value)}><option>read</option><option>write-idempotent</option><option>write-dedupable</option><option>write-unsafe</option></select></div><button type="button" className="primary" onClick={() => register.mutate()} disabled={register.isPending}>Register selected tool</button><ErrorNote error={register.error} />{register.isSuccess ? <span className="ok-note">Tool registered. It is now available in workflow tool dropdowns.</span> : null}</div> : null}
      </>}
    </div>
  );
}
