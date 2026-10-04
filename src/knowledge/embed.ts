/**
 * The alpha embedder: a deterministic feature-hashing ("lexical-hash") vector over word
 * unigrams and bigrams. It needs no model or network, so retrieval works on a fresh install and
 * in tests. A real embedding model is a new embedder name and therefore a new index revision.
 */
export const EMBEDDER = 'lexical-hash-v1';
export const DIMENSIONS = 256;

const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the this to was were will with'.split(' '));

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t));
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function embed(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  const ts = tokens(text);
  const add = (f: string, w: number) => {
    const h = fnv1a(f);
    v[h % DIMENSIONS]! += h & 0x80000000 ? -w : w;
  };
  ts.forEach((t, i) => {
    add(t, 1);
    if (i > 0) add(`${ts[i - 1]} ${t}`, 0.5);
  });
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
  return v.map((x) => Number((x / norm).toFixed(6)));
}

export const toPgVector = (v: number[]) => `[${v.join(',')}]`;
