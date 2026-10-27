import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../api';
import type { RunPlan } from '../api';
import { Badge } from '../ui';

/**
 * The provider and model for the steps that use "the default model" (a profile that says
 * `name: default`). A step that names its own provider and model keeps them, whatever is chosen here.
 * Used in the workflow editor (the workflow's default) and when starting a run (this run's choice).
 */
export interface ModelValue { provider?: string; name?: string }
interface Provider { id: string; label: string; ready: boolean; reason?: string; credential: string; server_default_model: string | null; server_default_env: string; executors: string[] }
interface ModelList { models: Array<{ id: string; label: string }>; recommended?: { id: string; reason: string }; source: 'live' | 'built-in'; note?: string }

const OTHER = '__other__';

export function useModelOptions() {
  return useQuery({ queryKey: ['model-options'], queryFn: () => api<{ providers: Provider[] }>('/v1/model-options'), staleTime: 60_000 });
}

export function ModelChoice({ value, onChange, noneLabel = 'Each step\'s own default (set on the server)', nameBase = 'model' }: {
  value: ModelValue;
  onChange: (v: ModelValue) => void;
  /** What "no choice" means here: the server default, or the workflow's default for a run. */
  noneLabel?: string;
  nameBase?: string;
}) {
  const options = useModelOptions();
  const providers = options.data?.providers ?? [];
  const provider = providers.find((p) => p.id === value.provider);
  const list = useQuery({
    queryKey: ['model-options', 'models', value.provider],
    queryFn: () => api<ModelList>(`/v1/model-options/models?provider=${encodeURIComponent(value.provider!)}`),
    enabled: Boolean(value.provider),
    staleTime: 5 * 60_000,
  });
  const models = list.data?.models ?? [];
  const listed = !value.name || models.some((m) => m.id === value.name);
  const [typing, setTyping] = useState(false);
  const other = typing || (Boolean(value.name) && !listed && models.length > 0) || (Boolean(value.provider) && !models.length && !list.isLoading);
  const [custom, setCustom] = useState(value.name && !listed ? value.name : '');
  // Not a form of its own: the picker sits inside the run form and the editor's forms.
  const useCustom = () => {
    if (!custom.trim()) return;
    onChange({ provider: value.provider, name: custom.trim() });
    setTyping(false);
  };
  const pid = useId();
  const mid = useId();
  return (
    <div className="model-picker" role="group" aria-label="Choice for default-model steps">
      <label htmlFor={pid}>
        <span className="muted small">Provider</span>
        <select id={pid} name={`${nameBase}-provider`} value={value.provider ?? ''} onChange={(e) => { setTyping(false); onChange(e.target.value ? { provider: e.target.value } : {}); }}>
          <option value="">{noneLabel}</option>
          {providers.map((p) => <option key={p.id} value={p.id} title={p.reason}>{p.label}{p.ready ? '' : ' (not signed in)'}</option>)}
        </select>
      </label>
      {value.provider ? (
        <label htmlFor={mid}>
          <span className="muted small">Model</span>
          <select
            id={mid}
            name={`${nameBase}-model`}
            value={other ? OTHER : (value.name ?? '')}
            disabled={list.isLoading}
            onChange={(e) => {
              if (e.target.value === OTHER) setTyping(true);
              else {
                setTyping(false);
                onChange({ provider: value.provider, ...(e.target.value ? { name: e.target.value } : {}) });
              }
            }}
          >
            <option value="">{provider?.server_default_model ? `Server default (${provider.server_default_model})` : `Server default (${provider?.server_default_env ?? 'not set'})`}</option>
            {models.map((m) => <option key={m.id} value={m.id} title={m.id}>{m.label}{m.id === list.data?.recommended?.id ? ' · Recommended' : ''}</option>)}
            <option value={OTHER}>Other model id…</option>
          </select>
        </label>
      ) : null}
      {value.provider && other ? (
        <div className="row">
          <input type="text" aria-label="Model id" placeholder="model id, for example gpt-5" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); useCustom(); } }} />
          <button type="button" disabled={!custom.trim()} onClick={useCustom}>Use</button>
        </div>
      ) : null}
      <div className="model-note muted small">
        Applies to steps that use the default model. A step that names its own provider and model keeps them.
        {provider && !provider.ready ? <span className="block warn-text">{provider.label} is not signed in here: {provider.reason}.</span> : null}
        {provider && !provider.server_default_model && !value.name ? <span className="block warn-text">No default {provider.label} model is set on the server ({provider.server_default_env}); pick one.</span> : null}
        {list.data?.note ? <span className="block">{list.data.note}.</span> : null}
        {provider ? <span className="block">Runs through {provider.executors.join(' or ')}; a step on another executor is marked unsupported in the plan.</span> : null}
      </div>
    </div>
  );
}

const SOURCE: Record<string, { label: string; tone?: string }> = {
  run_choice: { label: 'chosen for this run', tone: 'ok' },
  workflow_default: { label: 'workflow default', tone: 'ok' },
  server_default: { label: 'server default' },
  profile: { label: 'named by the step', tone: 'idle' },
};

/** Which provider and model each agent step will use, and whether the choice or the step decided it. */
export function ModelSteps({ plan }: { plan?: Pick<RunPlan, 'nodes'> }) {
  const rows = (plan?.nodes ?? []).filter((n) => n.model);
  if (!rows.length) return null;
  return (
    <div className="table-wrap" aria-label="Model of each agent step">
      <table>
        <thead><tr><th>Step</th><th>Provider</th><th>Model</th><th>Chosen by</th></tr></thead>
        <tbody>
          {rows.map((n) => {
            const m = n.model!;
            const unsupported = n.requirements.some((r) => r.name === 'model binding' && r.mark === 'unsupported');
            return (
              <tr key={n.id}>
                <td className="mono">{n.id}</td>
                <td>{m.provider}</td>
                <td className="mono">{m.name ?? '—'}</td>
                <td>{unsupported ? <Badge tone="bad">not supported here</Badge> : <Badge tone={SOURCE[m.source]?.tone}>{SOURCE[m.source]?.label ?? m.source}</Badge>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
