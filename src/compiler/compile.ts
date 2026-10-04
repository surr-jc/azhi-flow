import { CronExpressionParser } from 'cron-parser';
import { parse as parseYamlValue } from 'yaml';
import { checkCel, referencedNodes } from '../cel/evaluator.js';
import type { Diagnostic } from '../definition/load.js';
import type { PackageSource } from '../definition/package.js';
import { isValueExpr, type JsonSchema, type NodeDef, type ParallelNode, type Value, type WorkflowDefinition } from '../definition/types.js';
import type { ToolCatalog } from '../gateway/types.js';
import { parseDuration } from '../lib/duration.js';
import { contentHash } from '../lib/hash.js';
import {
  APPROVAL_OUTPUT_SCHEMA,
  COMPILER_VERSION,
  CONDITION_OUTPUT_SCHEMA,
  DEFAULT_TIMEOUTS,
  NOTIFY_OUTPUT_SCHEMA,
  REPORT_OUTPUT_SCHEMA,
  RETRIEVE_OUTPUT_SCHEMA,
  type ExecutionPlan,
  type PlanNode,
} from './plan.js';
import { compatible, projectSchema, resolvePath, schemaOfLiteral, typesOf } from './schema-path.js';
import { analyseTaint, type DatasetInfo } from './taint.js';

export interface CompileOptions {
  pkg?: PackageSource;
  /** Dataset trust, for taint analysis. Unknown datasets are treated as trusted. */
  datasets?: (ref: string) => DatasetInfo | undefined;
  /** Without a catalog, tool references cannot be checked and a warning says so. */
  catalog?: ToolCatalog;
  /** Node types the current release can execute. */
  supportedNodeTypes?: NodeDef['type'][];
}

export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  plan?: ExecutionPlan;
}

export const ALPHA_NODE_TYPES: NodeDef['type'][] = ['script', 'agent', 'tool', 'retrieve', 'condition', 'parallel', 'approval', 'report', 'notify'];

const REF_ROOTS = new Set(['inputs', 'nodes', 'config', 'item', 'run']);

interface ExprSite {
  kind: 'ref' | 'cel' | 'map';
  text: string;
  path: string;
}

export function collectExprs(value: Value | undefined, path: string, out: ExprSite[] = []): ExprSite[] {
  if (value === undefined || value === null) return out;
  if (isValueExpr(value)) {
    const kind = Object.keys(value)[0] as ExprSite['kind'];
    out.push({ kind, text: (value as any)[kind], path });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectExprs(v, `${path}[${i}]`, out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectExprs(v as Value, `${path}.${k}`, out);
  }
  return out;
}

/** Values a node evaluates, by field name. Used for dependency inference and checks. */
export function nodeValues(n: NodeDef): Record<string, Value | undefined> {
  switch (n.type) {
    case 'tool':
      return { arguments: n.arguments as Value };
    case 'script':
    case 'agent':
    case 'subworkflow':
      return { input: n.input };
    case 'retrieve':
      return { query: n.query, filters: n.filters as Value };
    case 'parallel':
      return { for_each: n.for_each, ...prefixed('node', nodeValues({ ...(n.node as any), id: `${n.id}_item` })) };
    case 'approval':
      return { message: n.message, payload: n.payload };
    case 'report':
      return { input: n.input, summary: n.summary };
    case 'notify':
      return { destination: n.destination, message: n.message };
    default:
      return {};
  }
}

function prefixed(prefix: string, vals: Record<string, Value | undefined>) {
  return Object.fromEntries(Object.entries(vals).map(([k, v]) => [`${prefix}.${k}`, v]));
}

function nodeCel(n: NodeDef): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  if (n.type === 'condition') out.push({ path: 'expression', text: n.expression });
  if ((n.type === 'notify' || n.type === 'tool') && n.guard) out.push({ path: 'guard', text: n.guard });
  if (n.type === 'loop') out.push({ path: 'exit', text: n.exit });
  return out;
}

