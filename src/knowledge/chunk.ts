/**
 * Parsing and chunking (spec section 11). Markdown is split at headings and packed by paragraph;
 * plain text uses the same paragraph packing without headings. Every chunk is an exact
 * substring of the normalised document, so a citation maps to immutable offsets.
 */
export const PARSER = 'text-md-v1';
export const CHUNKER = 'heading-paragraph-v1';
const MAX_CHARS = 1200;

export interface DocChunk {
  heading: string;
  text: string;
  start: number;
  end: number;
}

/** Line endings to LF, trailing whitespace and BOM removed: the text that offsets refer to. */
export function normalise(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

export function chunkDocument(text: string, mediaType: 'text/markdown' | 'text/plain'): DocChunk[] {
  const sections: Array<{ heading: string; start: number; end: number }> = [];
  if (mediaType === 'text/markdown') {
    const path: string[] = [];
    let start = 0;
    let heading = '';
    const re = /^(#{1,6})[ \t]+(.+)$/gm;
    let m: RegExpExecArray | null;
    let inFence = false;
    // Headings inside fenced code blocks are not headings.
    const fences = [...text.matchAll(/^```/gm)].map((f) => f.index!);
    while ((m = re.exec(text))) {
      inFence = fences.filter((f) => f < m!.index).length % 2 === 1;
      if (inFence) continue;
      if (m.index > start) sections.push({ heading, start, end: m.index });
      const level = m[1]!.length;
      path.length = level - 1;
      path[level - 1] = m[2]!.trim();
      heading = path.filter(Boolean).join(' > ');
      start = m.index + m[0].length;
    }
    sections.push({ heading, start, end: text.length });
  } else {
    sections.push({ heading: '', start: 0, end: text.length });
  }

  const chunks: DocChunk[] = [];
  for (const s of sections) {
    // Paragraph spans within the section.
    const paras: Array<[number, number]> = [];
    const re = /\S[\s\S]*?(?=\n\s*\n|$)/g;
    const body = text.slice(s.start, s.end);
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) paras.push([s.start + m.index, s.start + m.index + m[0].length]);
    let cur: [number, number] | undefined;
    const flush = () => {
      if (cur) chunks.push({ heading: s.heading, text: text.slice(cur[0], cur[1]), start: cur[0], end: cur[1] });
      cur = undefined;
    };
    for (const [a, b] of paras) {
      if (b - a > MAX_CHARS) {
        // Fixed-size fallback for an oversized paragraph, cut at whitespace where possible.
        flush();
        let p = a;
        while (p < b) {
          let e = Math.min(b, p + MAX_CHARS);
          if (e < b) {
            const ws = text.lastIndexOf(' ', e);
            if (ws > p + MAX_CHARS / 2) e = ws;
          }
          chunks.push({ heading: s.heading, text: text.slice(p, e).trim(), start: p, end: e });
          p = e;
          while (p < b && /\s/.test(text[p]!)) p++;
        }
        continue;
      }
      if (cur && b - cur[0] > MAX_CHARS) flush();
      cur = cur ? [cur[0], b] : [a, b];
    }
    flush();
  }
  return chunks.filter((c) => c.text.length > 0);
}
