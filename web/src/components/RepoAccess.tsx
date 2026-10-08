import { useState } from 'react';
import { api } from '../api';
import { Badge } from '../ui';

/** What GitHub said about one token and one repository (`POST /v1/tools/:ref/repos/check`). */
export interface RepoAccessResult {
  repo: string;
  ok: boolean;
  status: string;
  need: 'read' | 'write';
  token_kind: 'classic' | 'fine-grained' | 'unknown';
  scopes?: string[];
  message: string;
  fix?: string;
  warning?: string;
}
interface Line { tool: string; credential: string | null; access: RepoAccessResult }
export type AccessByRepo = Record<string, Line[]>;

/** Checks repositories against the tokens of the given tools, and keeps the answers for display. */
export function useRepoAccess(refs: string[]) {
  const [byRepo, setByRepo] = useState<AccessByRepo>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const check = async (repos?: string[]) => {
    setBusy(true);
    setError(undefined);
    try {
      const answers = await Promise.all(refs.map((ref) => api<{ tool: string; credential: string | null; results: RepoAccessResult[] }>(`/v1/tools/${encodeURIComponent(ref)}/repos/check`, { method: 'POST', body: repos ? { repos } : {} })));
      setByRepo((prev) => {
        const next: AccessByRepo = repos ? { ...prev } : {};
        for (const r of repos ?? []) delete next[r];
        for (const a of answers) for (const access of a.results) (next[access.repo] ??= []).push({ tool: a.tool, credential: a.credential, access });
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { byRepo, busy, error, check, forget: (repo: string) => setByRepo(({ [repo]: _x, ...rest }) => rest) };
}

/** The answers as plain lines: what is wrong, and what to change. Passing lines are folded into one. */
export function AccessResults({ byRepo, repos }: { byRepo: AccessByRepo; repos?: string[] }) {
  const names = (repos ?? Object.keys(byRepo)).filter((r) => byRepo[r]);
  if (!names.length) return null;
  return (
    <div className="access-results" aria-live="polite">
      {names.map((repo) => {
        // One answer per token and purpose, whichever tools share it.
        const lines = [...new Map(byRepo[repo]!.map((l) => [`${l.credential}:${l.access.need}`, l])).values()];
        const bad = lines.filter((l) => !l.access.ok);
        const warn = lines.filter((l) => l.access.ok && l.access.warning);
        const good = lines.filter((l) => l.access.ok && !l.access.warning);
        return (
          <div key={repo} className={`access-repo ${bad.length ? 'bad' : warn.length ? 'warn' : 'ok'}`}>
            <div className="row">
              <span className="mono">{repo}</span>
              <Badge tone={bad.length ? 'bad' : warn.length ? 'warn' : 'ok'}>{bad.length ? 'token cannot use it' : warn.length ? 'check the token' : 'token works'}</Badge>
            </div>
            {bad.map((l) => (
              <div key={`${l.credential}${l.access.need}`} className="access-line">
                <b className="mono">{l.credential ?? 'no token'}</b> ({l.access.need === 'write' ? 'changes the repository' : 'reads it'}): {l.access.message}
                {l.access.fix ? <div className="muted small">{l.access.fix}</div> : null}
              </div>
            ))}
            {warn.map((l) => (
              <div key={`${l.credential}${l.access.need}`} className="access-line">
                <b className="mono">{l.credential}</b>: {l.access.warning}
              </div>
            ))}
            {good.length ? <div className="muted small">Works with {good.map((l) => `${l.credential ?? 'the token'} (${l.access.need === 'write' ? 'write' : 'read'}${l.access.token_kind !== 'unknown' ? `, ${l.access.token_kind}` : ''})`).join(', ')}.</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The repositories some GitHub tools may use, changed in place. A repository is added at once, and
 * then checked against each tool's token, so a token that cannot use it is reported straight away.
 */
export function RepoList({ refs, repos, canEdit, change, onChanged }: { refs: string[]; repos: string[]; canEdit: boolean; change: (c: { add?: string[]; remove?: string[] }) => Promise<unknown>; onChanged?: () => void }) {
  const access = useRepoAccess(refs);
  const [repo, setRepo] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const bad = repo.trim() && !/^[\w.-]+\/[\w.-]+$/.test(repo.trim());
  const run = async (c: { add?: string[]; remove?: string[] }) => {
    setPending(true);
    setError(undefined);
    try {
      await change(c);
      onChanged?.();
      for (const r of c.remove ?? []) access.forget(r);
      if (c.add?.length) await access.check(c.add);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="repo-list" aria-label="Allowed repositories">
      <div className="row wrap">
        {repos.map((r) => {
          const lines = access.byRepo[r];
          const state = !lines ? '' : lines.some((l) => !l.access.ok) ? 'bad' : lines.some((l) => l.access.warning) ? 'warn' : 'ok';
          return (
            <span key={r} className={`chip mono repo-chip ${state}`}>
              {state === 'ok' ? '✓ ' : state ? '! ' : ''}{r}{' '}
              {canEdit && repos.length > 1 ? <button type="button" className="linkish" aria-label={`Remove ${r}`} onClick={() => void run({ remove: [r] })}>×</button> : null}
            </span>
          );
        })}
        {refs.length ? <button type="button" className="small" disabled={access.busy} onClick={() => void access.check()}>{access.busy ? 'Checking…' : 'Check access'}</button> : null}
      </div>
      {canEdit ? (
        <form className="row wrap" onSubmit={(ev) => { ev.preventDefault(); void run({ add: [repo.trim()] }).then(() => setRepo('')); }}>
          <input aria-label="Add a repository" className="mono" placeholder="owner/name" value={repo} spellCheck={false} onChange={(x) => setRepo(x.target.value)} />
          <button type="submit" className="small" disabled={!repo.trim() || Boolean(bad) || pending}>Add repository</button>
          {bad ? <span className="hint warn-text">Use owner/name.</span> : <span className="hint">The GitHub tools refuse any repository not listed here. The token is checked as soon as it is added.</span>}
        </form>
      ) : null}
      {error ? <div className="error" role="alert">{error}</div> : null}
      {access.error ? <div className="error" role="alert">{access.error}</div> : null}
      <AccessResults byRepo={access.byRepo} />
    </div>
  );
}