export function compile(def: WorkflowDefinition, opts: CompileOptions = {}): CompileResult {
  const diags: Diagnostic[] = [];
  const err = (code: string, message: string, node?: string, path?: string) => diags.push({ severity: 'error', code, message, node, path });
  const warn = (code: string, message: string, node?: string, path?: string) => diags.push({ severity: 'warning', code, message, node, path });
  const supported = opts.supportedNodeTypes ?? ALPHA_NODE_TYPES;

  // Trigger
  if (def.trigger?.schedule) {
    const { cron, timezone } = def.trigger.schedule;
    if (!isValidTimezone(timezone)) err('invalid_timezone', `'${timezone}' is not an IANA timezone`, undefined, '/trigger/schedule/timezone');
    else {
      try {
        CronExpressionParser.parse(cron, { tz: timezone });
      } catch (e) {
        err('invalid_cron', `invalid cron '${cron}': ${(e as Error).message}`, undefined, '/trigger/schedule/cron');
      }
    }
  }

  // Node identity
  const byId = new Map<string, NodeDef>();
  for (const n of def.nodes) {
    if (byId.has(n.id)) err('duplicate_node_id', `node id '${n.id}' is used more than once`, n.id);
    byId.set(n.id, n);
    if (!supported.includes(n.type)) err('unsupported_in_release', `node type '${n.type}' is not available in this release`, n.id);
  }

  // Dependencies
  const deps = new Map<string, Set<string>>(def.nodes.map((n) => [n.id, new Set(n.depends_on ?? [])]));
  // Data edges only (refs and CEL references); taint flows along these.
  const dataDeps = new Map<string, Set<string>>(def.nodes.map((n) => [n.id, new Set<string>()]));
  for (const n of def.nodes) {
    for (const d of n.depends_on ?? []) if (!byId.has(d)) err('unknown_dependency', `depends_on '${d}' is not a node`, n.id);
  }
  const routeOf = new Map<string, { condition: string; route: string }>();
  for (const n of def.nodes) {
    if (n.type !== 'condition') continue;
    if (n.default !== undefined && !(n.default in n.routes)) err('unknown_route', `default route '${n.default}' is not one of: ${Object.keys(n.routes).join(', ')}`, n.id);
    for (const [route, members] of Object.entries(n.routes)) {
      for (const m of members) {
        if (!byId.has(m)) err('unknown_route_node', `route '${route}' names unknown node '${m}'`, n.id);
        else if (routeOf.has(m)) err('node_in_multiple_routes', `node '${m}' is in more than one route`, n.id);
        else {
          routeOf.set(m, { condition: n.id, route });
          deps.get(m)!.add(n.id);
        }
      }
    }
  }

  // Expressions: refs and CEL, collected per node
  const nodeRefs = new Map<string, Array<{ site: ExprSite; segments: string[] }>>();
  for (const n of def.nodes) {
    const refs: Array<{ site: ExprSite; segments: string[] }> = [];
    const inParallel = n.type === 'parallel';
    for (const [field, value] of Object.entries(nodeValues(n))) {
      for (const site of collectExprs(value, field)) {
        if (site.kind === 'ref') {
          const segments = site.text.split('.');
          const root = segments[0]!;
          if (!REF_ROOTS.has(root)) {
            err('invalid_ref', `ref '${site.text}' must start with inputs, nodes, config, item or run`, n.id, site.path);
            continue;
          }
          if (root === 'item' && !(inParallel && site.path.startsWith('node.'))) {
            err('invalid_ref', `'item' is only available inside a parallel node's body`, n.id, site.path);
            continue;
          }
          if (root === 'nodes') {
            const target = segments[1];
            if (!target || !byId.has(target)) {
              err('unknown_ref_node', `ref '${site.text}' names unknown node '${target ?? ''}'`, n.id, site.path);
              continue;
            }
            if (segments[2] !== 'output') {
              err('invalid_ref', `ref '${site.text}' must select '.output' of node '${target}'`, n.id, site.path);
              continue;
            }
            if (target === n.id) {
              err('self_reference', `node '${n.id}' refers to its own output`, n.id, site.path);
              continue;
            }
            deps.get(n.id)!.add(target);
            dataDeps.get(n.id)!.add(target);
          }
          refs.push({ site, segments });
        } else {
          const check = checkCel(site.text);
          if (!check.valid) err('invalid_cel', `${site.kind} expression at ${site.path}: ${check.error}`, n.id, site.path);
          for (const target of referencedNodes(site.text)) {
            if (!byId.has(target)) err('unknown_ref_node', `expression at ${site.path} names unknown node '${target}'`, n.id, site.path);
            else if (target !== n.id) {
              deps.get(n.id)!.add(target);
              dataDeps.get(n.id)!.add(target);
            }
          }
        }
      }
    }
    for (const { path, text } of nodeCel(n)) {
      const check = checkCel(text);
      if (!check.valid) err('invalid_cel', `${path}: ${check.error}`, n.id, path);
      for (const target of referencedNodes(text)) {
        if (!byId.has(target)) err('unknown_ref_node', `${path} names unknown node '${target}'`, n.id, path);
        else if (target !== n.id) {
          deps.get(n.id)!.add(target);
          dataDeps.get(n.id)!.add(target);
        }
      }
    }
    nodeRefs.set(n.id, refs);
  }

  // Topological order and cycle detection
  const order = topoSort(def.nodes.map((n) => n.id), deps);
  if (!order.ok) {
    err('cycle', `the graph has a cycle through: ${order.cycle.join(' -> ')}; cycles are only allowed inside a loop node`);
    return { ok: false, diagnostics: diags };
  }

  // Output schemas, in dependency order
  const outputs = new Map<string, JsonSchema | undefined>();
  const agentToolsById = new Map<string, NonNullable<PlanNode['agentTools']>>();
  const planNodes = new Map<string, PlanNode>();
  const loadSchema = (ref: string | JsonSchema | undefined, nodeId: string, field: string): JsonSchema | undefined => {
    if (ref === undefined) return undefined;
    if (typeof ref === 'object') return ref;
    if (!opts.pkg) return undefined;
    const text = opts.pkg.readText(ref);
    if (text === undefined) {
      err('missing_file', `${field} '${ref}' is not in the package`, nodeId, field);
      return undefined;
    }
    try {
      return (ref.endsWith('.json') ? JSON.parse(text) : parseYamlValue(text)) as JsonSchema;
    } catch (e) {
      err('invalid_schema_file', `${field} '${ref}' is not valid JSON/YAML: ${(e as Error).message}`, nodeId, field);
      return undefined;
    }
  };

  const inputSchemaFor = (root: string): JsonSchema | undefined => {
    if (root === 'inputs') return def.inputs;
    if (root === 'config') return schemaOfLiteral(def.config ?? {});
    return undefined;
  };

  if (!opts.catalog && def.nodes.some((n) => n.type === 'tool' || (n.type === 'parallel' && n.node.type === 'tool'))) {
    warn('catalog_unavailable', 'tool catalog not available: tool references, arguments and projections were not checked');
  }

  for (const id of order.order) {
    const n = byId.get(id)!;
    let outputSchema: JsonSchema | undefined;
    let toolInfo: PlanNode['tool'];

    const typeOfRef = (segments: string[], site: ExprSite): JsonSchema | undefined => {
      const root = segments[0]!;
      if (root === 'nodes') {
        const r = resolvePath(outputs.get(segments[1]!), segments.slice(3));
        if (!r.ok) err('ref_type', `ref '${site.text}': ${r.error}`, n.id, site.path);
        return r.ok ? r.schema : undefined;
      }
      if (root === 'item' && n.type === 'parallel') {
        const items = forEachSchema(n);
        const r = resolvePath(items, segments.slice(1));
        if (!r.ok) err('ref_type', `ref '${site.text}': ${r.error}`, n.id, site.path);
        return r.ok ? r.schema : undefined;
      }
      const r = resolvePath(inputSchemaFor(root), segments.slice(1));
      if (!r.ok) err('ref_type', `ref '${site.text}': ${r.error}`, n.id, site.path);
      return r.ok ? r.schema : undefined;
    };

    const forEachSchema = (p: ParallelNode): JsonSchema | undefined => {
      if (!isValueExpr(p.for_each) || !('ref' in p.for_each)) return undefined;
      const s = typeOfRef(p.for_each.ref.split('.'), { kind: 'ref', text: p.for_each.ref, path: 'for_each' });
      if (s && typesOf(s).length && !typesOf(s).includes('array')) err('ref_type', `for_each must be a list, got ${typesOf(s).join('|')}`, n.id, 'for_each');
      return s?.items as JsonSchema | undefined;
    };

    const refTypes = new Map<string, JsonSchema | undefined>();
    for (const { site, segments } of nodeRefs.get(id) ?? []) refTypes.set(site.path, typeOfRef(segments, site));

    const checkTool = (tool: string, args: Record<string, Value> | undefined, project: string[] | undefined, argPrefix: string) => {
      const spec = opts.catalog?.get(tool);
      if (!opts.catalog) return undefined;
      if (!spec) {
        err('unknown_tool', `tool '${tool}' is not registered in this workspace`, n.id, 'tool');
        return undefined;
      }
      const inputProps = (spec.input_schema.properties ?? {}) as Record<string, JsonSchema>;
      for (const r of (spec.input_schema.required ?? []) as string[]) {
        if (!args || !(r in args)) err('missing_argument', `tool '${tool}' requires argument '${r}'`, n.id, `${argPrefix}.${r}`);
      }
      for (const [k, v] of Object.entries(args ?? {})) {
        if (!(k in inputProps)) {
          if (spec.input_schema.additionalProperties === false) err('unknown_argument', `tool '${tool}' has no argument '${k}'`, n.id, `${argPrefix}.${k}`);
          continue;
        }
        const producer = isValueExpr(v) ? ('ref' in v ? refTypes.get(`${argPrefix}.${k}`) : undefined) : schemaOfLiteral(v);
        if (!compatible(producer, inputProps[k])) {
          err('argument_type', `argument '${k}' of '${tool}' expects ${typesOf(inputProps[k]).join('|')}, got ${typesOf(producer).join('|')}`, n.id, `${argPrefix}.${k}`);
        }
      }
      let out: JsonSchema | undefined = spec.output_schema;
      if (project?.length) {
        const p = projectSchema(spec.output_schema, project);
        for (const u of p.unknown) err('projection_unknown_field', `projected field '${u}' is not in the output of '${tool}'`, n.id, 'project');
        out = p.schema;
      }
      toolInfo = {
        ref: tool,
        effect: spec.effect,
        revision: spec.revision,
        outputTrusted: spec.output_trusted === true,
        safeForTainted: spec.safe_for_tainted === true,
      };
      return out;
    };

    switch (n.type) {
      case 'tool':
        outputSchema = checkTool(n.tool, n.arguments, n.project, 'arguments');
        break;
      case 'script':
        checkScript(n.runtime, n.entrypoint, n.id);
        outputSchema = loadSchema(n.output_schema, n.id, 'output_schema');
        if (!n.output_schema) warn('untyped_output', `script '${n.id}' declares no output_schema; downstream refs are not type-checked`, n.id);
        break;
      case 'agent': {
        outputSchema = loadSchema(n.output_schema, n.id, 'output_schema');
        if (opts.pkg && opts.pkg.readText(profilePath(n.profile)) === undefined) err('missing_file', `agent profile '${n.profile}' is not in the package (expected ${profilePath(n.profile)})`, n.id, 'profile');
        const agentTools: NonNullable<PlanNode['agentTools']> = [];
        for (const ref of n.tools ?? []) {
          const spec = opts.catalog?.get(ref);
          if (opts.catalog && !spec) err('unknown_tool', `agent tool '${ref}' is not registered in this workspace`, n.id, 'tools');
          if (spec) agentTools.push({ ref, effect: spec.effect, outputTrusted: spec.output_trusted === true, safeForTainted: spec.safe_for_tainted === true, revision: spec.revision });
        }
        agentToolsById.set(n.id, agentTools);
        break;
      }
      case 'retrieve':
        outputSchema = RETRIEVE_OUTPUT_SCHEMA;
        break;
      case 'condition':
        outputSchema = CONDITION_OUTPUT_SCHEMA;
        break;
      case 'approval':
        outputSchema = APPROVAL_OUTPUT_SCHEMA;
        break;
      case 'report':
        if (opts.pkg && opts.pkg.readText(n.template) === undefined) err('missing_file', `template '${n.template}' is not in the package`, n.id, 'template');
        outputSchema = REPORT_OUTPUT_SCHEMA;
        break;
      case 'notify':
        outputSchema = NOTIFY_OUTPUT_SCHEMA;
        break;
      case 'parallel': {
        forEachSchema(n);
        let inner: JsonSchema | undefined;
        if (n.node.type === 'tool') inner = checkTool(n.node.tool, n.node.arguments, n.node.project, 'node.arguments');
        else if (n.node.type === 'script') {
          checkScript(n.node.runtime, n.node.entrypoint, n.id);
          inner = loadSchema(n.node.output_schema, n.id, 'node.output_schema');
        }
        outputSchema = {
          type: 'object',
          properties: { items: { type: 'array', items: inner ?? {} }, completed: { type: 'integer' }, failed: { type: 'integer' } },
        };
        break;
      }
      default:
        outputSchema = undefined;
    }
    outputs.set(id, outputSchema);

    const timeout = n.type === 'script' && n.limits?.time ? n.limits.time : n.timeout;
    let timeoutMs = DEFAULT_TIMEOUTS[n.type];
    if (timeout) {
      try {
        timeoutMs = parseDuration(timeout);
      } catch {
        err('invalid_duration', `invalid timeout '${timeout}'`, n.id, 'timeout');
      }
    }
    planNodes.set(id, {
      id,
      type: n.type,
      deps: [...deps.get(id)!].sort(),
      dataDeps: [...dataDeps.get(id)!].sort(),
      def: n,
      outputSchema,
      timeoutMs,
      maxAttempts: n.retry?.max_attempts ?? 3,
      ...(toolInfo ? { tool: toolInfo } : {}),
      ...(routeOf.has(id) ? { route: routeOf.get(id)! } : {}),
      ...(agentToolsById.has(id) ? { agentTools: agentToolsById.get(id)! } : {}),
    });
  }

  function checkScript(runtime: string, entrypoint: string, nodeId: string) {
    const ext = entrypoint.split('.').pop();
    if (runtime === 'python' && ext !== 'py') err('runtime_mismatch', `python entrypoint must be a .py file: ${entrypoint}`, nodeId, 'entrypoint');
    if (runtime === 'bun' && !['ts', 'js', 'mjs'].includes(ext ?? '')) err('runtime_mismatch', `bun entrypoint must be .ts or .js: ${entrypoint}`, nodeId, 'entrypoint');
    if (opts.pkg && opts.pkg.read(entrypoint) === undefined) err('missing_file', `entrypoint '${entrypoint}' is not in the package`, nodeId, 'entrypoint');
  }

  const orderedNodes = order.order.map((id) => planNodes.get(id)!);
  const taint = analyseTaint(orderedNodes, opts.datasets);
  diags.push(...taint.diagnostics);
  for (const n of def.nodes) {
    if (n.type === 'approval' && n.payload === undefined) warn('approval_without_payload', `approval '${n.id}' shows no payload; approvers should see the concrete target and payload`, n.id);
  }

  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length) return { ok: false, diagnostics: diags };

  const plan: ExecutionPlan = {
    format: 'azhi-plan/1',
    compiler: COMPILER_VERSION,
    workflowId: def.id,
    definitionHash: contentHash(def),
    ...(opts.pkg ? { packageHash: opts.pkg.hash } : {}),
    ...(def.inputs ? { inputsSchema: def.inputs } : {}),
    config: def.config ?? {},
    ...(def.trigger ? { trigger: def.trigger } : {}),
    nodes: orderedNodes,
    taint: taint.report,
  };
  return { ok: true, diagnostics: diags, plan };
}

