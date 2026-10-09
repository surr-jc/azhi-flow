import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { api, atLeast } from '../api';
import { useMe } from '../App';
import { Link, useRoute } from '../router';
import { signVersion } from '../signing';
import { CopilotLogin } from '../components/CopilotLogin';
import { Popup } from '../components/Popup';
import { RepoList } from '../components/RepoAccess';
import { StepPanel } from '../components/StepDrawer';
import { WorkflowCanvas } from '../components/WorkflowCanvas';
import { graphOf } from '../graph';
import type { ToolInfo } from '../stepHelp';
import { Badge, ErrorNote, Loading, PageHead, Panel } from '../ui';

/**
 * The example workflows that ship with the server, set up in one step (the twin of
 * `azhi example install`): the example's tools are registered with the repositories named here,
 * its package is saved as a draft and signed in this browser, and its secrets are set below.
 */
interface Secret { name: string; set: boolean }
interface Setting { name: string; title?: string; description?: string; placeholder?: string; value: string | null }
interface Example {
  id: string;
  name: string;
  description: string;
  tools: Array<{ ref: string; effect: string; description: string; needs_repos: boolean }>;
  needs_repos: boolean;
  secrets: Secret[];
  /** Repositories the installed tools allow now; empty before install. */
  repos: string[];
  settings?: Setting[];
  /** The workflow's steps as written, for looking at it before installing. */
  nodes?: Array<Record<string, any> & { id: string; type: string }>;
  /** The workflow this installs, and whether the marketplace has changed since it was installed or last updated. */
  workflow?: string;
  update?: { available: boolean; tracked: boolean; version: number; draft: boolean; updated_at: string | null } | null;
}
interface MergeChange { scope: 'step' | 'workflow' | 'file'; target: string; field?: string; kind: 'updated' | 'added' | 'removed' | 'conflict'; detail?: string }
interface UpdateResult {
  ok: boolean;
  dry_run?: boolean;
  updated?: boolean;
  diagnostics?: Diagnostic[];
  version?: { id: string; workflow: string; version: number; draft: boolean };
  report: { changes: MergeChange[]; kept: number; reformatted: boolean; tracked: boolean; nothing_to_update: boolean; summary: { updated: number; added: number; removed: number; conflicts: number; kept: number }; tools: Array<{ ref: string; kind: string }> };
  settings: Setting[];
  signError?: string;
}
interface Diagnostic { severity: string; message: string; node?: string }
interface Installed {
  ok: boolean;
  diagnostics: Diagnostic[];
  version?: { id: string; workflow: string; version: number };
  tools: Array<{ ref: string; revision: number; changed: boolean }>;
  secrets?: Secret[];
  settings?: Setting[];
  signError?: string;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** What the marketplace knows about a bundled workflow beyond what the server lists. */
const META: Record<string, { category: string; steps: number; works_with: string[]; featured?: boolean }> = {
  'quality-report': { category: 'Reports', steps: 7, works_with: ['Slack'], featured: true },
  'pr-review': { category: 'Code review', steps: 12, works_with: ['GitHub', 'Slack', 'OpenCode'] },
  sdlc: { category: 'Delivery', steps: 15, works_with: ['Jira or GitHub', 'Slack', 'OpenCode'] },
  'ai-sdlc': { category: 'Delivery', steps: 39, works_with: ['Jira or GitHub', 'Slack', 'OpenCode'] },
  'issue-investigation': { category: 'Investigation', steps: 6, works_with: ['GitHub', 'OpenCode'] },
  'ci-digest': { category: 'Reports', steps: 4, works_with: [] },
  doubler: { category: 'Learn Azhi', steps: 1, works_with: [] },
  caller: { category: 'Learn Azhi', steps: 2, works_with: [] },
  'loop-demo': { category: 'Learn Azhi', steps: 1, works_with: [] },
};
const metaOf = (e: Example) => META[e.id] ?? { category: 'Other', steps: 0, works_with: [] };

/** What an install lets the workflow change, read from its tools' effects. */
function changes(e: Example): { label: string; tone: 'ok' | 'warn' } {
  const writes = e.tools.filter((t) => t.effect !== 'read');
  return writes.length ? { label: `can change ${[...new Set(writes.map((t) => t.ref.split('.')[0]))].join(', ')}`, tone: 'warn' } : { label: 'read-only', tone: 'ok' };
}

/** The step count comes from the workflow itself; the table is only a fallback. */
const stepCount = (e: Example) => e.nodes?.length || metaOf(e).steps;

const installed = (e: Example) => e.repos.length > 0 || (e.settings ?? []).some((s) => s.value);

export function Examples() {
  const { path } = useRoute();
  const q = useQuery({ queryKey: ['examples'], queryFn: () => api<Example[]>('/v1/examples') });
  const id = path.startsWith('/ui/examples/') ? decodeURIComponent(path.slice('/ui/examples/'.length)) : undefined;
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [look, setLook] = useState<string>();
  const all = q.data ?? [];
  const one = id ? all.find((e) => e.id === id) : undefined;
  if (id) {
    return (
      <>
        <p className="small"><Link to="/ui/examples">← Marketplace</Link></p>
        <ErrorNote error={q.error} />
        {!q.data ? <Loading /> : one ? <ExampleDetail example={one} /> : <p className="muted">This server has no workflow named {id}.</p>}
      </>
    );
  }
  const categories = [...new Set(all.map((e) => metaOf(e).category))].sort();
  const term = search.trim().toLowerCase();
  const shown = all.filter((e) => (!category || metaOf(e).category === category) && (!term || `${e.name} ${e.description} ${e.id}`.toLowerCase().includes(term)));
  const featured = !term && !category ? shown.find((e) => metaOf(e).featured) : undefined;
  return (
    <>
      <PageHead title="Marketplace" sub="Ready-made workflows bundled with Azhi. Installing one registers its tools, saves it as a signed draft and lists the secrets it needs. You can open any of them in the editor and change it." />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : all.length === 0 ? <p className="muted">This server has no bundled workflows.</p> : (
        <>
          <div className="filters">
            <input type="search" aria-label="Search workflows" placeholder="Search workflows" value={search} onChange={(x) => setSearch(x.target.value)} />
            <div className="row wrap" role="group" aria-label="Category">
              {['', ...categories].map((c) => (
                <button key={c || 'all'} type="button" className={`small${category === c ? ' primary' : ''}`} aria-pressed={category === c} onClick={() => setCategory(c)}>{c || 'All'}</button>
              ))}
            </div>
          </div>
          {featured ? <MarketCard example={featured} featured onLook={() => setLook(featured.id)} /> : null}
          <div className="market-grid">
            {shown.filter((e) => e !== featured).map((e) => <MarketCard key={e.id} example={e} onLook={() => setLook(e.id)} />)}
          </div>
          {shown.length === 0 ? <p className="muted">No workflow matches. <Link to="/ui/workflows/new">Describe it to Build with chat</Link> instead.</p> : null}
          {look && all.find((x) => x.id === look) ? <QuickLook example={all.find((x) => x.id === look)!} onClose={() => setLook(undefined)} /> : null}
        </>
      )}
    </>
  );
}

