import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { useRoute } from '../router';
import { Badge, ErrorNote } from '../ui';
import { ModelChoice, type ModelValue } from './ModelChoice';

interface AdaptStep { node: string; from: { executor: string; provider: string | null; model: string | null }; to: { executor: string; provider: string | null; model: string | null }; status: 'ok' | 'changed' | 'blocked'; reason?: string }
interface AdaptResult { ready: string[]; model_defaults: ModelValue | null; steps: AdaptStep[]; unchanged: boolean; saved: { id: string; workflow: string; version: number } | null; diagnostics?: Array<{ message: string }> }

const label = (s: { executor: string; provider: string | null; model: string | null }) => `${s.executor} · ${s.provider ?? 'scripted'}${s.model ? ` · ${s.model}` : ''}`;

/**
 * Before a run: shows which signed-in providers the workflow's agent steps can use, and updates the
 * workflow (its default provider and model, and each step's harness) to fit them. The update is saved
 * as a new draft version, so nothing already published changes.
 */
export function FitToSignins({ versionId, slug }: { versionId: string; slug: string }) {
  const { navigate } = useRoute();
  const [pick, setPick] = useState<ModelValue>({});
  const [executor, setExecutor] = useState('');
  const body = { ...(pick.provider ? { provider: pick.provider, ...(pick.name ? { model: pick.name } : {}) } : {}), ...(executor ? { executor } : {}) };
  const executors = useQuery({ queryKey: ['executors'], queryFn: () => api<{ executors: Array<{ id: string }> }>('/v1/executors'), staleTime: 5 * 60_000 });
  const preview = useQuery({
    queryKey: ['adapt', versionId, JSON.stringify(body)],
    queryFn: () => api<AdaptResult>(`/v1/versions/${encodeURIComponent(versionId)}/adapt`, { method: 'POST', body }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: () => api<AdaptResult>(`/v1/versions/${encodeURIComponent(versionId)}/adapt`, { method: 'POST', body: { ...body, save: true } }),
    onSuccess: (r) => { if (r.saved) navigate(`/ui/workflows/${encodeURIComponent(slug)}?version=${encodeURIComponent(r.saved.id)}`); },
  });
  const r = preview.data;
  const blocked = r?.steps.filter((s) => s.status === 'blocked') ?? [];
  return (
    <section className="fit-signins" aria-label="Fit the workflow to my sign-ins">
      <h3>Sign-ins, harness and model</h3>
      {r ? <p className="muted small">{r.ready.length ? `Signed in: ${r.ready.join(', ')}.` : 'No model provider is signed in here.'}</p> : null}
      <ModelChoice nameBase="fit" value={pick} onChange={setPick} noneLabel="Whatever is signed in (chosen for me)" />
      <label>
        <span className="muted small">Harness</span>
        <select name="fit-executor" value={executor} onChange={(e) => setExecutor(e.target.value)}>
          <option value="">Whatever each step needs</option>
          {(executors.data?.executors ?? []).map((e) => <option key={e.id} value={e.id}>{e.id}</option>)}
        </select>
      </label>
      {preview.error ? <ErrorNote error={preview.error} /> : null}
      {r?.steps.map((s) => (
        <div key={s.node} className="pf-line">
          <Badge tone={s.status === 'blocked' ? 'bad' : s.status === 'changed' ? 'warn' : 'ok'}>{s.node}</Badge>{' '}
          {s.status === 'changed' ? <>{label(s.from)} → <strong>{label(s.to)}</strong></> : label(s.to)}
          {s.reason ? <div className="muted small">{s.reason}</div> : null}
        </div>
      ))}
      {r && r.unchanged ? <p className="ok-note">Every step already fits what is signed in.</p> : null}
      {blocked.length ? <p className="warn-note">{blocked.length} step(s) cannot run until you sign in or edit their profile.</p> : null}
      <div className="row">
        <button type="button" disabled={!r || r.unchanged || save.isPending} onClick={() => save.mutate()} title="Saves a new draft version; published versions are not changed">Update workflow</button>
      </div>
      {save.data?.diagnostics?.length ? <div className="error">{save.data.diagnostics[0]!.message}</div> : null}
      <ErrorNote error={save.error} />
    </section>
  );
}
