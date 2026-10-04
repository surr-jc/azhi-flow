import type { JsonSchema } from '../definition/types.js';

/** JSON Schema helpers for compile-time ref type-checking. */

export type Resolved = { ok: true; schema: JsonSchema | undefined } | { ok: false; error: string };

/** `undefined` schema means "unknown": anything goes, nothing is checked. */
export function resolvePath(root: JsonSchema | undefined, segments: string[]): Resolved {
  let current = deref(root, root);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (current === undefined) return { ok: true, schema: undefined };
    if (current.oneOf || current.anyOf) return { ok: true, schema: undefined };
    const types = typesOf(current);
    if (types.includes('array') && /^\d+$/.test(seg)) {
      current = deref(root, current.items as JsonSchema | undefined);
      continue;
    }
    if (types.includes('object') || current.properties) {
      const props = (current.properties ?? {}) as Record<string, JsonSchema>;
      if (seg in props) {
        current = deref(root, props[seg]);
        continue;
      }
      const ap = current.additionalProperties;
      if (ap && typeof ap === 'object') {
        current = deref(root, ap as JsonSchema);
        continue;
      }
      if (ap === false || current.properties) {
        const known = Object.keys(props);
        return { ok: false, error: `no field '${seg}' at '${segments.slice(0, i).join('.') || '<root>'}'${known.length ? ` (known: ${known.join(', ')})` : ''}` };
      }
      return { ok: true, schema: undefined };
    }
    if (types.length === 0) return { ok: true, schema: undefined };
    return { ok: false, error: `'${segments.slice(0, i).join('.') || '<root>'}' is ${types.join('|')}, cannot select '${seg}'` };
  }
  return { ok: true, schema: current };
}

function deref(root: JsonSchema | undefined, s: JsonSchema | undefined): JsonSchema | undefined {
  let cur = s;
  for (let guard = 0; cur && typeof cur.$ref === 'string' && guard < 16; guard++) {
    const ref = cur.$ref as string;
    if (!ref.startsWith('#/')) return undefined;
    cur = ref
      .slice(2)
      .split('/')
      .reduce<any>((acc, k) => acc?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  }
  return cur;
}

export function typesOf(s: JsonSchema | undefined): string[] {
  if (!s) return [];
  if (Array.isArray(s.type)) return s.type as string[];
  if (typeof s.type === 'string') return [s.type];
  if (s.properties) return ['object'];
  if (s.items) return ['array'];
  if (s.enum && Array.isArray(s.enum)) return [...new Set((s.enum as unknown[]).map(jsonType))];
  if ('const' in s) return [jsonType(s.const)];
  return [];
}

export function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v === 'number' ? 'number' : typeof v === 'object' ? 'object' : typeof v;
}

/** Whether a producer schema can satisfy a consumer schema, judged by top-level JSON types. */
export function compatible(producer: JsonSchema | undefined, consumer: JsonSchema | undefined): boolean {
  const p = typesOf(producer);
  const c = typesOf(consumer);
  if (!p.length || !c.length) return true;
  return p.every((t) => c.includes(t) || (t === 'integer' && c.includes('number')) || t === 'null' && c.includes('null'));
}

/** Schema of a literal value, for config entries and literal arguments. */
export function schemaOfLiteral(v: unknown): JsonSchema {
  if (Array.isArray(v)) return { type: 'array', items: v.length ? schemaOfLiteral(v[0]) : {} };
  if (v && typeof v === 'object') {
    return { type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaOfLiteral(x)])) };
  }
  return { type: jsonType(v) };
}

/**
 * Projects a schema to declared fields (dotted paths). Arrays are projected element-wise.
 * Returns the projected schema and any fields that do not exist.
 */
export function projectSchema(schema: JsonSchema | undefined, fields: string[]): { schema: JsonSchema | undefined; unknown: string[] } {
  if (!schema) return { schema: undefined, unknown: [] };
  if (typesOf(schema).includes('array') && schema.items) {
    const inner = projectSchema(schema.items as JsonSchema, fields);
    return { schema: { ...schema, items: inner.schema }, unknown: inner.unknown };
  }
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const out: Record<string, JsonSchema> = {};
  const unknown: string[] = [];
  const groups = new Map<string, string[]>();
  for (const f of fields) {
    const [head, ...rest] = f.split('.');
    if (!(head! in props)) {
      if (!schema.additionalProperties) unknown.push(f);
      continue;
    }
    groups.set(head!, [...(groups.get(head!) ?? []), ...(rest.length ? [rest.join('.')] : [])]);
  }
  for (const [head, rest] of groups) {
    if (!rest.length || fields.includes(head)) out[head] = props[head]!;
    else {
      const inner = projectSchema(props[head], rest);
      out[head] = inner.schema ?? {};
      unknown.push(...inner.unknown.map((u) => `${head}.${u}`));
    }
  }
  const required = ((schema.required ?? []) as string[]).filter((r) => r in out);
  return { schema: { type: 'object', properties: out, ...(required.length ? { required } : {}) }, unknown };
}