function MarketCard({ example: e, featured, onLook }: { example: Example; featured?: boolean; onLook?: () => void }) {
  const m = metaOf(e);
  const c = changes(e);
  return (
    <article className={`market-card${featured ? ' featured' : ''}`}>
      <div className="small muted">{featured ? 'Start here · ' : ''}{m.category}{installed(e) ? <> · <span className="ok-text">Installed</span></> : null}</div>
      <h3><Link to={`/ui/examples/${encodeURIComponent(e.id)}`}>{e.name}</Link></h3>
      <p className="small muted">{e.description}</p>
      <div className="row wrap">
        {stepCount(e) ? <span className="chip-effect">{stepCount(e)} step{stepCount(e) === 1 ? '' : 's'}</span> : null}
        {m.works_with.length ? <span className="chip-effect">{m.works_with.join(' · ')}</span> : null}
        <span className={`chip-effect ${c.tone}`}>{c.label}</span>
        {e.secrets.length === 0 ? <span className="chip-effect ok">no secrets needed</span> : null}
      </div>
      <div className="row">
        <Link to={`/ui/examples/${encodeURIComponent(e.id)}`} className="button primary small">{installed(e) ? 'Open' : 'Install'}</Link>
        {e.nodes?.length && onLook ? <button type="button" className="small" onClick={onLook}>Quick look</button> : null}
      </div>
    </article>
  );
}

