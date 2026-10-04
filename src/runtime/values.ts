/**
 * Resolves definition values (refs, CEL expressions, CEL maps, literals) against run state.
 * Runs inside the Temporal workflow sandbox: deterministic, no Node-only imports.
 */
import { evaluateCel, type CelScope } from '../cel/evaluator.js';
import { isValueExpr, type Value } from '../definition/types.js';

export interface ValueScope extends CelScope {
  nodes: Record<string, { output?: unknown }>;
}

/** A ref that reaches into an output stored as an artifact; resolved by the activity that receives it. */
export interface DeferredRef {
  $artifact_path: { hash: string; path: string[] };
}

export function resolveRef(ref: string, scope: ValueScope): unknown {
  const segments = ref.split('.');
  let current: unknown = (scope as unknown as Record<string, unknown>)[segments[0]!];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    if (current && typeof current === 'object' && '$artifact' in (current as object)) {
      const handle = (current as { $artifact: { hash: string } }).$artifact;
      return { $artifact_path: { hash: handle.hash, path: segments.slice(i) } } satisfies DeferredRef;
    }
    if (current === null || current === undefined) return undefined;
    current = Array.isArray(current) && /^\d+$/.test(seg) ? current[Number(seg)] : (current as Record<string, unknown>)[seg];
  }
  return current;
}

export function resolveValue(value: Value | undefined, scope: ValueScope): unknown {
  if (value === undefined) return undefined;
  if (isValueExpr(value)) {
    if ('ref' in value) return resolveRef(value.ref, scope);
    if ('cel' in value) return evaluateCel(value.cel, scope);
    return evaluateCel(value.map, scope);
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v as Value, scope)]));
  }
  return value;
}
