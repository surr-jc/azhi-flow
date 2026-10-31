import type { Diagnostic } from '../definition/load.js';
import { isValueExpr, type NodeDef, type Value, type WorkflowDefinition } from '../definition/types.js';

/**
 * Context bundles. A bundle is a named set of input values; a step that lists it in `context` gets the
 * keys added to its `input` when the workflow is compiled. Nothing about a bundle exists at run time:
 * the plan holds an ordinary `input`, so every ref in it is type-checked, ordered and tainted like one
 * written by hand, and an older interpreter runs the plan unchanged.
 */
export interface InputPart {
  key: string;
  /** `input` for a key the step wrote itself, `context:<name>` for one taken from a bundle. */
  source: string;
}

export interface BundleKey {
  bundle: string;
  key: string;
  value: Value;
}

export interface Expansion {
  /** The authored definition itself when no step uses a bundle, else a copy whose using steps have the merged input. */
  def: WorkflowDefinition;
  /** Per expanded step: where each top-level input key came from, in input order. */
  parts: Map<string, InputPart[]>;
  /** Per expanded step: the keys that came from bundles. */
  fromBundle: Map<string, BundleKey[]>;
  diagnostics: Diagnostic[];
}

const CONTEXT_TYPES = new Set(['agent', 'script', 'report']);

const isPlainObject = (v: unknown): v is Record<string, Value> => !!v && typeof v === 'object' && !Array.isArray(v) && !isValueExpr(v);

export function expandContexts(authored: WorkflowDefinition): Expansion {
  const contexts = authored.contexts ?? {};
  const diagnostics: Diagnostic[] = [];
  const err = (code: string, message: string, node: string, path: string) => diagnostics.push({ severity: 'error', code, message, node, path });
  const parts = new Map<string, InputPart[]>();
  const fromBundle = new Map<string, BundleKey[]>();
  const used = new Set<string>();
  let changed = false;

  const nodes = authored.nodes.map((n): NodeDef => {
    const names = (n as { context?: string[] }).context;
    if (!names) return n;
    for (const name of names) used.add(name);
    if (!CONTEXT_TYPES.has(n.type)) {
      err('context_unsupported_node', `'${n.type}' steps cannot take a context: a subworkflow's inputs are checked against the child workflow's schema when it runs, which a compile cannot do for merged keys`, n.id, 'context');
      return n;
    }
    if (n.merge === 'any') {
      err('context_on_merge', `step '${n.id}' joins alternative branches (merge: any), and every value in a bundle becomes a dependency: a bundle value from a step that always runs would make this step run when no branch did. Write its input out, with has() guards`, n.id, 'context');
      return n;
    }
    const own = (n as { input?: Value }).input;
    if (own !== undefined && !isPlainObject(own)) {
      err('context_input_shape', `step '${n.id}' uses a context, so its input must be an object of keys (each a ref, a cel or a literal), not ${isValueExpr(own) ? `a {${Object.keys(own)[0]}: ...} expression` : 'a list or a single value'}. To combine a {map: "..."} input with a bundle, write each key as {cel: "..."}`, n.id, 'input');
      return n;
    }
    let ok = true;
    const merged: Record<string, Value> = {};
    const source = new Map<string, { label: string; bundle?: string }>();
    const taken: BundleKey[] = [];
    const take = (key: string, value: Value, label: string, bundle?: string) => {
      if (source.has(key)) {
        err('context_collision', `input key '${key}' of step '${n.id}' comes from ${source.get(key)!.label} and from ${label}; rename one`, n.id, `input.${key}`);
        ok = false;
        return;
      }
      source.set(key, { label, bundle });
      merged[key] = structuredClone(value);
      if (bundle) taken.push({ bundle, key, value });
    };
    for (const name of names) {
      const bundle = contexts[name];
      if (!bundle) {
        err('unknown_context', `step '${n.id}' uses context '${name}', which the workflow does not define${Object.keys(contexts).length ? ` (it defines: ${Object.keys(contexts).join(', ')})` : ''}`, n.id, 'context');
        ok = false;
        continue;
      }
      for (const [key, value] of Object.entries(bundle)) take(key, value, `context '${name}'`, name);
    }
    for (const [key, value] of Object.entries(own ?? {})) take(key, value, "the step's own input");
    if (!ok) return n;
    changed = true;
    parts.set(n.id, Object.keys(merged).map((key) => ({ key, source: source.get(key)!.bundle ? `context:${source.get(key)!.bundle}` : 'input' })));
    fromBundle.set(n.id, taken);
    return { ...n, input: merged } as NodeDef;
  });

  for (const name of Object.keys(contexts)) {
    if (!used.has(name)) diagnostics.push({ severity: 'warning', code: 'unused_context', message: `context '${name}' is defined but no step uses it`, path: `/contexts/${name}` });
  }
  return { def: changed ? { ...authored, nodes } : authored, parts, fromBundle, diagnostics };
}