/**
 * A bundled workflow's real steps on the canvas, each explained in the same panel the workflow
 * page uses, with what it changes and what must be set up first beside it.
 */
function ExampleSteps({ example: e, height = 380 }: { example: Example; height?: number }) {
  const nodes = useMemo(() => graphOf({ nodes: e.nodes ?? [] }), [e]);
  const tools: ToolInfo[] = e.tools.map((t) => ({ id: t.ref.split('@')[0]!, version: Number(t.ref.split('@')[1]), effect: t.effect, description: t.description }));
  const [selected, setSelected] = useState<string | null>(null);
  const step = nodes.find((n) => n.id === selected);
  const c = changes(e);
  const todo = [
    ...(e.needs_repos && !e.repos.length ? [{ label: 'Repositories to allow', ok: false }] : []),
    ...(e.settings ?? []).map((s) => ({ label: s.title ?? s.name, ok: Boolean(s.value) })),
    ...e.secrets.map((s) => ({ label: s.name, ok: s.set })),
  ];
  return (
    <div className="quicklook">
      <div>
        <WorkflowCanvas nodes={nodes} height={height} select={{ selected, onSelect: setSelected }} />
      </div>
      {step ? (
        <StepPanel node={step} nodes={nodes} tools={tools} onPick={setSelected} onClose={() => setSelected(null)} />
      ) : (
        <aside className="quicklook-side">
          <div><span className="label">It changes</span><p className="small"><Badge tone={c.tone}>{c.label}</Badge></p></div>
          <div>
            <span className="label">{installed(e) ? 'Set up' : 'Before you install'}</span>
            {todo.length ? <ul className="small quicklook-todo">{todo.map((t) => <li key={t.label}><Badge tone={t.ok ? 'ok' : 'warn'}>{t.ok ? 'set' : 'needed'}</Badge> {t.label}</li>)}</ul> : <p className="muted small">Nothing to set up.</p>}
          </div>
          <p className="muted small">Select a step on the canvas to read what it does and every setting.</p>
        </aside>
      )}
    </div>
  );
}

/** A bundled workflow looked at before installing, in a popup over the marketplace. */
function QuickLook({ example: e, onClose }: { example: Example; onClose: () => void }) {
  return (
    <Popup title={e.name} sub={`${metaOf(e).category} · ${stepCount(e)} steps`} size="full" onClose={onClose} footer={<div className="row"><span className="muted small">Installing registers {e.tools.length} tool{e.tools.length === 1 ? '' : 's'} and saves a signed draft. Nothing else changes.</span><Link to={`/ui/examples/${encodeURIComponent(e.id)}`} className="button primary" style={{ marginLeft: 'auto' }}>{installed(e) ? 'Open' : 'Set up and install'}</Link></div>}>
      {e.description ? <p className="ed-sentence">{e.description}</p> : null}
      <ExampleSteps example={e} />
    </Popup>
  );
}

const KIND_LABEL: Record<MergeChange['kind'], string> = { added: 'New from the marketplace', updated: 'Changed by the marketplace', removed: 'Removed by the marketplace', conflict: 'Changed in both places: yours is kept' };
const where = (c: MergeChange) => (c.scope === 'step' ? `step ${c.target}${c.field ? `, ${c.field}` : ''}` : c.scope === 'file' ? c.target : c.field ?? 'workflow');

/**
 * What an update from the marketplace would change, before it does: new and changed steps and
 * files are brought in, your own edits stay, and anything changed in both places is listed with
 * your value kept. Applying makes a new draft version, signed in this browser.
 */
