/** The shape the canvas takes (components/WorkflowCanvas.PlanNode), kept here so this file stands alone. */
export interface PlanNode {
  id: string;
  type: string;
  deps: string[];
  route?: { condition: string; route: string };
  def?: Record<string, any>;
}

type Definition = Record<string, any> & { id?: string; nodes: Array<Record<string, any> & { id: string; type: string }> };

const NODE_REF = /nodes\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** The graph as the compiler will see it: depends_on, condition routes, and refs to other steps. */
export function graphOf(def: Pick<Definition, 'nodes'>): PlanNode[] {
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
    return { id: n.id, type: n.type, deps: [...deps].filter((d) => d !== n.id && ids.has(d)), route, def: n };
  });
}
