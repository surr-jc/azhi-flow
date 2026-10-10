import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, atLeast, type WorkflowSummary } from '../api';
import { useMe } from '../App';
import { Icon } from '../icons';
import { Badge, ErrorNote, Loading, PageHead, Panel } from '../ui';
import { DefinitionSummary, HarnessGuides, NeedList, type Guide, type Need } from '../components/LibraryParts';
import { McpWizard } from './McpWizard';

export type Kind = 'mcp' | 'agent' | 'skill' | 'command';
type Asset = { id: string; kind: Kind; slug: string; name: string; description: string; status: string; current_version: number; definition?: Record<string, any>; version_id?: string };
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
  const [kind, setKind] = useState<Kind>('skill');
  const [view, setView] = useState<'discover' | 'mine'>('discover');
  const [adding, setAdding] = useState(false);
  const canEdit = atLeast(me.data?.role, 'author');
  const assets = useQuery({ queryKey: ['portable-assets'], queryFn: () => api<Asset[]>('/v1/assets') });
  const counts = useMemo(() => Object.fromEntries((['mcp', 'agent', 'skill', 'command'] as Kind[]).map((k) => [k, assets.data?.filter((a) => a.kind === k && a.status !== 'archived').length ?? 0])) as Record<Kind, number>, [assets.data]);
  const k = KINDS[kind];
  return (
    <>
      <PageHead title="Library" sub="Reusable parts for harness agents (OpenCode, Claude Code): MCP servers, agents, skills and commands. Find them in live marketplaces or write your own, review and publish, then attach them to a workflow." />
      <div className="lib-kinds" role="tablist" aria-label="Kind">
        {(Object.keys(KINDS) as Kind[]).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={kind === key} className={`lib-kind${kind === key ? ' on' : ''}`} onClick={() => { setKind(key); setAdding(false); }}>
            <span className="lib-kind-ico"><Icon name={KINDS[key].icon} size={20} /></span>
            <span><b>{KINDS[key].label}</b><span className="muted small">{counts[key]} in your library</span></span>
          </button>
        ))}
      </div>
      <div className="lib-purpose">
        <p><b>What is this for?</b> {k.purpose} <span className="muted">{k.example}</span></p>
        <p className="muted small">{HARNESS_NOTE} Tool steps and model agents use <a href="/ui/tools">gateway tools</a> instead.</p>
      </div>
      <div className="lib-bar">
        <div className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={view === 'discover'} onClick={() => setView('discover')}>Discover</button>
          <button type="button" aria-pressed={view === 'mine'} onClick={() => setView('mine')}>My library ({counts[kind]})</button>
        </div>
        {canEdit ? <button type="button" className="primary" onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : kind === 'mcp' ? 'Add an MCP server' : `Write a ${k.one}`}</button> : null}
      </div>
      {adding ? (kind === 'mcp' ? <McpWizard onDone={() => { setAdding(false); setView('mine'); }} onBrowse={() => { setAdding(false); setView('discover'); }} /> : <WriteForm kind={kind} onDone={() => { setAdding(false); setView('mine'); }} />)
        : view === 'discover' ? <Discover kind={kind} canEdit={canEdit} onImported={() => setView('mine')} /> : <Mine kind={kind} assets={assets.data} error={assets.error} canEdit={canEdit} />}
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
      <p className="muted small lib-sources">Searching: {sources.length ? sources.map((s) => s.name).join(', ') : '…'}. Results come live from each marketplace. Nothing runs and nothing is saved until you import.</p>
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
      {done ? <p className="ok-note" role="status">Imported as a draft. Review it in <b>My library</b>, set anything it needs, then publish it. <button type="button" className="linkish" onClick={onImported}>Open My library</button></p> : canEdit ? (
        <div className="row"><button type="button" className="primary" disabled={imp.isPending} onClick={() => imp.mutate()}>{imp.isPending ? 'Importing…' : 'Import as draft'}</button><span className="muted small">Imported content is untrusted until an author publishes it.</span></div>
      ) : <p className="muted small">An author can import this.</p>}
      <ErrorNote error={imp.error} />
    </div>
  );
}

