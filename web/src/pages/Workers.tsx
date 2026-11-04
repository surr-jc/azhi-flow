import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, atLeast } from '../api';
import { useMe } from '../App';
import { ago, Badge, ErrorNote, Json, Loading, PageHead, Panel, RunLink, Table, when } from '../ui';

interface Concurrency { max_runs_per_repo: number; source: 'workspace' | 'server'; server_default: number; repos: Array<{ repo: string; running: string[]; held: string[] }> }
interface HarnessSettings { opencode_major: 1 | 2 | null; workers: Array<{ name: string; opencode: { 1: string | null; 2: string | null } }> }
interface Worker { id: string; name: string; owner_id: string; task_queue: string; capabilities: Record<string, any>; trust_policy: Record<string, any>; last_heartbeat: string; online: boolean }

export function Workers() {
  const q = useQuery({ queryKey: ['workers'], queryFn: () => api<Worker[]>('/v1/workers'), refetchInterval: 5_000 });
  return (
    <>
      <PageHead title="Workers" sub={<>Workers run scripts and harness agents on their own machines. Start one with <code>azhi worker start</code>.</>} />
      <ErrorNote error={q.error} />
      {!q.data ? <Panel><Loading /></Panel> : q.data.length === 0 ? (
        <Panel><div className="empty"><p className="empty-title">No worker has registered yet.</p></div></Panel>
      ) : (
        <div className="wk-list">
          {q.data.map((w) => <WorkerCard key={w.id} w={w} />)}
        </div>
      )}
      <HarnessSdk />
      <RepoConcurrency />
    </>
  );
}

function WorkerCard({ w }: { w: Worker }) {
  const stopped = new Date(w.last_heartbeat).getTime() <= 0;
  const runtimes = Object.entries(w.capabilities?.runtimes ?? {}) as Array<[string, any]>;
  return (
    <article className={`wk-card${w.online ? '' : ' off'}`}>
      <header className="wk-head">
        <span className={`wk-dot ${w.online ? 'on' : 'off'}`} aria-hidden="true" />
        <div className="wk-id">
          <h2>{w.name}</h2>
          <span className="muted small mono">{w.id}</span>
        </div>
        <div className="wk-state">
          {w.online ? <Badge tone="ok">online</Badge> : <Badge tone="bad">offline</Badge>}
          <span className="muted small" title={when(w.last_heartbeat)}>{stopped ? 'stopped' : `heartbeat ${ago(w.last_heartbeat)}`}</span>
        </div>
      </header>
      <dl className="wk-facts">
        <div><dt>Queue</dt><dd className="mono">{w.task_queue}</dd></div>
        <div><dt>Trust policy</dt><dd>{w.trust_policy?.kind ?? '—'}</dd></div>
      </dl>
      <div className="wk-runtimes">
        <span className="wk-label">Runtimes</span>
        {runtimes.length ? (
          <ul>{runtimes.map(([k, v]) => <li key={k}><span>{k}</span>{v?.version ? <b>{v.version}</b> : null}</li>)}</ul>
        ) : <span className="muted small">None reported</span>}
      </div>
      <details className="wk-caps"><summary>Capabilities</summary><Json value={w.capabilities} /></details>
    </article>
  );
}