function UpdateReview({ example: e, onClose }: { example: Example; onClose: () => void }) {
  const qc = useQueryClient();
  const [newSettings, setNewSettings] = useState<Record<string, string>>({});
  const preview = useQuery({ queryKey: ['example-update', e.id], queryFn: () => api<UpdateResult>(`/v1/examples/${encodeURIComponent(e.id)}/update`, { method: 'POST', body: { dry_run: true } }), staleTime: 0, refetchOnWindowFocus: false });
  const apply = useMutation({
    mutationFn: async (): Promise<UpdateResult> => {
      const filled = Object.fromEntries(Object.entries(newSettings).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      const r = await api<UpdateResult>(`/v1/examples/${encodeURIComponent(e.id)}/update`, { method: 'POST', body: { ...(Object.keys(filled).length ? { settings: filled } : {}) } });
      if (!r.ok || !r.version || !r.updated) return r;
      try {
        await signVersion(r.version.id);
      } catch (err) {
        return { ...r, signError: (err as Error).message };
      }
      return r;
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['examples'] });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['tools'] });
      if (r.version) void qc.invalidateQueries({ queryKey: ['versions', r.version.workflow] });
    },
  });
  const r = apply.data ?? preview.data;
  const rep = r?.report;
  const groups = (['added', 'updated', 'removed', 'conflict'] as const).map((k) => ({ k, items: rep?.changes.filter((c) => c.kind === k) ?? [] })).filter((g) => g.items.length);
  const newFields = (preview.data?.settings ?? []).filter((x) => x.value === null && x.name !== 'repos');
  const done = apply.data?.ok && apply.data.version;
  return (
    <Popup title={`Update ${e.name}`} sub="from the marketplace" onClose={onClose} footer={
      <div className="row">
        {done ? <Link to={`/ui/workflows/${encodeURIComponent(apply.data!.version!.workflow)}?version=${encodeURIComponent(apply.data!.version!.id)}`} className="button primary">Open v{apply.data!.version!.version}</Link> : (
          <button type="button" className="primary" disabled={!preview.data?.ok || apply.isPending || rep?.nothing_to_update} onClick={() => apply.mutate()}>{apply.isPending ? 'Updating…' : 'Update and keep my changes'}</button>
        )}
        <button type="button" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
        <span className="muted small">Saves a new draft version. The current one is not touched.</span>
      </div>
    }>
      {preview.isLoading ? <Loading /> : null}
      <ErrorNote error={preview.error ?? apply.error} />
      {rep ? (
        <div className="update-review">
          {rep.nothing_to_update ? <p className="ok-note">This workflow already has everything the marketplace has.</p> : (
            <p>
              {rep.summary.added + rep.summary.updated + rep.summary.removed} change{rep.summary.added + rep.summary.updated + rep.summary.removed === 1 ? '' : 's'} from the marketplace
              {rep.kept ? <>, <b>{rep.kept} of your own edit{rep.kept === 1 ? '' : 's'} stay</b></> : null}
              {rep.summary.conflicts ? <>, <b className="warn-text">{rep.summary.conflicts} to look at</b></> : null}.
            </p>
          )}
          {!rep.tracked ? <p className="warn-note">This workflow was installed before updates were tracked, so Azhi cannot tell your edits from the marketplace's. The update only adds what is missing and changes nothing that is already there.</p> : null}
          {groups.map((g) => (
            <div key={g.k} className="sd-group">
              <h3>{KIND_LABEL[g.k]}</h3>
              <ul className="update-list">
                {g.items.map((c, i) => <li key={`${c.target}${c.field}${i}`}><span className="mono">{where(c)}</span>{c.detail ? <span className="muted small"> {c.detail}</span> : null}</li>)}
              </ul>
            </div>
          ))}
          {rep.tools.length ? <div className="sd-group"><h3>Tools</h3><p className="small">{rep.tools.map((t) => `${t.ref} (${t.kind})`).join(', ')}. The repositories and API address you set stay as they are.</p></div> : null}
          {rep.reformatted ? <p className="muted small">Because you edited the workflow file, it is rewritten in the standard layout: its comments and YAML anchors are not kept.</p> : null}
          {newFields.length && !done ? (
            <div className="sd-group">
              <h3>New settings to fill in</h3>
              {newFields.map((st) => (
                <div className="field" key={st.name}>
                  <label htmlFor={`new-${e.id}-${st.name}`}>{st.title ?? st.name}</label>
                  <input id={`new-${e.id}-${st.name}`} className="mono" spellCheck={false} placeholder={st.placeholder ?? ''} value={newSettings[st.name] ?? ''} onChange={(x) => setNewSettings({ ...newSettings, [st.name]: x.target.value })} />
                  <span className="hint">{st.description ?? ''}</span>
                </div>
              ))}
            </div>
          ) : null}
          {r && !r.ok && r.diagnostics?.length ? <div className="error" role="alert">The updated workflow does not compile: <ul>{r.diagnostics.map((d, i) => <li key={i}>{d.node ? `${d.node}: ` : ''}{d.message}</li>)}</ul></div> : null}
          {done ? <div className="ok-note" role="status">Created draft v{apply.data!.version!.version}{apply.data!.signError ? ' (not signed)' : ' and signed it'}. Check it, then publish it from the workflow page.{apply.data!.signError ? <div className="warn-text small">Not signed: {apply.data!.signError}</div> : null}</div> : null}
        </div>
      ) : null}
    </Popup>
  );
}