// ---- My library -----------------------------------------------------------------------------------------------------
function Mine({ kind, assets, error, canEdit }: { kind: Kind; assets?: Asset[]; error: unknown; canEdit: boolean }) {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<string | null>(null);
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['portable-assets'] });
  const publish = useMutation({ mutationFn: (id: string) => api(`/v1/assets/${id}/publish`, { method: 'POST' }), onSuccess: refresh });
  const archive = useMutation({ mutationFn: (id: string) => api(`/v1/assets/${id}/archive`, { method: 'POST' }), onSuccess: refresh });
  const attach = useMutation({ mutationFn: ({ slug, id }: { slug: string; id: string }) => api(`/v1/workflows/${encodeURIComponent(slug)}/assets`, { method: 'POST', body: { asset_id: id } }) });
  const shown = assets?.filter((a) => a.kind === kind && a.status !== 'archived') ?? [];
  return (
    <>
      <ErrorNote error={error ?? publish.error ?? archive.error ?? attach.error} />
      {!assets ? <Loading /> : !shown.length ? <p className="muted lib-empty">Nothing in your {KINDS[kind].label.toLowerCase()} library yet. Use <b>Discover</b> to import one, or write your own.</p> : null}
      <div className="lib-list">
        {shown.map((a) => {
          const prov = a.definition?.provenance as { source: string; url: string; sha256: string } | undefined;
          const needs = (a.definition?.needs ?? []) as Need[];
          return (
            <article key={a.id} className="lib-row">
              <div className="lib-row-main">
                <h3>{a.name} <span className="muted small mono">{a.slug} · v{a.current_version}</span></h3>
                {a.description ? <p className="lib-desc">{a.description}</p> : null}
                <p className="small">
                  <Badge tone={a.status === 'published' ? 'ok' : 'warn'}>{a.status === 'published' ? 'published' : 'draft: review, then publish'}</Badge>{' '}
                  {a.definition?.transport === 'local' ? <Badge tone="warn">runs on a worker</Badge> : null}{' '}
                  {prov ? <span className="muted">Imported from <a href={prov.url} target="_blank" rel="noreferrer noopener">{prov.source.split('::')[0]}</a>, hash <span className="mono">{prov.sha256.slice(0, 8)}</span></span> : null}
                </p>
                {needs.length ? <details><summary className="small">Needs {needs.length} value{needs.length === 1 ? '' : 's'} before it works</summary><NeedList needs={needs} /></details> : null}
              </div>
              <div className="lib-row-actions">
                <button type="button" onClick={() => setSetup(setup === a.id ? null : a.id)} aria-expanded={setup === a.id}>Use in a harness</button>
                {canEdit && a.status !== 'published' ? <button type="button" className="primary" onClick={() => publish.mutate(a.id)}>Publish</button> : null}
                {a.status === 'published' && workflows.data?.length ? <select aria-label={`Attach ${a.name}`} defaultValue="" onChange={(e) => { if (e.target.value) attach.mutate({ slug: e.target.value, id: a.id }); e.currentTarget.value = ''; }}><option value="">Attach to workflow…</option>{workflows.data.map((w) => <option value={w.slug} key={w.slug}>{w.slug}</option>)}</select> : null}
                {canEdit ? <button type="button" onClick={() => archive.mutate(a.id)}>Archive</button> : null}
              </div>
              {setup === a.id ? <AssetGuides id={a.id} /> : null}
            </article>
          );
        })}
      </div>
    </>
  );
}
function AssetGuides({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['harness-guides', id], queryFn: () => api<Guide[]>(`/v1/assets/${id}/harness-guides`) });
  if (q.error) return <ErrorNote error={q.error} />;
  return q.data ? <div className="lib-row-wide"><HarnessGuides guides={q.data} /></div> : <Loading />;
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
