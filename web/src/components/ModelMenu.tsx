import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { ErrorNote } from '../ui';

/**
 * The model pill and picker shared by the workflow builder and the assistant: which provider (the
 * API keys, or OpenCode with a GitHub Copilot or ChatGPT sign-in) and which of its models answer.
 */
export interface ProviderInfo { id: 'anthropic' | 'openai' | 'opencode' | 'chatgpt'; label: string; ready: boolean; model?: string; reason?: string }
interface ModelList { provider: string; models: Array<{ id: string; label: string }>; recommended?: { id: string; reason: string }; source: 'live' | 'built-in'; note?: string }
export interface Choice { provider?: string; model?: string }
const OTHER = '__other__';

/** The provider and model last picked in this browser, under `key`. */
export function loadChoice(key: string): Choice {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
export function storeChoice(key: string, c: Choice) {
  try {
    localStorage.setItem(key, JSON.stringify(c));
  } catch {
    /* remembered for this page only */
  }
}

/** The composer's model pill; opens the provider and model picker in a popover above it. */
export function ModelMenu({ providers, provider, model, onChange, modelsUrl, purpose }: { providers: ProviderInfo[]; provider?: string; model?: string; onChange: (c: Choice) => void; modelsUrl: string; purpose: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const info = providers.find((p) => p.id === provider);
  return (
    <div className="model-menu" ref={box}>
      <button type="button" className="model-pill" aria-haspopup="dialog" aria-expanded={open} aria-label="Select model" title={info ? `${info.label} · ${model ?? info.model ?? 'default'}` : undefined} onClick={() => setOpen((o) => !o)}>
        <span className="truncate">{model ?? info?.model ?? info?.label ?? 'Select model'}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? (
        <div className="model-pop" role="dialog" aria-label={`Model for ${purpose}`}>
          <ModelPicker providers={providers} provider={provider} model={model} serverDefault={info?.model} onChange={onChange} modelsUrl={modelsUrl} purpose={purpose} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Provider and model for the builder or the assistant: every provider Azhi knows (those not usable here are shown
 * disabled, with why), the provider's own model list with one recommended, and "Other" for an id the list does not show. The choice is remembered.
 */
function ModelPicker({ providers, provider, model, serverDefault, onChange, modelsUrl, purpose }: {
  providers: ProviderInfo[];
  provider?: string;
  model?: string;
  serverDefault?: string;
  onChange: (c: Choice) => void;
  modelsUrl: string;
  purpose: string;
}) {
  const list = useQuery({
    queryKey: ['models', modelsUrl, provider],
    queryFn: () => api<ModelList>(`${modelsUrl}?provider=${encodeURIComponent(provider!)}`),
    enabled: Boolean(provider),
    staleTime: 5 * 60_000,
  });
  const models = list.data?.models ?? [];
  const recommended = list.data?.recommended;
  // No pick yet: the recommended model, else what the server would use.
  const current = model ?? recommended?.id ?? serverDefault;
  const listed = models.some((m) => m.id === current);
  const [typing, setTyping] = useState(false);
  const other = typing || (Boolean(current) && !listed && models.length > 0) || (!models.length && !list.isLoading);
  const [custom, setCustom] = useState('');
  useEffect(() => setCustom(current && !listed ? current : ''), [current, listed]);
  // The model's name, as the provider's own picker shows it; the id is the option's tooltip.
  const label = (m: { id: string; label: string }) => `${m.label}${m.id === recommended?.id ? ' · Recommended' : ''}`;
  const pickedReason = current === recommended?.id ? recommended?.reason : undefined;
  return (
    <div className="model-picker" aria-label={`Model for ${purpose}`} role="group">
      <label>
        <span className="muted small">Provider</span>
        <select aria-label="Provider" value={provider ?? ''} onChange={(e) => { setTyping(false); onChange({ provider: e.target.value }); }}>
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.ready} title={p.reason}>
              {p.label}{p.ready ? '' : ' (not available)'}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="muted small">Model</span>
        <select
          aria-label="Model"
          value={other ? OTHER : (current ?? '')}
          disabled={!provider || list.isLoading}
          onChange={(e) => {
            if (e.target.value === OTHER) setTyping(true);
            else {
              setTyping(false);
              onChange({ provider, model: e.target.value });
            }
          }}
        >
          {list.isLoading ? <option value={current ?? ''}>Loading models…</option> : null}
          {models.map((m) => <option key={m.id} value={m.id} title={m.id}>{label(m)}</option>)}
          <option value={OTHER}>Other model id…</option>
        </select>
      </label>
      {other ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) { onChange({ provider, model: custom.trim() }); setTyping(false); } }}>
          <input type="text" aria-label="Model id" placeholder="model id, for example gpt-5" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button type="submit" disabled={!custom.trim()}>Use</button>
        </form>
      ) : null}
      <div className="model-note muted small">
        {pickedReason ? <>Recommended for {purpose}: {pickedReason}</> : recommended ? <>Recommended: {recommended.id}. {recommended.reason}</> : null}
        {list.data?.note ? <> {list.data.note}.</> : list.data?.source === 'built-in' ? ' Showing the built-in list.' : null}
        {providers.filter((p) => !p.ready).map((p) => <span key={p.id} className="block">{p.label} is not available: {p.reason}.</span>)}
      </div>
      <ErrorNote error={list.error} />
    </div>
  );
}
