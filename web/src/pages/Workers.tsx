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
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['Worker', 'Status', 'Last heartbeat', 'Queue', 'Runtimes', 'Trust policy', 'Capabilities']} empty="No worker has registered yet.">
            {q.data.map((w) => (
              <tr key={w.id}>
                <td>{w.name}<div className="muted small mono">{w.id}</div></td>
                <td>{w.online ? <Badge tone="ok">online</Badge> : <Badge tone="bad">offline</Badge>}</td>
                <td title={when(w.last_heartbeat)}>{new Date(w.last_heartbeat).getTime() <= 0 ? 'stopped' : ago(w.last_heartbeat)}</td>
                <td className="mono small">{w.task_queue}</td>
                <td>{Object.entries(w.capabilities?.runtimes ?? {}).map(([k, v]: [string, any]) => <Badge key={k}>{k} {v?.version ?? ''}</Badge>)}</td>
                <td>{w.trust_policy?.kind ?? '—'}</td>
                <td><details><summary>details</summary><Json value={w.capabilities} /></details></td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      <HarnessSdk />
      <RepoConcurrency />
    </>
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
          <p className="muted">
            The OpenCode version every OpenCode step runs on, for all workflows. Now: <strong>{current === null ? 'each worker\'s own default' : `OpenCode ${current}.x`}</strong>.
            {' '}Steps wait for a worker that has the chosen version; install 2.x on a worker with <code>azhi setup --opencode2</code>.
          </p>
          <div className="fields">
            <div className="field">
              <label htmlFor="opencode-major">SDK for all workflows</label>
              <select id="opencode-major" disabled={!admin || save.isPending} value={current === null ? '' : String(current)} onChange={(e) => save.mutate(e.target.value === '' ? null : (Number(e.target.value) as 1 | 2))}>
                <option value="">Worker default</option>
                <option value="1">OpenCode 1.x ({capable(1)} online worker{capable(1) === 1 ? '' : 's'})</option>
                <option value="2">OpenCode 2.x ({capable(2)} online worker{capable(2) === 1 ? '' : 's'})</option>
              </select>
              {admin ? null : <span className="hint">Only an admin can change this.</span>}
            </div>
          </div>
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
          <p className="muted">
            Runs of any workflow, including the same one, run side by side, each step in its own fresh checkout. This caps how many may work on one repository at once; the rest wait in order.
            {' '}Now: <strong>{q.data.max_runs_per_repo === 0 ? 'no limit' : q.data.max_runs_per_repo}</strong> ({q.data.source === 'workspace' ? 'set for this workspace' : 'server default'}).
          </p>
          {admin ? (
            <form onSubmit={submit} className="fields">
              <div className="field">
                <label htmlFor="max-runs-per-repo">Most runs at once on one repository</label>
                <input id="max-runs-per-repo" type="number" min={0} max={64} step={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
                <span className="hint">0 means no limit. A run waiting for a person to decide still holds its slot.</span>
              </div>
              <div className="row">
                <button type="submit" className="primary" disabled={save.isPending || !valid}>Save limit</button>
                {q.data.source === 'workspace' ? <button type="button" disabled={save.isPending} onClick={() => save.mutate(null)}>Use server default ({q.data.server_default})</button> : null}
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
