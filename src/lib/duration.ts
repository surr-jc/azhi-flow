const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses "250ms", "30s", "5m", "1h30m", "2d" into milliseconds. Plain numbers are seconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = '';
  for (const m of input.matchAll(re)) {
    total += Number(m[1]) * UNITS[m[2]!]!;
    consumed += m[0];
  }
  if (!consumed || consumed !== input.replace(/\s+/g, '')) throw new Error(`invalid duration: ${input}`);
  return total;
}