/** Which OpenCode SDK every OpenCode step of every workflow runs on; the workers must have that major installed. */
function HarnessSdk() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'harness'], queryFn: () => api<HarnessSettings>('/v1/settings/harness'), refetchInterval: 5_000 });
  const save = useMutation({
    mutationFn: (value: 1 | 2 | null) => api('/v1/settings/harness', { method: 'PUT', body: { opencode_major: value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'harness'] }),
  });
  const admin = atLeast(me.data?.role, 'admin');
  const current = q.data?.opencode_major ?? null;
  const capable = (m: 1 | 2) => q.data?.workers.filter((w) => w.opencode[m]).length ?? 0;
  return (
    <Panel title="OpenCode SDK">
      <ErrorNote error={q.error ?? save.error} />
      {!q.data ? <Loading /> : (
        <>
          <p className="muted wk-lede">
            The OpenCode version every OpenCode step runs on, for all workflows. Now: <strong>{current === null ? 'each worker\'s own default' : `OpenCode ${current}.x`}</strong>.
            {' '}Steps wait for a worker that has the chosen version; install 2.x on a worker with <code>azhi setup --opencode2</code>.
          </p>
          <fieldset className="wk-choices" disabled={!admin || save.isPending}>
            <legend>SDK for all workflows</legend>
            {([
              { value: null, title: 'Worker default', note: 'Each worker uses its own' },
              { value: 1, title: 'OpenCode 1.x', note: `${capable(1)} online worker${capable(1) === 1 ? '' : 's'}` },
              { value: 2, title: 'OpenCode 2.x', note: `${capable(2)} online worker${capable(2) === 1 ? '' : 's'}` },
            ] as const).map((o) => (
              <label key={String(o.value)} className={`wk-choice${current === o.value ? ' on' : ''}`}>
                <input type="radio" name="opencode-major" checked={current === o.value} onChange={() => save.mutate(o.value as 1 | 2 | null)} />
                <span className="wk-choice-title">{o.title}</span>
                <span className="muted small">{o.note}</span>
              </label>
            ))}
          </fieldset>
          {admin ? null : <p className="hint">Only an admin can change this.</p>}
        </>
      )}
    </Panel>
  );
}

/** How many runs may work on one repository at once; each run's steps still get their own checkout. */
function RepoConcurrency() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'concurrency'], queryFn: () => api<Concurrency>('/v1/settings/concurrency'), refetchInterval: 5_000 });
  const [limit, setLimit] = useState('');
  useEffect(() => {
    if (q.data && limit === '') setLimit(String(q.data.max_runs_per_repo));
  }, [q.data, limit]);
  const save = useMutation({
    mutationFn: (value: number | null) => api('/v1/settings/concurrency', { method: 'PUT', body: { max_runs_per_repo: value } }),
    onSuccess: (r: any) => {
      setLimit(String(r.max_runs_per_repo));
      return qc.invalidateQueries({ queryKey: ['settings', 'concurrency'] });
    },
  });
  const admin = atLeast(me.data?.role, 'admin');
  const n = Number(limit);
  const valid = limit.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 64;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) save.mutate(n);
  };
  return (
    <Panel title="Runs per repository">
      <ErrorNote error={q.error ?? save.error} />
      {!q.data ? <Loading /> : (
        <>
          <p className="muted wk-lede">
            Runs of any workflow, including the same one, run side by side, each step in its own fresh checkout. This caps how many may work on one repository at once; the rest wait in order.
            {' '}Now: <strong>{q.data.max_runs_per_repo === 0 ? 'no limit' : q.data.max_runs_per_repo}</strong> ({q.data.source === 'workspace' ? 'set for this workspace' : 'server default'}).
          </p>
          {admin ? (
            <form onSubmit={submit} className="wk-limit">
              <div className="field">
                <label htmlFor="max-runs-per-repo">Most runs at once on one repository</label>
                <div className="wk-limit-row">
                  <input id="max-runs-per-repo" type="number" min={0} max={64} step={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
                  <button type="submit" className="primary" disabled={save.isPending || !valid}>Save limit</button>
                  {q.data.source === 'workspace' ? <button type="button" disabled={save.isPending} onClick={() => save.mutate(null)}>Use server default ({q.data.server_default})</button> : null}
                </div>
                <span className="hint">0 means no limit. A run waiting for a person to decide still holds its slot.</span>
              </div>
              {save.isSuccess ? <p className="ok-note">Saved. Waiting runs start as soon as a slot is free.</p> : null}
            </form>
          ) : <p className="muted">An admin can change the limit.</p>}
          <Table head={['Repository', 'Running', 'Waiting']} empty="No open runs are working on a repository.">
            {q.data.repos.map((r) => (
              <tr key={r.repo}>
                <td className="mono">{r.repo}</td>
                <td>{r.running.length ? r.running.map((id) => <div key={id}><RunLink id={id} /></div>) : <span className="muted">—</span>}</td>
                <td>{r.held.length ? r.held.map((id) => <div key={id}><RunLink id={id} /></div>) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Panel>
  );
}
