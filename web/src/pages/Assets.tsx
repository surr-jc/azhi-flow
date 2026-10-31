import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, atLeast } from '../api';
import { useMe } from '../App';
import { Icon } from '../icons';
import { Badge, ErrorNote, Loading, PageHead, Panel } from '../ui';
import { DefinitionSummary, HarnessGuides, NeedList, type Guide, type Need } from '../components/LibraryParts';
import { useRoute } from '../router';
import { McpWizard } from './McpWizard';

export type Kind = 'mcp' | 'agent' | 'skill' | 'command';
type Asset = { id: string; kind: Kind; slug: string; name: string; description: string; status: string; current_version: number; scope?: 'global' | 'project'; project_workflow?: string | null; definition?: Record<string, any>; version_id?: string };
type Item = { id: string; source: string; source_name: string; kind: Kind; slug: string; name: string; description: string; version?: string; homepage?: string; author?: string; category?: string; group?: string; runs_code?: boolean; unsupported?: string };
type Resolved = { item: Item; definition: Record<string, any>; needs: Need[]; warnings: string[]; provenance: { source: string; url: string; sha256: string; fetched_at: string }; guides: Guide[] };
type Search = { items: Item[]; next_cursor?: string; warnings: Array<{ source: string; message: string }>; sources: Array<{ id: string; name: string }>; disabled?: boolean };
type MarketConfig = { enabled: boolean; sources: Array<{ repo: string; ref: string }>; sources_all: Array<{ id: string; name: string; description: string; builtin: boolean; kinds: Kind[] }>; github_token_set: boolean };

export const KINDS: Record<Kind, { label: string; one: string; icon: string; purpose: string; example: string }> = {
  mcp: { label: 'MCP servers', one: 'MCP server', icon: 'tool', purpose: 'Give a harness agent new tools to call: GitHub, a database, your docs, a browser. The server runs on a worker, or is hosted somewhere else.', example: 'For example: GitHub, Postgres, Sentry, a docs search.' },
  agent: { label: 'Agents', one: 'agent', icon: 'agent', purpose: 'A specialist with its own prompt that the main agent can hand work to.', example: 'For example: a security reviewer, a test writer, a debugger.' },
  skill: { label: 'Skills', one: 'skill', icon: 'retrieve', purpose: 'Instructions an agent loads only when a task matches, so they cost no tokens until they are needed.', example: 'For example: how to work with PDFs, your release checklist, a design system.' },
  command: { label: 'Commands', one: 'command', icon: 'script', purpose: 'A saved prompt you run by name, with arguments.', example: 'For example: /review-pr 482, /write-release-notes.' },
};
const HARNESS_NOTE = 'Works in OpenCode and Claude Code. Azhi exports the files for each.';

function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function Assets() {
  const me = useMe();
  const { navigate } = useRoute();
  const [kind, setKind] = useState<Kind>('skill');
  const [adding, setAdding] = useState(false);
  const canEdit = atLeast(me.data?.role, 'author');
  const assets = useQuery({ queryKey: ['portable-assets'], queryFn: () => api<Asset[]>('/v1/assets') });
  const counts = useMemo(() => Object.fromEntries((['mcp', 'agent', 'skill', 'command'] as Kind[]).map((k) => [k, assets.data?.filter((a) => a.kind === k && a.status !== 'archived').length ?? 0])) as Record<Kind, number>, [assets.data]);
  const k = KINDS[kind];
  // Installed items are managed in the Toolbox; the Library only finds and installs them.
  const toToolbox = () => navigate('/ui/toolbox');
  return (
    <>
      <PageHead title="Library" sub="Find MCP servers, agents, skills and commands in live marketplaces and install them. Installed items appear in the Toolbox, where you review, edit, publish and attach them to workflows." />
      <div className="lib-kinds" role="tablist" aria-label="Kind">
        {(Object.keys(KINDS) as Kind[]).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={kind === key} className={`lib-kind${kind === key ? ' on' : ''}`} onClick={() => { setKind(key); setAdding(false); }}>
            <span className="lib-kind-ico"><Icon name={KINDS[key].icon} size={20} /></span>
            <span><b>{KINDS[key].label}</b><span className="muted small">{counts[key]} installed</span></span>
          </button>
        ))}
      </div>
      <div className="lib-purpose">
        <p><b>What is this for?</b> {k.purpose} <span className="muted">{k.example}</span></p>
        <p className="muted small">{HARNESS_NOTE}</p>
      </div>
      {canEdit ? <div className="lib-bar"><button type="button" className="primary" onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : kind === 'mcp' ? 'Add an MCP server' : `Write a ${k.one}`}</button></div> : null}
      {adding ? (kind === 'mcp' ? <McpWizard onDone={toToolbox} onBrowse={() => setAdding(false)} /> : <WriteForm kind={kind} onDone={toToolbox} />)
        : <Discover kind={kind} canEdit={canEdit} onImported={toToolbox} />}
    </>
  );
}

