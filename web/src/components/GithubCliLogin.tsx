import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorNote } from '../ui';

interface Result { host: string; login: string | null; scopes: string[]; secrets: string[]; warning?: string }

/**
 * Points the GitHub secrets at the GitHub CLI's login on the server's machine, so no token is stored or
 * pasted. The token is asked of `gh` each time a step needs it.
 */
export function GithubCliLogin({ secrets: defaults }: { secrets?: string[] } = {}) {
  const qc = useQueryClient();
  const [names, setNames] = useState((defaults ?? ['github-read-token', 'github-write-token']).join(', '));
  const [host, setHost] = useState('');
  const use = useMutation({
    mutationFn: () => {
      const secrets = names.split(/[\s,]+/).filter(Boolean);
      return api<Result>('/v1/github/cli-login', { method: 'POST', body: { secrets, ...(host.trim() ? { host: host.trim() } : {}) } });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['secrets'] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    use.mutate();
  };
  const r = use.data;
  return (
    <form onSubmit={submit} className="fields">
      <ol className="small">
        <li>On the computer the server runs on, install the GitHub CLI (Windows: <code>winget install GitHub.cli</code>) and run <code>gh auth login</code>.</li>
        <li>Choose the secrets below, then use the login. Nothing is stored: a secret just points at it.</li>
      </ol>
      <div className="field">
        <label htmlFor="gh-secrets">Secrets that should use it</label>
        <input id="gh-secrets" className="mono" value={names} onChange={(e) => setNames(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="gh-host">GitHub Enterprise host (leave empty for github.com)</label>
        <input id="gh-host" className="mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="git.example.com" />
      </div>
      <p className="warn-note small">The login acts as you, with the scopes of your sign-in, so it can reach every repository you can. Each tool's repository list still decides which repositories a workflow may use, and the preflight checks write access before a run.</p>
      <div className="row">
        <button type="submit" className="primary" disabled={use.isPending || !names.trim()}>Use the GitHub CLI login</button>
      </div>
      {r ? (
        <p className="ok-note" role="status">
          Using the login of <strong>{r.login ?? 'unknown'}</strong> on {r.host} for {r.secrets.join(', ')}. Scopes: {r.scopes.join(', ') || 'none listed'}.
        </p>
      ) : null}
      {r?.warning ? <p className="warn-note">{r.warning}</p> : null}
      <ErrorNote error={use.error} />
    </form>
  );
}