/** One bundled workflow: how it works, what it reads and changes, and setting it up. */
function ExampleDetail({ example: e }: { example: Example }) {
  const me = useMe();
  const m = metaOf(e);
  const [reviewing, setReviewing] = useState(false);
  const reads = e.tools.filter((t) => t.effect === 'read');
  const writes = e.tools.filter((t) => t.effect !== 'read');
  const admin = atLeast(me.data?.role, 'admin');
  return (
    <>
      <PageHead
        title={e.name}
        sub={`${m.category} · bundled with Azhi${stepCount(e) ? ` · ${stepCount(e)} steps` : ''}`}
        actions={e.update ? (
          <div className="row">
            <Badge tone="ok">installed, v{e.update.version}{e.update.draft ? ' draft' : ''}</Badge>
            {e.update.available ? <Badge tone="warn">update available</Badge> : <Badge tone="idle">up to date</Badge>}
            {e.workflow ? <Link to={`/ui/workflows/${encodeURIComponent(e.workflow)}`} className="button">Open workflow</Link> : null}
          </div>
        ) : <Badge tone="idle">not installed</Badge>}
      />
      {e.description ? <p>{e.description}</p> : null}
      {e.update?.available ? (
        <div className="update-note" role="status">
          <b>The marketplace has changed this workflow since you {e.update.tracked ? 'installed or last updated it' : 'installed it'}.</b>{' '}
          Your own edits and repositories stay; new steps, settings and files are loaded.{' '}
          {admin ? <button type="button" className="primary small" onClick={() => setReviewing(true)}>Review the update</button> : <span className="muted">An admin can apply it.</span>}
        </div>
      ) : null}
      {e.nodes?.length ? (
        <div className="example-steps">
          <h2 className="section">How it works</h2>
          <ExampleSteps example={e} />
        </div>
      ) : null}
      <div className="market-facts">
        <div className="panel"><span className="label">It reads</span><p className="small">{reads.length ? reads.map((t) => t.description).join('; ') : 'Only what you give it as input.'}</p></div>
        <div className="panel"><span className="label">It changes</span><p className="small">{writes.length ? writes.map((t) => t.description).join('; ') : 'Nothing outside Azhi.'}</p></div>
        <div className="panel"><span className="label">Secrets</span><p className="small">{e.secrets.length ? e.secrets.map((s) => s.name).join(', ') : 'None needed.'}</p></div>
      </div>
      <ExampleCard example={e} />
      {reviewing ? <UpdateReview example={e} onClose={() => setReviewing(false)} /> : null}
    </>
  );
}

