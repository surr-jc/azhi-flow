import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Badge, ErrorNote, Loading, Table } from '../ui';
import { Popup } from './Popup';

interface Step { id: string; change: 'same' | 'changed' | 'added' | 'removed'; was: string; action: 'carry' | 'rerun' | 'drop'; reason?: string }
interface Check { possible: boolean; reason?: string; deviation: number | null; max_deviation: number; steps: Step[]; carried: string[]; rerun: string[]; warnings: string[]; version: { version: number; from_version: number } }
interface Version { id: string; version: number; draft: boolean }

const pct = (n: number) => `${Math.round(n * 100)}%`;
const CHANGE_TONE: Record<Step['change'], string> = { same: 'idle', changed: 'warn', added: 'run', removed: 'bad' };

/**
 * Resume a run, on the version it ran or on a newer one with a fixed step. The server compares the two versions and
 * says which steps keep their output; a version too different from the run is refused and the button stays off.
 */
export function ResumeDialog({ runId, workflow, current, onClose, onStarted }: { runId: string; workflow: string; current: number; onClose: () => void; onStarted: (runId: string) => void }) {
  const versions = useQuery({ queryKey: ['versions', workflow], queryFn: () => api<Version[]>(`/v1/workflows/${encodeURIComponent(workflow)}/versions`) });
  const newest = versions.data?.[0]?.version;
  const [picked, setPicked] = useState<number | null>(null);
  // Opens on the newest version when there is one past the run's, since that is usually the fix.
  const version = picked ?? (newest && newest > current ? newest : current);
  const body = (dry: boolean) => ({ ...(version !== current ? { version: String(version) } : {}), ...(dry ? { dry_run: true } : {}) });
  const check = useQuery({
    queryKey: ['resume-check', runId, version],
    queryFn: () => api<Check>(`/v1/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST', body: body(true) }),
    enabled: versions.isSuccess,
    retry: false,
  });
  const start = useMutation({ mutationFn: () => api<{ run_id: string }>(`/v1/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST', body: body(false) }), onSuccess: (r) => onStarted(r.run_id) });
  const c = check.data;
  return (
    <Popup
      title="Resume run"
      sub="Starts a new run that keeps the steps that already succeeded, so their tokens and credits are not spent again."
      onClose={onClose}
      footer={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!c?.possible || start.isPending} onClick={() => start.mutate()}>Resume on v{version}</button></>}
    >
      <label className="field">
        <span>Continue on version</span>
        <select value={version} onChange={(e) => setPicked(Number(e.target.value))}>
          {(versions.data ?? [{ id: '', version: current, draft: false }]).map((v) => (
            <option key={v.id || v.version} value={v.version}>v{v.version}{v.version === current ? ' (this run)' : ''}{v.draft ? ' (draft)' : ''}</option>
          ))}
        </select>
      </label>
      {check.isLoading || versions.isLoading ? <Loading lines={2} /> : null}
      <ErrorNote error={versions.error ?? check.error ?? start.error} />
      {c ? (
        <>
          {c.possible ? (
            <p>
              {c.carried.length} step(s) keep their output, {c.rerun.length} run{c.rerun.length === 1 ? 's' : ''}.
              {c.deviation !== null ? <> Difference from the run: {pct(c.deviation)} of its finished steps (limit {pct(c.max_deviation)}).</> : null}
            </p>
          ) : (
            <div className="error" role="alert"><strong>Cannot resume on v{version}</strong>: {c.reason}</div>
          )}
          {c.warnings.map((w) => <p key={w} className="muted">Note: {w}</p>)}
          <Table head={['Step', 'Version change', 'Then']}>
            {c.steps.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.id}</td>
                <td><Badge tone={`s ${CHANGE_TONE[s.change]}`}>{s.change}</Badge></td>
                <td>{s.action === 'carry' ? 'keeps its output' : s.action === 'drop' ? 'removed' : 'runs'}{s.reason ? <span className="muted"> · {s.reason}</span> : null}</td>
              </tr>
            ))}
          </Table>
        </>
      ) : null}
    </Popup>
  );
}
