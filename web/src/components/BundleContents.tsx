import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BUNDLE_KINDS, bundleItems, matchItem, type BundleItem, type BundleKind, type BundleTool, type Inventory } from '../bundle';
import { Icon } from '../icons';
import { Badge } from '../ui';

const ICON: Record<BundleKind, string> = { agents: 'agent', skills: 'retrieve', commands: 'script', mcp: 'server', tools: 'tool' };
const BLURB: Record<BundleKind, string> = {
  agents: 'Specialists the workflow hands steps to, each with its own model and prompt.',
  skills: 'Instructions an agent loads only when a task matches.',
  commands: 'The saved prompt an agent starts its turn with.',
  mcp: 'Extra tool servers started alongside an agent.',
  tools: 'What agents and steps may call: built-in read tools and the gateway tools this template registers.',
};
const EMPTY: Record<BundleKind, string> = {
  agents: 'This template has no agent profiles.',
  skills: 'No agent in this template loads skills.',
  commands: 'No agent in this template starts from a saved command.',
  mcp: 'This template starts no MCP servers.',
  tools: 'This template registers no tools.',
};

/** The number of items before the tab gets a search box. */
const SEARCH_FROM = 8;

/**
 * "What's inside" a workflow template: one tab per kind of thing it ships, a card for each, and the
 * details of the chosen card beside the grid. Everything shown comes from the template's own files and
 * is displayed as text. `compact` is the summary for the marketplace's quick look.
 */
export function BundleContents({ inventory, tools, compact, onOpen }: { inventory: Inventory | undefined; tools: BundleTool[]; compact?: boolean; onOpen?: () => void }) {
  const items = useMemo(() => (inventory ? bundleItems(inventory, tools) : undefined), [inventory, tools]);
  const firstFull = items ? BUNDLE_KINDS.find((k) => items[k.id].length)?.id ?? 'agents' : 'agents';
  const [kind, setKind] = useState<BundleKind>(firstFull);
  const [picked, setPicked] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const cards = useRef(new Map<string, HTMLButtonElement>());
  const panel = useRef<HTMLElement>(null);
  const lastPicked = useRef<string | null>(null);
  useEffect(() => setKind(firstFull), [firstFull]);

  if (!items) return null;
  const total = BUNDLE_KINDS.reduce((n, k) => n + items[k.id].length, 0);
  if (compact) {
    return (
      <div>
        <span className="label">What’s inside</span>
        {total ? (
          <ul className="bundle-strip">
            {BUNDLE_KINDS.filter((k) => items[k.id].length).map((k) => (
              <li key={k.id} className={`bk-${k.id}`}><Icon name={ICON[k.id]} size={16} /> <b>{items[k.id].length}</b> {items[k.id].length === 1 ? k.one : k.label.toLowerCase()}</li>
            ))}
          </ul>
        ) : <p className="muted small">Steps and tools only; no agents, skills or MCP servers.</p>}
        {onOpen && total ? <button type="button" className="small" onClick={onOpen}>See everything inside</button> : null}
      </div>
    );
  }

  const list = items[kind].filter((i) => matchItem(i, term));
  const current = picked ? items[kind].find((i) => i.key === picked) : undefined;
  const move = (e: KeyboardEvent, at: number) => {
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? BUNDLE_KINDS.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = (to + BUNDLE_KINDS.length) % BUNDLE_KINDS.length;
    choose(BUNDLE_KINDS[next]!.id);
    tabs.current[next]?.focus();
  };
  const choose = (k: BundleKind) => {
    setKind(k);
    setPicked(null);
    setTerm('');
  };
  const pick = (i: BundleItem) => {
    lastPicked.current = i.key;
    setPicked(i.key);
    // The panel sits beside the grid on wide screens and under it on narrow ones; focus follows either way.
    requestAnimationFrame(() => panel.current?.focus());
  };
  const close = () => {
    const back = lastPicked.current;
    setPicked(null);
    requestAnimationFrame(() => (back ? cards.current.get(back)?.focus() : undefined));
  };

  return (
    <section className="bundle" aria-label="What’s inside this template">
      <div className="bundle-tabs" role="tablist" aria-label="Kinds of things in this template">
        {BUNDLE_KINDS.map((k, at) => (
          <button
            key={k.id}
            ref={(el) => { tabs.current[at] = el; }}
            id={`bundle-tab-${k.id}`}
            type="button"
            role="tab"
            aria-selected={kind === k.id}
            aria-controls="bundle-body"
            tabIndex={kind === k.id ? 0 : -1}
            className={`bundle-tab bk-${k.id}`}
            onClick={() => choose(k.id)}
            onKeyDown={(e) => move(e, at)}
          >
            <span className="bundle-ico"><Icon name={ICON[k.id]} size={18} /></span>
            <span className="bundle-count">{items[k.id].length}</span>
            <span className="bundle-name">{k.label}</span>
          </button>
        ))}
      </div>
      <div id="bundle-body" role="tabpanel" aria-labelledby={`bundle-tab-${kind}`} className="bundle-body">
        <p className="small muted">{BLURB[kind]}</p>
        {items[kind].length > SEARCH_FROM ? (
          <label className="lbl"><span>Search {BUNDLE_KINDS.find((k) => k.id === kind)!.label.toLowerCase()}</span><input type="search" placeholder="Name or topic" value={term} onChange={(e) => setTerm(e.target.value)} /></label>
        ) : null}
        {items[kind].length === 0 ? (
          <div className="empty"><p className="empty-title">Nothing here</p><p className="muted small">{EMPTY[kind]}</p></div>
        ) : (
          <div className={`bundle-split${current ? ' has-panel' : ''}`}>
            <div>
              {list.length === 0 ? <p className="muted small">Nothing matches “{term.trim()}”.</p> : null}
              <ul className="bundle-grid">
                {list.map((i) => (
                  <li key={i.key}>
                    <button
                      type="button"
                      ref={(el) => { if (el) cards.current.set(i.key, el); else cards.current.delete(i.key); }}
                      className={`bundle-card bk-${i.kind}${picked === i.key ? ' on' : ''}`}
                      aria-pressed={picked === i.key}
                      onClick={() => (picked === i.key ? close() : pick(i))}
                    >
                      <span className="bundle-ico"><Icon name={ICON[i.kind]} size={18} /></span>
                      <span className="bundle-card-main">
                        <b className="mono">{i.title}</b>
                        {i.summary ? <span className="small muted bundle-desc">{i.summary}</span> : null}
                        <span className="row wrap">{i.chips.map((c) => <span key={c.text} className={`chip-effect${c.tone ? ` ${c.tone}` : ''}`}>{c.text}</span>)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {current ? (
              <aside className={`bundle-panel bk-${current.kind}`} ref={panel} tabIndex={-1} aria-label={`${current.title} details`} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
                <div className="row">
                  <h3 className="mono">{current.title}</h3>
                  <button type="button" className="small" style={{ marginLeft: 'auto' }} onClick={close}>Close details</button>
                </div>
                {current.summary ? <p className="small">{current.summary}</p> : null}
                {current.chips.some((c) => c.tone) ? <p>{current.chips.filter((c) => c.tone).map((c) => <Badge key={c.text} tone={c.tone!}>{c.text}</Badge>)}</p> : null}
                {current.groups.filter((g) => g.values.length).map((g) => (
                  <div className="sd-group" key={g.label}>
                    <h3>{g.label}</h3>
                    <ul className="small bundle-values">{g.values.map((v) => <li key={v} className="mono">{v}</li>)}</ul>
                  </div>
                ))}
              </aside>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
