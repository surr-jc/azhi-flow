import { AzhiError, ErrorClass } from '../lib/errors.js';
import { sha256 } from '../lib/hash.js';
import { byteSize } from '../lib/json.js';

export interface ContextLimits {
  maxItemBytes?: number;
  maxInputBytes?: number;
  onExceed: 'fail' | 'withhold';
}

export interface Withheld {
  key: string;
  bytes: number;
  sha256: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Caps the bytes of input that reach a model (spec: exact bytes of the JSON encoding, never an
 * estimate). `fail` stops the step on any breach. `withhold` replaces the oversized top-level
 * fields with a note, largest first, and still fails when that is not enough. A withheld value is
 * never stored again here: it already exists as an upstream output.
 */
export function applyContextBudget(input: unknown, limits: ContextLimits, node: string): { input: unknown; withheld: Withheld[] } {
  const { maxItemBytes, maxInputBytes, onExceed } = limits;
  if (maxItemBytes === undefined && maxInputBytes === undefined) return { input, withheld: [] };
  const fail = (what: string): never => {
    throw new AzhiError(ErrorClass.budgetExceeded, `node '${node}' ${what}; raise its context_budget, send less, or set on_exceed: withhold if the step can do without the field`);
  };

  if (!isObject(input)) {
    const bytes = byteSize(input);
    if (maxInputBytes !== undefined && bytes > maxInputBytes) fail(`input is ${bytes} bytes, above context_budget.max_input_bytes of ${maxInputBytes}`);
    if (maxItemBytes !== undefined && bytes > maxItemBytes) fail(`input is ${bytes} bytes, above context_budget.max_item_bytes of ${maxItemBytes}`);
    return { input, withheld: [] };
  }

  const sizes = new Map(Object.entries(input).map(([k, v]) => [k, byteSize(v)]));
  const over = (k: string) => maxItemBytes !== undefined && sizes.get(k)! > maxItemBytes;
  if (onExceed === 'fail') {
    for (const k of sizes.keys()) if (over(k)) fail(`input field '${k}' is ${sizes.get(k)} bytes, above context_budget.max_item_bytes of ${maxItemBytes}`);
    const total = byteSize(input);
    if (maxInputBytes !== undefined && total > maxInputBytes) fail(`input is ${total} bytes, above context_budget.max_input_bytes of ${maxInputBytes}`);
    return { input, withheld: [] };
  }

  const out: Record<string, unknown> = { ...input };
  const withheld: Withheld[] = [];
  const withhold = (k: string) => {
    const bytes = sizes.get(k)!;
    withheld.push({ key: k, bytes, sha256: sha256(JSON.stringify(input[k]) ?? 'null') });
    out[k] = { note: `withheld: ${bytes} bytes, above this step's context_budget; you cannot read it. Say so if it matters to your result.`, bytes, sha256: withheld[withheld.length - 1]!.sha256 };
    sizes.set(k, byteSize(out[k]));
  };
  for (const k of sizes.keys()) if (over(k)) withhold(k);
  if (maxInputBytes !== undefined) {
    const done = new Set(withheld.map((w) => w.key));
    while (byteSize(out) > maxInputBytes) {
      // Largest remaining field first; Map order breaks ties.
      let pick: string | undefined;
      for (const [k, n] of sizes) if (!done.has(k) && (pick === undefined || n > sizes.get(pick)!)) pick = k;
      if (pick === undefined) fail(`input is still ${byteSize(out)} bytes with every field withheld, above context_budget.max_input_bytes of ${maxInputBytes}`);
      withhold(pick!);
      done.add(pick!);
    }
  }
  return { input: out, withheld };
}
