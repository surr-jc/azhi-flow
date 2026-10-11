import { useState, type ReactNode } from 'react';
import { Icon } from '../icons';

/** A collapsible group of the harness builder: icon, title, and a one-line summary of what is set inside. */
export function HbSection({ icon, title, summary, defaultOpen, children }: { icon: string; title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="hb-sec" open={defaultOpen}>
      <summary>
        <span className="hb-ico"><Icon name={icon} size={18} /></span>
        <span className="hb-head"><b>{title}</b>{summary ? <span className="hb-sum">{summary}</span> : null}</span>
        <Icon name="chev" size={16} className="hb-chev" />
      </summary>
      <div className="hb-body">{children}</div>
    </details>
  );
}

/** Small read-only facts, such as what an executor can enforce. `tone` marks the ones to look at. */
export function FactChips({ items }: { items: Array<{ text: string; tone?: 'ok' | 'warn' | 'bad' }> }) {
  return <ul className="hb-chips" aria-label="Capabilities">{items.map((c) => <li key={c.text} className={c.tone ?? ''}>{c.text}</li>)}</ul>;
}

export interface PickItem { id: string; label: ReactNode; sub?: string; badge?: ReactNode; text: string }

/** A checkable list that filters as you type once it is long; selected items stay on top. */
export function PickList({ items, selected, onToggle, empty, label }: { items: PickItem[]; selected: string[]; onToggle: (id: string, on: boolean) => void; empty: ReactNode; label: string }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = items.filter((i) => !needle || i.text.toLowerCase().includes(needle)).sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)));
  if (!items.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="hb-pick">
      {items.length > 6 ? <input type="search" aria-label={`Filter ${label}`} placeholder={`Filter ${items.length} ${label}`} value={q} onChange={(e) => setQ(e.target.value)} /> : null}
      <ul>
        {shown.map((i) => (
          <li key={i.id}>
            <label className="check">
              <input type="checkbox" checked={selected.includes(i.id)} onChange={(e) => onToggle(i.id, e.target.checked)} />
              <span className="hb-pick-main"><span>{i.label}{i.badge ? <> {i.badge}</> : null}</span>{i.sub ? <span className="muted small">{i.sub}</span> : null}</span>
            </label>
          </li>
        ))}
        {!shown.length ? <li className="muted small">Nothing matches.</li> : null}
      </ul>
    </div>
  );
}

/** One line under the executor choice saying what it is for. */
export const EXECUTOR_BLURB: Record<string, string> = {
  'model-agent': 'Calls the model directly. Tools go through Azhi’s gateway, so every call is governed and recorded.',
  opencode: 'A coding agent working in a fresh checkout of your repository, with an agent prompt, skills, read-only tools and MCP servers.',
  'claude-agent-sdk': 'Anthropic’s agent harness, run with Azhi’s gateway as its only tools.',
};