/** Agent profiles live in the package: `quality-analyst@1` -> `profiles/quality-analyst@1.yaml`. */
export function profilePath(profile: string): string {
  return `profiles/${profile}.yaml`;
}

function topoSort(ids: string[], deps: Map<string, Set<string>>): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const indeg = new Map(ids.map((id) => [id, 0]));
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const d of deps.get(id) ?? []) {
      if (!indeg.has(d)) continue;
      indeg.set(id, indeg.get(id)! + 1);
      children.get(d)!.push(id);
    }
  }
  // Stable: keep definition order among ready nodes.
  const ready = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const c of children.get(id)!) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) {
        const pos = ready.findIndex((r) => ids.indexOf(r) > ids.indexOf(c));
        pos === -1 ? ready.push(c) : ready.splice(pos, 0, c);
      }
    }
  }
  if (order.length === ids.length) return { ok: true, order };
  // Report one cycle among the remaining nodes.
  const remaining = new Set(ids.filter((id) => !order.includes(id)));
  const start = [...remaining][0]!;
  const path: string[] = [start];
  let cur = start;
  for (;;) {
    const next = [...(deps.get(cur) ?? [])].find((d) => remaining.has(d))!;
    const at = path.indexOf(next);
    if (at !== -1) return { ok: false, cycle: [...path.slice(at), next].reverse() };
    path.push(next);
    cur = next;
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
