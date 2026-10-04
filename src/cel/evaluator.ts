/**
 * The single CEL evaluator used by both the compiler (type-check only) and the runtime
 * (evaluation). ADR-02: no JavaScript eval anywhere. ADR-08: `now` is the run's pinned
 * reference time, never the wall clock.
 *
 * This module must stay deterministic and free of Node-only imports: the Temporal workflow
 * sandbox imports it.
 */
import { Environment } from '@marcbachmann/cel-js';
import { toJson } from '../lib/json.js';

export interface CelScope {
  inputs?: unknown;
  nodes?: Record<string, { output?: unknown }>;
  config?: unknown;
  now?: Date | string;
  item?: unknown;
  args?: unknown;
  run?: unknown;
}

export const CEL_VARIABLES = ['inputs', 'nodes', 'config', 'now', 'item', 'args', 'run'] as const;

let shared: Environment | undefined;

export function celEnvironment(): Environment {
  shared ??= new Environment({ homogeneousAggregateLiterals: false, enableOptionalTypes: true })
    .registerVariable('inputs', 'dyn')
    .registerVariable('nodes', 'dyn')
    .registerVariable('config', 'dyn')
    .registerVariable('now', 'google.protobuf.Timestamp')
    .registerVariable('item', 'dyn')
    .registerVariable('args', 'dyn')
    .registerVariable('run', 'dyn')
    // CEL's spec formats timestamps as RFC 3339; the library lacks this overload.
    .registerFunction('string(google.protobuf.Timestamp): string', (d: Date) => d.toISOString());
  return shared;
}

export interface CelCheckResult {
  valid: boolean;
  error?: string;
}

export function checkCel(expression: string): CelCheckResult {
  try {
    const r = celEnvironment().check(expression);
    return r.valid ? { valid: true } : { valid: false, error: firstLine(r.error?.message) };
  } catch (err) {
    return { valid: false, error: firstLine((err as Error).message) };
  }
}

export function evaluateCel(expression: string, scope: CelScope): unknown {
  const now = scope.now === undefined ? undefined : scope.now instanceof Date ? scope.now : new Date(scope.now);
  const ctx = {
    inputs: scope.inputs ?? {},
    nodes: scope.nodes ?? {},
    config: scope.config ?? {},
    now: now ?? new Date(0),
    item: scope.item ?? null,
    args: scope.args ?? {},
    run: scope.run ?? {},
  };
  return toJson(celEnvironment().evaluate(expression, ctx));
}

/** Node IDs referenced as `nodes.<id>` in an expression. */
export function referencedNodes(expression: string): string[] {
  const ids = new Set<string>();
  for (const m of expression.matchAll(/(?<![\w.])nodes\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) ids.add(m[1]!);
  for (const m of expression.matchAll(/(?<![\w.])nodes\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) ids.add(m[1]!);
  return [...ids];
}

function firstLine(s: string | undefined): string {
  return (s ?? 'invalid expression').split('\n')[0]!;
}
