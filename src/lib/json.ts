/** Converts CEL results (BigInt ints, Dates, Maps) into plain JSON values. */
export function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), toJson(v)]));
  if (value instanceof Set) return [...value].map(toJson);
  if (Array.isArray(value)) return value.map(toJson);
  if (value instanceof Uint8Array) return Array.from(value);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJson(v);
    return out;
  }
  return value;
}

/** UTF-8 byte length of the value's JSON encoding. Safe inside the Temporal workflow sandbox. */
export function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? 'null').length;
}
