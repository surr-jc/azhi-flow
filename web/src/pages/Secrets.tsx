import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Link } from '../router';
import { ago, ErrorNote, Loading, PageHead, Panel, when } from '../ui';

interface Secret { name: string; version: number; updated_at: string }

/** Secrets are write-only here: the API never returns a value to a user, and neither does this page. */
export function Secrets() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['secrets'], queryFn: () => api<Secret[]>('/v1/secrets') });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<string>();
  const [search, setSearch] = useState('');
  const valueRef = useRef<HTMLInputElement>(null);
  const set = useMutation({
    mutationFn: () => api<{ version: number }>(`/v1/secrets/${encodeURIComponent(name.trim())}`, { method: 'PUT', body: { value } }),
    onSuccess: (r) => {
      setSaved(`${name.trim()} is now version ${r.version}.`);
      setValue('');
      void qc.invalidateQueries({ queryKey: ['secrets'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(undefined);
    set.mutate();
  };
  const pick = (n: string) => {
    setName(n);
    setSaved(undefined);
    valueRef.current?.focus();
  };
  // Pasted keys often carry spaces or invisible characters that no API key contains.
  const odd = /[\s​-‍﻿]/.test(value);
  const needle = search.trim().toLowerCase();
  const list = (q.data ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle));
  const exists = (q.data ?? []).some((s) => s.name === name.trim());
  return (
    <>
      <PageHead title="Secrets" sub="Values are encrypted on the server and only resolved when a run needs them. This page can set a value but never shows one." />
      <div className="sc-layout">
        <Panel title={<>Stored secrets {q.data ? <span className="muted small">· {q.data.length}</span> : null}</>}>
          <ErrorNote error={q.error} />
          {!q.data ? <Loading /> : (
            <>
              {q.data.length > 6 ? <input type="search" aria-label="Search secrets" placeholder="Search secrets" value={search} onChange={(e) => setSearch(e.target.value)} className="sc-search" /> : null}
              {!list.length ? (
                <div className="empty"><p className="empty-title">{q.data.length ? 'No secrets match.' : 'No secrets yet.'}</p>{q.data.length ? null : <p className="muted">Add one with the form, or sign in to a service on the <Link to="/ui/signins">Sign-ins page</Link>.</p>}</div>
              ) : (
                <ul className="sc-list">
                  {list.map((s) => (
                    <li key={s.name} className={s.name === name.trim() ? 'sel' : ''}>
                      <div className="sc-meta">
                        <span className="mono sc-name">{s.name}</span>
                        <span className="muted small">v{s.version} · <span title={when(s.updated_at)}>changed {ago(s.updated_at)}</span></span>
                      </div>
                      <button type="button" className="small" onClick={() => pick(s.name)} aria-label={`Set a new value for ${s.name}`}>Replace</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Panel>
        <div className="sc-side">
          <Panel title={exists ? 'Replace a secret' : 'Add a secret'}>
            <form onSubmit={submit} className="fields">
              <div className="field">
                <label htmlFor="secret-name">Name</label>
                <input id="secret-name" className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="anthropic-api-key" required pattern="[A-Za-z0-9._-]+" />
                <span className="hint">Letters, numbers, dots, dashes and underscores. {exists ? 'This name exists; saving creates a new version.' : 'A new name creates a new secret.'}</span>
              </div>
              <div className="field">
                <label htmlFor="secret-value">Value</label>
                <input id="secret-value" ref={valueRef} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} required />
                {odd ? <span className="hint warn-text">This value contains spaces or invisible characters. API keys never do; check what you pasted.</span> : null}
              </div>
              <div className="row">
                <button type="submit" className="primary" disabled={set.isPending || !name.trim() || !value}>{exists ? 'Save new version' : 'Save secret'}</button>
              </div>
              {saved ? <p className="ok-note" role="status">{saved}</p> : null}
              <ErrorNote error={set.error} />
            </form>
          </Panel>
          <Panel title="Sign in to a service">
            <p className="muted small">GitHub, Copilot and ChatGPT sign-ins store their own secrets. Start them from one place.</p>
            <Link to="/ui/signins" className="button">Open Sign-ins</Link>
          </Panel>
          <Panel title="Claude plan">
            <details>
              <summary>Use your Claude Pro or Max plan</summary>
              <p className="muted small">Claude Agent SDK steps can use your Claude Pro or Max plan, for your own use. Run <code>claude setup-token</code> on any computer with Claude Code, then save the token (it starts with sk-ant-oat) here as a secret such as claude-plan-token, and name it as the profile's credential. Anthropic does not allow plan tokens in OpenCode or direct API calls, so Azhi refuses them there.</p>
            </details>
          </Panel>
        </div>
      </div>
    </>
  );
}