/**
 * Why each step can be skipped, in the interpreter's own terms (`shouldSkip`). A cause is a condition route a
 * step sits on (`route:<condition>:<route>`), an approval above it that can be rejected (`approval:<id>`), or, for
 * a step that joins branches, the join itself (`merge:<id>`), which is skipped only when every branch was.
 * A step has the causes of everything it waits on, so two steps on the same route are skipped together.
 * Failures also skip steps, but that is a run-time event, not structure.
 */
export function skipCauses(order: string[], byId: Map<string, NodeDef>, deps: Map<string, Set<string>>, routeOf: Map<string, { condition: string; route: string }>): Map<string, Set<string>> {
  const causes = new Map<string, Set<string>>();
  const through = (d: string) => new Set([...(causes.get(d) ?? []), ...(byId.get(d)?.type === 'approval' ? [`approval:${d}`] : [])]);
  for (const id of order) {
    const mine = new Set<string>();
    const r = routeOf.get(id);
    if (r) mine.add(`route:${r.condition}:${r.route}`);
    const ds = [...(deps.get(id) ?? [])];
    if (byId.get(id)?.merge === 'any') {
      // Runs when any branch got through, so it is skipped only when all were: one cause of its own, if all can be.
      if (ds.length && ds.every((d) => through(d).size)) mine.add(`merge:${id}`);
    } else {
      for (const d of ds) for (const c of through(d)) mine.add(c);
    }
    causes.set(id, mine);
  }
  return causes;
}

/** Every step reached by following `deps` from `start`. */
export function ancestorsOf(start: Iterable<string>, deps: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const d = stack.pop()!;
    if (seen.has(d)) continue;
    seen.add(d);
    for (const x of deps.get(d) ?? []) stack.push(x);
  }
  return seen;
}

/**
 * `context_may_skip`: a bundle added a dependency the step did not have, and that step can be skipped for a reason
 * that would not already skip this one. The step is then skipped whenever that one is. A dependency the step already
 * reaches some other way, or one on the same condition route, adds nothing new.
 */
export function skipCoupling(o: {
  consumers: string[];
  fromBundle: Map<string, BundleKey[]>;
  /** The nodes each bundle key refers to. */
  targets: (value: Value) => Set<string>;
  /** depends_on, the condition route and refs outside bundles, per consumer. */
  ownDeps: Map<string, Set<string>>;
  deps: Map<string, Set<string>>;
  causes: Map<string, Set<string>>;
  routeOf: Map<string, { condition: string; route: string }>;
  byId: Map<string, NodeDef>;
}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const through = (d: string) => new Set([...(o.causes.get(d) ?? []), ...(o.byId.get(d)?.type === 'approval' ? [`approval:${d}`] : [])]);
  for (const c of o.consumers) {
    const already = ancestorsOf(o.ownDeps.get(c) ?? [], o.deps);
    // Every reason this step is skipped without the bundle: its own route and what it already waits on.
    const own = new Set<string>(o.routeOf.has(c) ? [`route:${o.routeOf.get(c)!.condition}:${o.routeOf.get(c)!.route}`] : []);
    for (const a of already) for (const cause of through(a)) own.add(cause);
    const said = new Set<string>();
    for (const k of o.fromBundle.get(c) ?? []) {
      for (const d of o.targets(k.value)) {
        if (d === c || already.has(d) || said.has(d)) continue;
        const added = [...through(d)].filter((cause) => !own.has(cause));
        if (!added.length) continue;
        said.add(d);
        out.push({
          severity: 'warning',
          code: 'context_may_skip',
          message: `context '${k.bundle}' key '${k.key}' makes step '${c}' wait on '${d}', which can be skipped (${added.map(describeCause).join('; ')}); when it is, '${c}' is skipped too. Keep branch-only values out of a shared context`,
          node: c,
          path: `input.${k.key}`,
        });
      }
    }
  }
  return out;
}

function describeCause(cause: string): string {
  const [kind, a, b] = cause.split(':');
  if (kind === 'route') return `it is on route '${b}' of condition '${a}'`;
  if (kind === 'approval') return `approval '${a}' can reject it`;
  return `'${a}' joins branches that may all be skipped`;
}