// ---- Discover: live marketplaces ----------------------------------------------------------------------------------
function Discover({ kind, canEdit, onImported }: { kind: Kind; canEdit: boolean; onImported: () => void }) {
  const me = useMe();
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q);
  const res = useInfiniteQuery({
    queryKey: ['market', kind, dq, source],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Search>(`/v1/marketplace/search?kind=${kind}&q=${encodeURIComponent(dq)}${source ? `&source=${encodeURIComponent(source)}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 60_000,
  });
  const pages = res.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const warnings = [...new Map(pages.flatMap((p) => p.warnings).map((w) => [`${w.source}${w.message}`, w])).values()];
  const sources = pages[0]?.sources ?? [];
  return (
    <>
      <div className="lib-search">
        <label className="lib-q"><Icon name="search" size={18} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${kind === 'mcp' ? 'MCP servers' : KINDS[kind].label.toLowerCase()} in live marketplaces`} aria-label={`Search ${KINDS[kind].label}`} autoComplete="off" /></label>
        {sources.length > 1 ? <select aria-label="Marketplace" value={source} onChange={(e) => setSource(e.target.value)}><option value="">All marketplaces</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select> : null}
      </div>
      <p className="muted small lib-sources">Searching: {sources.length ? (source ? sources.filter((s) => s.id === source) : sources).map((s) => s.name).join(', ') : '…'}. Results come live from each marketplace. Nothing runs and nothing is saved until you import.</p>
      {pages[0]?.disabled ? <div className="update-note" role="status">The marketplace is turned off for this workspace. An admin can turn it on below.</div> : null}
      {warnings.map((w) => <div key={w.source + w.message} className="update-note" role="status"><b>{sources.find((x) => x.id === w.source)?.name ?? w.source}:</b> {w.message}</div>)}
      <ErrorNote error={res.error} />
      {res.isLoading ? <Loading /> : null}
      {!res.isLoading && !items.length && !pages[0]?.disabled ? <p className="muted lib-empty">Nothing matches{dq ? ` “${dq}”` : ''}. Try a shorter or more general word{kind === 'agent' || kind === 'command' ? '. Agents and commands come from GitHub plugin marketplaces; if none are listed, the server may not be able to list GitHub repositories (see the note above)' : ''}.</p> : null}
      <div className="lib-grid">
        {items.map((it) => (
          <article key={it.id} className={`lib-card${open === it.id ? ' open' : ''}`}>
            <header><h3>{it.name}</h3>{it.runs_code ? <Badge tone="warn">runs on a worker</Badge> : it.kind === 'mcp' ? <Badge tone="ok">hosted</Badge> : null}</header>
            <p className="lib-desc">{it.description || <span className="muted">No description.</span>}</p>
            <p className="muted small">{it.source_name}{it.group && it.group !== it.name ? ` · ${it.group}` : ''}{it.version ? ` · v${it.version}` : ''}{it.author ? ` · ${it.author}` : ''}</p>
            <div className="row">
              <button type="button" onClick={() => setOpen(open === it.id ? null : it.id)} aria-expanded={open === it.id}>{open === it.id ? 'Hide' : 'Preview'}</button>
              {it.homepage ? <a href={it.homepage} target="_blank" rel="noreferrer noopener" className="small">Source</a> : null}
              {it.unsupported ? <span className="muted small">Cannot import: {it.unsupported}</span> : null}
            </div>
            {open === it.id ? <Preview id={it.id} canEdit={canEdit && !it.unsupported} onImported={onImported} /> : null}
          </article>
        ))}
      </div>
      {res.hasNextPage ? <p><button type="button" disabled={res.isFetchingNextPage} onClick={() => void res.fetchNextPage()}>{res.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></p> : null}
      {atLeast(me.data?.role, 'admin') ? <MarketSettings /> : null}
    </>
  );
}

function Preview({ id, canEdit, onImported }: { id: string; canEdit: boolean; onImported: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['market-item', id], queryFn: () => api<Resolved>(`/v1/marketplace/item?id=${encodeURIComponent(id)}`), staleTime: 5 * 60_000 });
  const [done, setDone] = useState<{ warnings: string[] }>();
  const imp = useMutation({ mutationFn: () => api<{ warnings: string[] }>('/v1/marketplace/import', { method: 'POST', body: { id } }), onSuccess: (r) => { setDone(r); void qc.invalidateQueries({ queryKey: ['portable-assets'] }); } });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const r = q.data; const d = r.definition;
  return (
    <div className="lib-preview">
      <h4>What you would get</h4>
      {r.item.kind === 'mcp' ? <DefinitionSummary d={d} /> : <pre className="code lib-text">{String(d.instructions ?? d.prompt ?? d.template ?? '').slice(0, 4000)}{String(d.instructions ?? d.prompt ?? d.template ?? '').length > 4000 ? '\n…' : ''}</pre>}
      {r.needs.length ? <><h4>You will need to provide</h4><NeedList needs={r.needs} /></> : null}
      {r.warnings.length ? <ul className="lib-warn">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      <p className="muted small">Source: <a href={r.provenance.url} target="_blank" rel="noreferrer noopener">{r.provenance.url}</a>. Content hash <span className="mono">{r.provenance.sha256.slice(0, 12)}</span> is recorded on import.</p>
      <HarnessGuides guides={r.guides} />
      {done ? <p className="ok-note" role="status">Installed as a draft. Open it in the <b>Toolbox</b> to review it, set anything it needs, then publish it. <button type="button" className="linkish" onClick={onImported}>Open the Toolbox</button></p> : canEdit ? (
        <div className="row"><button type="button" className="primary" disabled={imp.isPending} onClick={() => imp.mutate()}>{imp.isPending ? 'Installing…' : 'Install as draft'}</button><span className="muted small">Installed content is untrusted until an author publishes it.</span></div>
      ) : <p className="muted small">An author can install this.</p>}
      <ErrorNote error={imp.error} />
    </div>
  );
}

// ---- write your own agent, skill or command ---------------------------------------------------------------------------
const TEMPLATES: Record<Exclude<Kind, 'mcp'>, { field: string; label: string; help: string; placeholder: string; key: string }> = {
  agent: { field: 'prompt', key: 'prompt', label: 'Prompt', help: 'Who the agent is and how it works. It starts fresh each time, so say everything it needs.', placeholder: 'You are a careful security reviewer. Read the change, look for injection and auth bugs, and explain each finding with the file and line.' },
  skill: { field: 'instructions', key: 'instructions', label: 'Instructions', help: 'Written for the agent: when to use this skill and what to do. Keep it short; it loads only when the description matches the task.', placeholder: '## When to use\n\nUse this when the task is to prepare release notes.\n\n## Steps\n\n1. List merged pull requests since the last tag.\n2. Group them by type.' },
  command: { field: 'template', key: 'template', label: 'Prompt template', help: 'The prompt that runs. $ARGUMENTS is replaced by what you type after the command name.', placeholder: 'Review $ARGUMENTS and report the important findings.' },
};
function WriteForm({ kind, onDone }: { kind: Exclude<Kind, 'mcp'>; onDone: () => void }) {
  const qc = useQueryClient();
  const t = TEMPLATES[kind];
  const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [description, setDescription] = useState(''); const [text, setText] = useState('');
  const save = useMutation({
    mutationFn: () => api('/v1/assets', { method: 'POST', body: { kind, name, slug, description, definition: { description, ...(kind === 'agent' ? { mode: 'subagent' } : {}), [t.key]: text } } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['portable-assets'] }); onDone(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  return (
    <Panel title={`Write a ${KINDS[kind].one}`}>
      <form onSubmit={submit} className="lib-form">
        <label>Name<input required value={name} onChange={(e) => { setName(e.target.value); if (!slug || slug === kebab(name)) setSlug(kebab(e.target.value)); }} /></label>
        <label>Short name<input required pattern="[a-z0-9][a-z0-9\-]*" value={slug} onChange={(e) => setSlug(e.target.value)} /><span className="muted small">Lowercase letters, numbers and hyphens. It becomes the file name.</span></label>
        <label className="wide">When should it be used?<span className="muted small">One sentence. Harnesses use it to decide when to pick this {KINDS[kind].one}.</span><input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="wide">{t.label}<span className="muted small">{t.help}</span><textarea className="mono" rows={10} required value={text} placeholder={t.placeholder} onChange={(e) => setText(e.target.value)} /></label>
        <div className="wide row"><button className="primary" disabled={save.isPending}>Save draft</button><span className="muted small">You review and publish it next.</span></div>
        <ErrorNote error={save.error} />
      </form>
    </Panel>
  );
}
const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- admin: which marketplaces are searched ------------------------------------------------------------------------------
function MarketSettings() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ['market-config'], queryFn: () => api<MarketConfig>('/v1/marketplace/config') });
  const [repo, setRepo] = useState('');
  const save = useMutation({
    mutationFn: (b: { enabled: boolean; sources: Array<{ repo: string; ref: string }> }) => api('/v1/marketplace/config', { method: 'PUT', body: b }),
    onSuccess: () => { setRepo(''); void qc.invalidateQueries({ queryKey: ['market-config'] }); void qc.invalidateQueries({ queryKey: ['market'] }); },
  });
  if (!cfg.data) return null;
  const c = cfg.data;
  const extra = c.sources;
  return (
    <details className="lib-admin">
      <summary>Manage marketplaces (admin)</summary>
      <label className="row"><input type="checkbox" checked={c.enabled} onChange={(e) => save.mutate({ enabled: e.target.checked, sources: extra })} /> Allow this server to search live marketplaces. Turn it off on air-gapped installs.</label>
      <ul className="lib-needs">{c.sources_all.map((s) => <li key={s.id}><b>{s.name}</b> <span className="muted small">{s.kinds.join(', ')} · {s.description}</span>{!s.builtin ? <button type="button" className="small" onClick={() => save.mutate({ enabled: c.enabled, sources: extra.filter((e) => `gh:${e.repo}` !== s.id) })}>Remove</button> : null}</li>)}</ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); save.mutate({ enabled: c.enabled, sources: [...extra, { repo: repo.trim(), ref: 'main' }] }); }}>
        <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo with .claude-plugin/marketplace.json" aria-label="GitHub repository" pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+" required />
        <button type="submit" disabled={save.isPending}>Add marketplace</button>
      </form>
      {!c.github_token_set ? <p className="muted small">GitHub lists plugin contents through its API, which allows 60 requests an hour without a token. If agents and commands are missing from results, set <code>AZHI_GITHUB_TOKEN</code> on the server.</p> : null}
      <ErrorNote error={save.error} />
    </details>
  );
}
