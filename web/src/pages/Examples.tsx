import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Link } from '../router';
import { signVersion } from '../signing';
import { CopilotLogin } from '../components/CopilotLogin';
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

export function Examples() {
  const q = useQuery({ queryKey: ['examples'], queryFn: () => api<Example[]>('/v1/examples') });
  return (
    <>
      <PageHead title="Examples" sub="Ready-made workflows. Installing one registers its tools, saves it as a signed draft and lists the secrets it needs; nothing is edited by hand. The CLI does the same with azhi example install." />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : q.data.length === 0 ? <p className="muted">This server has no examples.</p> : q.data.map((e) => <ExampleCard key={e.id} example={e} />)}
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
      const r = await api<Installed>(`/v1/examples/${encodeURIComponent(e.id)}/install`, { method: 'POST', body: { ...(list.length ? { repos: list } : {}), ...(apiUrl.trim() ? { api_url: apiUrl.trim() } : {}), ...(gitUrl.trim() ? { git_url: gitUrl.trim() } : {}), ...(Object.keys(filled).length ? { settings: filled } : {}) } });
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
  return (
    <Panel title={<>{e.name} <span className="muted small mono">{e.id}</span></>}>
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
          {e.needs_repos ? (
            <>
              <div className="field">
                <label htmlFor={`repos-${e.id}`}>Repositories it may use</label>
                <input id={`repos-${e.id}`} className="mono" placeholder="owner/name, owner/other" value={repos} spellCheck={false} onChange={(x) => setRepos(x.target.value)} />
                {badRepo ? <span className="hint warn-text">{badRepo} is not owner/name.</span> : <span className="hint">Its GitHub tools refuse any other repository. Separate with commas.</span>}
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
          <div className="row">
            <button type="submit" className="primary" disabled={install.isPending || (e.needs_repos && (!list.length || Boolean(badRepo)))}>
              {install.isPending ? 'Installing…' : r?.ok ? 'Install again' : 'Install'}
            </button>
          </div>
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

/** The repositories the installed GitHub tools may use, changed in place (no reinstall). */
function AllowedRepos({ example: e }: { example: Example }) {
  const qc = useQueryClient();
  const [repo, setRepo] = useState('');
  const change = useMutation({
    mutationFn: (body: { add?: string[]; remove?: string[] }) => api(`/v1/examples/${encodeURIComponent(e.id)}/repos`, { method: 'POST', body }),
    onSuccess: () => {
      setRepo('');
      void qc.invalidateQueries({ queryKey: ['examples'] });
      void qc.invalidateQueries({ queryKey: ['tools'] });
    },
  });
  const bad = repo.trim() && !REPO.test(repo.trim());
  return (
    <div aria-label="Allowed repositories">
      <span className="label">Allowed repositories</span>
      <div className="row wrap">
        {e.repos.map((r) => (
          <span key={r} className="chip mono">{r} {e.repos.length > 1 ? <button type="button" className="linkish" aria-label={`Remove ${r}`} onClick={() => change.mutate({ remove: [r] })}>×</button> : null}</span>
        ))}
      </div>
      <form className="row wrap" onSubmit={(ev) => { ev.preventDefault(); change.mutate({ add: [repo.trim()] }); }}>
        <input aria-label="Add a repository" className="mono" placeholder="owner/name" value={repo} spellCheck={false} onChange={(x) => setRepo(x.target.value)} />
        <button type="submit" className="small" disabled={!repo.trim() || Boolean(bad) || change.isPending}>Add repository</button>
        {bad ? <span className="hint warn-text">Use owner/name.</span> : <span className="hint">The GitHub tools refuse any repository not listed here. No reinstall needed.</span>}
      </form>
      <ErrorNote error={change.error} />
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
      <div className="row wrap" aria-label={`Secret ${secret.name}`}>
        <span className="mono">{secret.name}</span>
        {isSet ? <Badge tone="ok">set</Badge> : <Badge tone="warn">missing</Badge>}
        <CopilotLogin secret={secret.name} onDone={() => setDone(true)} />
        <span className="hint">Your GitHub Copilot subscription runs the models; no other model key is needed.</span>
      </div>
    );
  }
  return (
    <form className="row wrap" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <span className="mono">{secret.name}</span>
      {isSet ? <Badge tone="ok">set</Badge> : <Badge tone="warn">missing</Badge>}
      <input type="password" autoComplete="off" aria-label={`Value for ${secret.name}`} placeholder={isSet ? 'Replace value' : 'Value'} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="small" disabled={!value || save.isPending}>Save</button>
      {odd ? <span className="hint warn-text">Contains spaces or invisible characters; check what you pasted.</span> : null}
      <ErrorNote error={save.error} />
    </form>
  );
}
