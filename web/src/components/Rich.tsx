import { useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { DiffView, looksLikeDiff } from './DiffView.js';

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

const CODE_KEY = /command|cmd|script|stdout|stderr|log|trace|diff|patch/i;
const fence = (s: string, lang = '') => {
  const ticks = '`'.repeat(Math.max(3, ...(s.match(/`+/g) ?? []).map((m) => m.length + 1)));
  return `${ticks}${lang}\n${s}\n${ticks}`;
};
const inline = (v: unknown) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : v === null || v === undefined ? '—' : String(v));

/** A JSON value written as Markdown: fields as a list, nested records and long text under headings, code in fences. */
export function toMarkdown(value: unknown, depth = 0, key?: string, plain?: boolean): string {
  if (typeof value === 'string') {
    const parsed = depth < 6 ? parseJsonText(value) : undefined;
    if (parsed !== undefined) return toMarkdown(parsed, depth, key, plain);
    if (!value.trim()) return '_empty_';
    if (looksLikeDiff(value)) return fence(value, 'diff');
    if (key && CODE_KEY.test(key)) return fence(value);
    // Tool input and output is text to read as it is, so Markdown must not reinterpret it.
    if (plain) return value.includes('\n') || value.length > 100 ? fence(value) : `\`${value}\``;
    return value;
  }
  if (isScalar(value)) return inline(value);
  if (Array.isArray(value)) {
    if (!value.length) return '_none_';
    if (value.every((v) => isScalar(v) && !(typeof v === 'string' && (v.includes('\n') || v.length > 160)))) return value.map((v) => `- ${inline(v)}`).join('\n');
    return value.map((v, i) => `**${i + 1}.**\n\n${toMarkdown(v, depth + 1, undefined, plain)}`).join('\n\n');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return '_none_';
  const hashes = '#'.repeat(Math.min(depth + 3, 6));
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) out.push(list.join('\n')); list = []; };
  for (const [k, v] of entries) {
    const short = isScalar(v) && !(typeof v === 'string' && (v.includes('\n') || v.length > 120 || CODE_KEY.test(k) || parseJsonText(v) !== undefined));
    if (short) list.push(`- **${fieldLabel(k)}:** ${inline(v)}`);
    else {
      flush();
      out.push(`${hashes} ${fieldLabel(k)}\n\n${toMarkdown(v, depth + 1, k, plain)}`);
    }
  }
  flush();
  return out.join('\n\n');
}

/** Any JSON value shown as rendered Markdown, with the raw JSON one click away. */
export function Formatted({ value, plain, rawLabel = 'raw JSON' }: { value: unknown; plain?: boolean; rawLabel?: string }) {
  const [raw, setRaw] = useState(false);
  if (value === undefined) return <span className="muted">—</span>;
  const structured = typeof value === 'object' && value !== null;
  return (
    <div className="formatted">
      {raw ? <pre className="json">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre> : <Markdown text={toMarkdown(value, 0, undefined, plain)} />}
      {structured || (typeof value === 'string' && parseJsonText(value) !== undefined) ? <button type="button" className="link small" onClick={() => setRaw((x) => !x)}>{raw ? 'Show formatted' : `Show ${rawLabel}`}</button> : null}
    </div>
  );
}
