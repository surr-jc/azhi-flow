import { useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

// Agent and model text is rendered as GitHub-flavored Markdown. Raw HTML in it is dropped (never
// injected), unsafe link protocols are stripped by react-markdown's URL filter, links open in a new
// tab without an opener, and images show as links so a message cannot load remote content.
const COMPONENTS: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
  img: ({ src, alt }) => (typeof src === 'string' && src ? <a href={src} target="_blank" rel="noopener noreferrer nofollow">{alt || src}</a> : <>{alt}</>),
  table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
};
const PLUGINS = [remarkGfm, remarkBreaks];

/** Markdown from an agent or model, rendered safely. `inline` keeps a one-line message inline. */
export function Markdown({ text, inline, className }: { text: string; inline?: boolean; className?: string }) {
  const body = (
    <ReactMarkdown
      remarkPlugins={PLUGINS}
      skipHtml
      urlTransform={defaultUrlTransform}
      components={inline ? { ...COMPONENTS, p: ({ children }) => <>{children}</> } : COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
  return inline ? <span className={className ? `md md-inline ${className}` : 'md md-inline'}>{body}</span> : <div className={className ? `md ${className}` : 'md'}>{body}</div>;
}

/** Markdown reduced to plain words, for one-line summaries. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A string that holds JSON (bare, or in a ```json fence) parsed; otherwise undefined. */
export function parseJsonText(s: string): unknown {
  let t = s.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export const fieldLabel = (k: string) => {
  const t = k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const isScalar = (v: unknown) => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
const scalar = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const looksLikeId = (s: string) => /^\S+$/.test(s) && s.length < 80 && !/[*_`#[]/.test(s);

/**
 * Any JSON value as something a person can read: objects as labelled fields, lists of records as
 * tables, nested records as sections, and text as rendered Markdown. `plain` shows text as
 * preformatted instead (tool input and output, where Markdown would mangle commands and files).
 */
export function Value({ value, plain, depth = 0 }: { value: unknown; plain?: boolean; depth?: number }): ReactNode {
  if (typeof value === 'string') {
    const parsed = depth < 6 ? parseJsonText(value) : undefined;
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) return <Value value={parsed} plain={plain} depth={depth + 1} />;
    if (!value.trim()) return <span className="muted">empty</span>;
    if (plain) return value.includes('\n') || value.length > 120 ? <pre className="json">{value}</pre> : <span className="mono">{value}</span>;
    if (looksLikeId(value)) return <span className={/[/.:]/.test(value) ? 'mono' : undefined}>{value}</span>;
    return <Markdown text={value} inline={!value.includes('\n') && value.length < 200} />;
  }
  if (isScalar(value)) return <>{scalar(value)}</>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">none</span>;
    if (value.every((v) => isScalar(v) && (typeof v !== 'string' || (v.length < 60 && !v.includes('\n'))))) return <>{value.map(scalar).join(', ')}</>;
    if (value.every(isScalar)) return <ul className="v-list">{value.map((v, i) => <li key={i}><Value value={v} plain={plain} depth={depth + 1} /></li>)}</ul>;
    const cols = [...new Set(value.flatMap((r) => (isRecord(r) ? Object.keys(r) : [])))];
    const flat = value.every((r) => isRecord(r) && Object.values(r).every((x) => isScalar(x) && (typeof x !== 'string' || x.length < 160)));
    if (flat && cols.length && cols.length <= 7 && value.length <= 100) {
      return (
        <div className="table-wrap">
          <table className="v-table">
            <thead><tr>{cols.map((c) => <th key={c}>{fieldLabel(c)}</th>)}</tr></thead>
            <tbody>{value.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}><Value value={(r as Record<string, unknown>)[c] ?? null} plain={plain} depth={depth + 1} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
    return (
      <ol className="v-items">
        {value.map((v, i) => <li key={i}><Value value={v} plain={plain} depth={depth + 1} /></li>)}
      </ol>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="muted">none</span>;
  return (
    <dl className={`v-fields ${depth ? 'nested' : ''}`}>
      {entries.map(([k, v]) => {
        const big = !isScalar(v) && depth >= 2;
        return (
          <div key={k} className="v-field">
            <dt>{fieldLabel(k)}</dt>
            <dd>
              {big ? (
                <details>
                  <summary className="small muted">{Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : `${Object.keys(v as object).length} fields`}</summary>
                  <Value value={v} plain={plain} depth={depth + 1} />
                </details>
              ) : (
                <Value value={v} plain={plain} depth={depth + 1} />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** A value formatted for reading, with the raw JSON one click away. */
export function Formatted({ value, plain, rawLabel = 'raw JSON' }: { value: unknown; plain?: boolean; rawLabel?: string }) {
  const [raw, setRaw] = useState(false);
  if (value === undefined) return <span className="muted">—</span>;
  const structured = typeof value === 'object' && value !== null;
  const jsonish = typeof value === 'string' && parseJsonText(value) !== undefined;
  return (
    <div className="formatted">
      {raw ? <pre className="json">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre> : <Value value={value} plain={plain} />}
      {structured || jsonish ? (
        <button type="button" className="link small" onClick={() => setRaw((x) => !x)}>{raw ? 'Show formatted' : `Show ${rawLabel}`}</button>
      ) : null}
    </div>
  );
}
