import Mustache from 'mustache';

/**
 * Report rendering (spec section 7, Report node). Templates are logic-less Mustache, so a
 * template can format numbers it is given but never compute or change them. Reports carry
 * per-source as-of times and citations.
 */
export interface ReportOutput {
  markdown: string;
  summary: string;
  format: string;
  citations: unknown[];
  as_of: Record<string, string>;
}

export interface CitationSource {
  id: string;
  dataset: string;
  revision: number;
  document: string;
  heading: string;
  start: number;
  end: number;
}

export const CITATION_ID = /^c_[0-9a-f]{20}$/;

/** Every citation ID in a value, in order of first appearance. */
export function citationIds(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') {
    if (CITATION_ID.test(v) && !out.includes(v)) out.push(v);
  } else if (Array.isArray(v)) v.forEach((x) => citationIds(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => citationIds(x, out));
  return out;
}

/** Citation IDs become footnote numbers for display; the output keeps the IDs for audit. */
function numberCitations(v: unknown, n: Map<string, number>): unknown {
  if (typeof v === 'string') return n.has(v) ? String(n.get(v)) : v;
  if (Array.isArray(v)) return v.map((x) => numberCitations(x, n));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, numberCitations(x, n)]));
  return v;
}

export function renderReport(
  template: string,
  input: unknown,
  opts: { summary?: unknown; asOf: Record<string, string>; format: string; sources?: CitationSource[] },
): ReportOutput {
  const known = new Map((opts.sources ?? []).map((s) => [s.id, s]));
  const ids = citationIds(input).filter((id) => known.has(id));
  const numbers = new Map(ids.map((id, i) => [id, i + 1]));
  const citations = ids.map((id) => ({ n: numbers.get(id)!, ...known.get(id)! }));
  const shown = numberCitations(input, numbers);
  const view = {
    ...(shown && typeof shown === 'object' && !Array.isArray(shown) ? (shown as Record<string, unknown>) : { input: shown }),
    citations,
    as_of: Object.entries(opts.asOf)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, observed_at]) => ({ source, observed_at })),
  };
  // Markdown and CSV are not HTML: do not HTML-escape values.
  const escape = opts.format === 'html' ? undefined : (s: unknown) => String(s);
  const markdown = Mustache.render(template, view, undefined, escape ? { escape } : undefined);
  const summary = typeof opts.summary === 'string' ? opts.summary : firstParagraph(markdown);
  return { markdown, summary, format: opts.format, citations, as_of: opts.asOf };
}

function firstParagraph(md: string): string {
  const paras = md.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith('#'));
  return paras[0] ?? md.trim();
}