function ExampleCard({ example: e }: { example: Example }) {
  const qc = useQueryClient();
  const [repos, setRepos] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  // Blank fields keep what an earlier install filled in.
  const [settings, setSettings] = useState<Record<string, string>>({});
  const filled = Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
  const list = repos.split(/[\s,]+/).filter(Boolean);
  const badRepo = list.find((r) => !REPO.test(r));
  const install = useMutation({
    mutationFn: async (): Promise<Installed> => {
      const r = await api<Installed>(`/v1/examples/${encodeURIComponent(e.id)}/install`, { method: 'POST', body: { ...(list.length ? { repos: list } : e.repos.length ? { repos: e.repos } : {}), ...(apiUrl.trim() ? { api_url: apiUrl.trim() } : {}), ...(gitUrl.trim() ? { git_url: gitUrl.trim() } : {}), ...(Object.keys(filled).length ? { settings: filled } : {}) } });
      if (!r.ok || !r.version) return r;
      // Workers run signed packages only.
      try {
        await signVersion(r.version.id);
      } catch (err) {
        return { ...r, signError: (err as Error).message };
      }
      return r;
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['tools'] });
      void qc.invalidateQueries({ queryKey: ['examples'] });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      if (r.version) void qc.invalidateQueries({ queryKey: ['versions', r.version.workflow] });
    },
  });
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    install.mutate();
  };
  const r = install.data;
  const secrets = r?.secrets ?? e.secrets;
  // Once installed, repositories are managed below with their token checked; installing again is a reset.
  const isInstalled = e.repos.length > 0 || Boolean(e.update);
  return (
    <Panel title={<>{isInstalled ? 'Set up' : 'Install'} <span className="muted small mono">{e.id}</span></>}>
      <div className="example-card">
        {e.description ? <p>{e.description}</p> : null}
        <div>
          <span className="label">Tools it registers</span>
          <ul className="small">
            {e.tools.map((t) => <li key={t.ref}><span className="mono">{t.ref}</span> <Badge tone={t.effect === 'read' ? 'ok' : 'warn'}>{t.effect}</Badge> <span className="muted">{t.description}</span></li>)}
          </ul>
        </div>
        {e.needs_repos && e.repos.length ? <AllowedRepos example={e} /> : null}
        <form onSubmit={submit} className="fields">
          {e.needs_repos && !e.repos.length ? (
            <>
              <div className="field">
                <label htmlFor={`repos-${e.id}`}>Repositories it may use</label>
                <input id={`repos-${e.id}`} className="mono" placeholder="owner/name, owner/other" value={repos} spellCheck={false} onChange={(x) => setRepos(x.target.value)} />
                {badRepo ? <span className="hint warn-text">{badRepo} is not owner/name.</span> : <span className="hint">Its GitHub tools refuse any other repository. Separate with commas. You can add more later, and each is checked against the token.</span>}
              </div>
              <details>
                <summary className="small">GitHub Enterprise</summary>
                <span className="hint">Leave empty for github.com, including organization repositories there.</span>
                <div className="field">
                  <label htmlFor={`api-${e.id}`}>API address</label>
                  <input id={`api-${e.id}`} className="mono" placeholder="https://ghe.example.com/api/v3" value={apiUrl} spellCheck={false} onChange={(x) => setApiUrl(x.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor={`git-${e.id}`}>Git address</label>
                  <input id={`git-${e.id}`} className="mono" placeholder="https://ghe.example.com" value={gitUrl} spellCheck={false} onChange={(x) => setGitUrl(x.target.value)} />
                  <span className="hint">Where the review clones from. Empty: the host of the API address.</span>
                </div>
              </details>
            </>
          ) : null}
          {(r?.settings ?? e.settings ?? []).map((st) => (
            <div className="field" key={st.name}>
              <label htmlFor={`setting-${e.id}-${st.name}`}>{st.title ?? st.name} {st.value ? <Badge tone="ok">set</Badge> : <Badge tone="warn">not set</Badge>}</label>
              <input id={`setting-${e.id}-${st.name}`} className="mono" spellCheck={false} placeholder={st.value ?? st.placeholder ?? ''} value={settings[st.name] ?? ''} onChange={(x) => setSettings({ ...settings, [st.name]: x.target.value })} />
              <span className="hint">{st.description ?? ''}{st.value ? ' Leave blank to keep the current value.' : ''}</span>
            </div>
          ))}
          {isInstalled && !install.isPending && !r ? (
            <details className="reinstall">
              <summary className="small">Start over from the marketplace version</summary>
              <p className="warn-note">This saves the marketplace's version as a new draft and leaves the workflow's own changes behind in the earlier versions. To bring in what the marketplace changed and keep your edits, use Review the update at the top of this page.</p>
              <button type="submit" disabled={install.isPending}>Reinstall</button>
            </details>
          ) : (
            <div className="row">
              <button type="submit" className="primary" disabled={install.isPending || (e.needs_repos && !e.repos.length && (!list.length || Boolean(badRepo)))}>
                {install.isPending ? 'Installing…' : r?.ok ? 'Install again' : 'Install'}
              </button>
            </div>
          )}
          <ErrorNote error={install.error} />
        </form>
        {r && !r.ok ? (
          <div className="error" role="alert">
            Not installed. The compiler found:
            <ul>{r.diagnostics.map((d, i) => <li key={i}>{d.node ? `${d.node}: ` : ''}{d.message}</li>)}</ul>
          </div>
        ) : null}
        {r?.ok && r.version ? (
          <div className="ok-note" role="status">
            Installed {r.version.workflow} v{r.version.version}{r.signError ? ' as an unsigned draft' : ' and signed it'}.{' '}
            <Link to={`/ui/workflows/${encodeURIComponent(r.version.workflow)}?version=${encodeURIComponent(r.version.id)}`}>Open it to check the run plan and start a run</Link>.
            {r.signError ? <div className="warn-text small">Not signed: {r.signError}</div> : null}
          </div>
        ) : null}
        <div>
          <span className="label">Secrets it needs</span>
          {secrets.length === 0 ? <p className="muted small">None.</p> : secrets.map((s) => <SecretRow key={s.name} secret={s} />)}
        </div>
      </div>
    </Panel>
  );
}

/** The repositories the installed GitHub tools may use, changed in place (no reinstall) and checked against each tool's token. */
function AllowedRepos({ example: e }: { example: Example }) {
  const qc = useQueryClient();
  const refs = e.tools.filter((t) => t.needs_repos).map((t) => t.ref);
  return (
    <div aria-label="Allowed repositories">
      <span className="label">Allowed repositories</span>
      <RepoList
        refs={refs}
        repos={e.repos}
        canEdit
        change={(c) => api(`/v1/examples/${encodeURIComponent(e.id)}/repos`, { method: 'POST', body: c })}
        onChanged={() => {
          void qc.invalidateQueries({ queryKey: ['examples'] });
          void qc.invalidateQueries({ queryKey: ['tools'] });
        }}
      />
    </div>
  );
}

/** Sets one secret in place; the value is sent once and never shown again. */
function SecretRow({ secret }: { secret: Secret }) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () => api(`/v1/secrets/${encodeURIComponent(secret.name)}`, { method: 'PUT', body: { value } }),
    onSuccess: () => {
      setValue('');
      setDone(true);
      void qc.invalidateQueries({ queryKey: ['secrets'] });
      void qc.invalidateQueries({ queryKey: ['examples'] });
    },
  });
  const isSet = secret.set || done;
  const odd = /[\s​-‍﻿]/.test(value);
  if (secret.name === 'github-copilot-token') {
    return (
      <div className="secret-row" aria-label={`Secret ${secret.name}`}>
        <div className="secret-name"><span className="mono">{secret.name}</span> {isSet ? <Badge tone="ok">set</Badge> : <Badge tone="warn">missing</Badge>}</div>
        <div className="secret-ctl">
          <CopilotLogin secret={secret.name} onDone={() => setDone(true)} />
          <span className="hint">Your GitHub Copilot subscription runs the models; no other model key is needed.</span>
        </div>
      </div>
    );
  }
  return (
    <form className="secret-row" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="secret-name"><span className="mono">{secret.name}</span> {isSet ? <Badge tone="ok">set</Badge> : <Badge tone="warn">missing</Badge>}</div>
      <div className="secret-ctl">
        <input type="password" autoComplete="off" aria-label={`Value for ${secret.name}`} placeholder={isSet ? 'Replace value' : 'Value'} value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="small" disabled={!value || save.isPending}>Save</button>
        {odd ? <span className="hint warn-text">Contains spaces or invisible characters; check what you pasted.</span> : null}
        <ErrorNote error={save.error} />
      </div>
    </form>
  );
}
