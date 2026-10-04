/**
 * Projection (spec section 9): tool responses are reduced to declared fields before entering
 * downstream nodes or agent context. Arrays are projected element-wise. Fields are dotted paths.
 */
export function project(value: unknown, fields: string[] | undefined): unknown {
  if (!fields?.length) return value;
  if (Array.isArray(value)) return value.map((v) => project(v, fields));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  const groups = new Map<string, string[]>();
  for (const f of fields) {
    const [head, ...rest] = f.split('.');
    groups.set(head!, [...(groups.get(head!) ?? []), rest.join('.')]);
  }
  for (const [head, rests] of groups) {
    if (!(head in (value as Record<string, unknown>))) continue;
    const v = (value as Record<string, unknown>)[head];
    out[head] = rests.includes('') ? v : project(v, rests);
  }
  return out;
}

/** Default ceiling for content entering agent context. */
export const CONTEXT_CEILING_BYTES = 8 * 1024;
