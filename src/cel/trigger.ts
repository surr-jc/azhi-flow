/**
 * CEL for event triggers: one variable, `event` (the webhook payload). Kept apart from the run environment so a
 * workflow step cannot read `event`, and a trigger filter cannot read run state. Pure: the compiler imports it.
 */
import { Environment } from '@marcbachmann/cel-js';
import { toJson } from '../lib/json.js';

let env: Environment | undefined;
const environment = () => (env ??= new Environment({ homogeneousAggregateLiterals: false, enableOptionalTypes: true }).registerVariable('event', 'dyn'));

export function checkTriggerFilter(expression: string): { valid: boolean; error?: string } {
  try {
    const r = environment().check(expression);
    return r.valid ? { valid: true } : { valid: false, error: (r.error?.message ?? 'invalid').split('\n')[0] };
  } catch (err) {
    return { valid: false, error: (err as Error).message.split('\n')[0] };
  }
}

/** True only when the expression evaluates to the boolean `true`; an error (a missing field) means no. */
export function triggerFilterPasses(expression: string, event: unknown): { pass: boolean; error?: string } {
  try {
    return { pass: toJson(environment().evaluate(expression, { event })) === true };
  } catch (err) {
    return { pass: false, error: (err as Error).message.split('\n')[0] };
  }
}

const PATH = /^event(\.[A-Za-z_][A-Za-z0-9_]*|\.\d+)+$/;
export const validEventPath = (p: string) => PATH.test(p);

/** A scalar at `event.a.b` in the payload, or undefined. Objects and arrays are refused: only plain values become inputs. */
export function eventValue(event: unknown, path: string): string | number | boolean | undefined {
  let cur: unknown = event;
  for (const key of path.split('.').slice(1)) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? cur : undefined;
}
