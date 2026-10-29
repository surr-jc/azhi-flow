/** The shape the canvas takes (components/WorkflowCanvas.PlanNode), kept here so this file stands alone. */
export interface PlanNode {
  id: string;
  type: string;
  deps: string[];
  route?: { condition: string; route: string };
  def?: Record<string, any>;
  /** Shared contexts the step takes input from, and the steps each one reads. */
  bundles?: Array<{ name: string; from: string[] }>;
}

type Definition = Record<string, any> & { id?: string; nodes: Array<Record<string, any> & { id: string; type: string }> };

const NODE_REF = /nodes\.([A-Za-z_][A-Za-z0-9_]*)/g;

const isExpr = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && ['ref', 'cel', 'map'].includes(Object.keys(v)[0]!) && typeof (v as Record<string, unknown>)[Object.keys(v)[0]!] === 'string';

/** The graph as the compiler will see it: depends_on, condition routes, refs to other steps, and the refs inside the contexts a step uses. */
export function graphOf(def: Pick<Definition, 'nodes'> & { contexts?: Record<string, Record<string, unknown>> }): PlanNode[] {
  const ids = new Set(def.nodes.map((n) => n.id));
  const routeOf = new Map<string, { condition: string; route: string }>();
  for (const n of def.nodes) {
    if (n.type !== 'condition') continue;
    for (const [route, members] of Object.entries((n.routes ?? {}) as Record<string, unknown>)) {
      if (Array.isArray(members)) for (const m of members) if (typeof m === 'string' && !routeOf.has(m)) routeOf.set(m, { condition: n.id, route });
    }
  }
  return def.nodes.map((n) => {
    const deps = new Set<string>(Array.isArray(n.depends_on) ? n.depends_on : []);
    const route = routeOf.get(n.id);
    if (route) deps.add(route.condition);
    const { id: _id, depends_on: _d, routes: _r, ...rest } = n;
    for (const m of JSON.stringify(rest).matchAll(NODE_REF)) deps.add(m[1]!);
    const names: string[] = Array.isArray(n.context) ? n.context.filter((x: unknown): x is string => typeof x === 'string') : [];
    const bundles = names.map((name) => ({ name, from: [...new Set([...JSON.stringify(def.contexts?.[name] ?? null).matchAll(NODE_REF)].map((m) => m[1]!))].filter((d) => d !== n.id && ids.has(d)) }));
    for (const b of bundles) for (const d of b.from) deps.add(d);
    // The step as it compiles: the bundle keys merged into its input, so cards and the drawer show where its data comes from.
    const own = n.input;
    const merge = bundles.length && def.contexts && (own === undefined || (own && typeof own === 'object' && !Array.isArray(own) && !isExpr(own)));
    const shown = merge ? { ...n, input: { ...Object.assign({}, ...names.map((name) => def.contexts![name] ?? {})), ...(own ?? {}) } } : n;
    return { id: n.id, type: n.type, deps: [...deps].filter((d) => d !== n.id && ids.has(d)), route, def: shown, ...(bundles.length ? { bundles } : {}) };
  });
}

type Step = Record<string, any> & { id: string; type: string };
type EditableDefinition = Record<string, any> & { id: string; nodes: Step[] };

/** Renames a step and every reference to it: depends_on, routes, refs and CEL, in the steps and in the shared contexts. */
export function renameStep(def: EditableDefinition, from: string, to: string): EditableDefinition {
  const swap = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(new RegExp(`nodes\.${from}(?![A-Za-z0-9_])`, 'g'), `nodes.${to}`));
  return {
    ...def,
    // Shared contexts hold refs too; the key stays out when the workflow has none.
    ...(def.contexts ? { contexts: swap(def.contexts) } : {}),
    nodes: def.nodes.map((n) => {
      const { id, type, depends_on, routes, ...rest } = n;
      const out: Step = { id: id === from ? to : id, type, ...(swap(rest) as object) };
      if (depends_on) out.depends_on = depends_on.map((d: string) => (d === from ? to : d));
      if (routes) out.routes = Object.fromEntries(Object.entries(routes as Record<string, string[]>).map(([k, ms]) => [k, Array.isArray(ms) ? ms.map((m) => (m === from ? to : m)) : ms]));
      return reorder(out);
    }),
  };
}

/** Keeps the usual key order (id, type, description, depends_on first) so the YAML reads well. */
export function reorder(n: Step): Step {
  const { id, type, description, depends_on, ...rest } = n;
  return { id, type, ...(description !== undefined ? { description } : {}), ...(depends_on?.length ? { depends_on } : {}), ...rest };
}

/** Shared contexts: name, the keys it holds, and the steps that list it. */
export function contextsUsed(d: { def?: Record<string, any>; nodes: Array<{ id: string; def?: Record<string, any> }> }): Array<{ name: string; values: Record<string, unknown>; steps: string[] }> {
  const defs = (d.def?.contexts ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(defs).map(([name, values]) => ({ name, values, steps: d.nodes.filter((n) => Array.isArray(n.def?.context) && n.def!.context.includes(name)).map((n) => n.id) }));
}
