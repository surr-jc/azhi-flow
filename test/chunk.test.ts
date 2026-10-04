import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkDocument, normalise } from '../src/knowledge/chunk.js';
import { DIMENSIONS, embed } from '../src/knowledge/embed.js';

describe('chunking and embedding', () => {
  const text = normalise(readFileSync('test/fixtures/knowledge/quality-guidelines.md', 'utf8'));
  const chunks = chunkDocument(text, 'text/markdown');

  it('splits Markdown at headings and keeps the heading path', () => {
    expect(chunks.map((c) => c.heading)).toEqual([
      'Quality guidelines',
      'Quality guidelines > Pass rate',
      'Quality guidelines > Flaky tests',
      'Quality guidelines > Flaky tests > Quarantine',
      'Quality guidelines > Flaky tests > Flake rate',
      'Quality guidelines > Mean time to green',
    ]);
  });

  it('maps every chunk to exact offsets in the normalised document', () => {
    for (const c of chunks) expect(text.slice(c.start, c.end)).toBe(c.text);
  });

  it('falls back to fixed-size chunks for long paragraphs', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const cs = chunkDocument(long, 'text/plain');
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.every((c) => c.text.length <= 1200)).toBe(true);
    for (const c of cs) expect(long.slice(c.start, c.end).trim()).toBe(c.text);
  });

  it('ignores headings inside code fences and normalises line endings', () => {
    const md = normalise('# A\r\n\r\ntext\r\n\r\n```\r\n# not a heading\r\n```\r\n');
    expect(chunkDocument(md, 'text/markdown').map((c) => c.heading)).toEqual(['A']);
  });

  it('embeds deterministically into unit vectors where related text is closer', () => {
    const a = embed('flaky tests quarantine owner');
    expect(a).toHaveLength(DIMENSIONS);
    expect(embed('flaky tests quarantine owner')).toEqual(a);
    const dot = (x: number[], y: number[]) => x.reduce((n, v, i) => n + v * y[i]!, 0);
    expect(dot(a, a)).toBeCloseTo(1, 4);
    expect(dot(a, embed('quarantine flaky tests'))).toBeGreaterThan(dot(a, embed('mean time to green hours')));
  });
});
