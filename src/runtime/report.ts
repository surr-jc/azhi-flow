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

export function renderReport(template: string, input: unknown, opts: { summary?: unknown; asOf: Record<string, string>; format: string }): ReportOutput {
  const view = {
    ...(input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : { input }),
    as_of: Object.entries(opts.asOf)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, observed_at]) => ({ source, observed_at })),
  };
  // Markdown and CSV are not HTML: do not HTML-escape values.
  const escape = opts.format === 'html' ? undefined : (s: unknown) => String(s);
  const markdown = Mustache.render(template, view, undefined, escape ? { escape } : undefined);
  const citations = Array.isArray((view as Record<string, unknown>).citations) ? ((view as Record<string, unknown>).citations as unknown[]) : [];
  const summary = typeof opts.summary === 'string' ? opts.summary : firstParagraph(markdown);
  return { markdown, summary, format: opts.format, citations, as_of: opts.asOf };
}

function firstParagraph(md: string): string {
  const paras = md.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith('#'));
  return paras[0] ?? md.trim();
}
