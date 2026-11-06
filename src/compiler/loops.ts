import type { Diagnostic } from '../definition/load.js';
import { isValueExpr, type LoopBlockNode, type LoopJoinNode, type NodeDef, type Value, type WorkflowDefinition } from '../definition/types.js';

export type { LoopBlockNode, LoopExitRule, LoopJoinNode } from '../definition/types.js';

/**
 * Multi-step loops. A loop with a `body` is written out when the workflow is compiled: every round becomes ordinary
 * numbered steps and a gate, and the loop itself becomes the join later steps read. Taint, the run plan, the ledger and
 * resume then see plain steps, so a resumed run keeps the rounds that finished. Rounds are capped because each can
 * cost agent runs, and the cap is what lets the plan show every step that could run.
 */
export const LOOP_OUTCOMES = ['done', 'stop', 'no_progress'] as const;

export interface LoopOrigin {
  loop: string;
  round: number;
  /** The step's id in the body, or `gate`. */
  step: string;
}

export interface LoopExpansion {
  /** The definition itself when it has no multi-step loop or when something is wrong, else a copy with the loops written out. */
  def: WorkflowDefinition;
  /** Per generated step: the loop, round and body step it came from. */
  origins: Map<string, LoopOrigin>;
  diagnostics: Diagnostic[];
}

/** Steps that can run in a round. Approvals and writes come later: what a rejection or a repeated write means needs its own rules. */
const BODY_TYPES = new Set(['script', 'agent', 'tool', 'retrieve', 'condition', 'subworkflow', 'report']);
const IGNORED_FIELDS = ['merge', 'timeout', 'retry'] as const;

export interface RoundScope {
  /** Body step ids and the id each has in this round. */
  ids: Map<string, string>;
  state: Record<string, Value>;
  iteration: number;
  /** Told about each body step this expression reads. */
  touched?: (id: string) => void;
  problem?: (message: string) => void;
}

const isIdentStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
const isIdentPart = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
const STRING_PREFIX = /^(?:[rR]|[bB]|[rR][bB]|[bB][rR])$/;

/** The index just past the string literal that opens at `start`. */
function endOfString(text: string, start: number, raw: boolean): number {
  const quote = text[start]!;
  const triple = text.startsWith(quote.repeat(3), start);
  const close = triple ? quote.repeat(3) : quote;
  let i = start + close.length;
  while (i < text.length) {
    if (!raw && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith(close, i)) return i + close.length;
    i++;
  }
  return text.length;
}

function celString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

/** A value as a CEL expression, parenthesised when it is an expression of its own. */
function celOf(v: Value): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return celString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(celOf).join(', ')}]`;
  if (isValueExpr(v)) {
    if ('ref' in v) return v.ref;
    return `(${'cel' in v ? v.cel : v.map})`;
  }
  return `{${Object.entries(v).map(([k, x]) => `${celString(k)}: ${celOf(x)}`).join(', ')}}`;
}

/** Rewrites an expression for one round. String literals, field selections and longer names are never touched. */
export function rewriteCel(text: string, s: RoundScope): string {
  let out = '';
  let i = 0;
  let afterDot = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const end = endOfString(text, i, false);
      out += text.slice(i, end);
      i = end;
      afterDot = false;
      continue;
    }
    if (isIdentStart(c)) {
      let end = i + 1;
      while (isIdentPart(text[end])) end++;
      const word = text.slice(i, end);
      const next = text[end];
      if (STRING_PREFIX.test(word) && (next === "'" || next === '"')) {
        const close = endOfString(text, end, /[rR]/.test(word));
        out += text.slice(i, close);
        i = close;
        afterDot = false;
        continue;
      }
      const rest = text.slice(end);
      if (!afterDot && word === 'nodes') {
        const dot = /^(\s*\.\s*)([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
        const bracket = /^(\s*\[\s*)(['"])([A-Za-z_][A-Za-z0-9_]*)\2(\s*\])/.exec(rest);
        const id = dot?.[2] ?? bracket?.[3];
        const renamed = id === undefined ? undefined : s.ids.get(id);
        if (renamed !== undefined) {
          s.touched?.(id!);
          out += word + (dot ? `${dot[1]}${renamed}` : `${bracket![1]}${bracket![2]}${renamed}${bracket![2]}${bracket![4]}`);
          i = end + (dot ?? bracket)![0].length;
          afterDot = false;
          continue;
        }
      } else if (!afterDot && word === 'state') {
        const dot = /^\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
        const bracket = /^\s*\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/.exec(rest);
        const key = dot?.[1] ?? bracket?.[2];
        if (key === undefined) {
          out += celOf(s.state);
          i = end;
          afterDot = false;
          continue;
        }
        if (!(key in s.state)) s.problem?.(`'state.${key}' is not set by the loop's initial`);
        out += celOf(s.state[key] ?? null);
        i = end + (dot ?? bracket)![0].length;
        afterDot = false;
        continue;
      } else if (!afterDot && word === 'iteration') {
        out += String(s.iteration);
        i = end;
        afterDot = false;
        continue;
      }
      out += word;
      i = end;
      afterDot = false;
      continue;
    }
    out += c;
    i++;
    if (c === '.') afterDot = true;
    else if (!/\s/.test(c)) afterDot = false;
  }
  return out;
}

/** Follows the rest of a ref into a state value, keeping a plain ref plain so `workspace.from` stays valid. */
function intoState(value: Value, path: string[], full: string, s: RoundScope): Value {
  if (!path.length) return structuredClone(value);
  if (value === null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (isValueExpr(value)) {
      if ('ref' in value) return { ref: `${value.ref}.${path.join('.')}` };
      return { cel: `(${'cel' in value ? value.cel : value.map}).${path.join('.')}` };
    }
    return intoState(value[path[0]!] ?? null, path.slice(1), full, s);
  }
  s.problem?.(`'${full}' reads into a value that is not an object`);
  return null;
}

function rewriteRef(text: string, s: RoundScope): Value {
  const seg = text.split('.');
  if (seg[0] === 'iteration' && seg.length === 1) return s.iteration;
  if (seg[0] === 'state') {
    if (seg.length === 1) return structuredClone(s.state) as Value;
    if (!(seg[1]! in s.state)) s.problem?.(`'state.${seg[1]}' is not set by the loop's initial`);
    return intoState(s.state[seg[1]!] ?? null, seg.slice(2), text, s);
  }
  if (seg[0] === 'nodes' && seg[1] !== undefined) {
    const renamed = s.ids.get(seg[1]);
    if (renamed !== undefined) {
      s.touched?.(seg[1]);
      return { ref: ['nodes', renamed, ...seg.slice(2)].join('.') };
    }
  }
  return { ref: text };
}

function rewriteValue(v: Value, s: RoundScope): Value {
  if (Array.isArray(v)) return v.map((x) => rewriteValue(x, s));
  if (v === null || typeof v !== 'object') return v;
  if (isValueExpr(v)) {
    if ('ref' in v) return rewriteRef(v.ref, s);
    if ('cel' in v) return { cel: rewriteCel(v.cel, s) };
    return { map: rewriteCel(v.map, s) };
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewriteValue(x, s)]));
}

const rewriteRecord = (r: Record<string, Value>, s: RoundScope) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, rewriteValue(v, s)]));

/** The step for one round: every field that holds an expression or names a step. */
function rewriteStep(step: NodeDef, id: string, s: RoundScope): NodeDef {
  const n = structuredClone(step) as NodeDef & Record<string, any>;
  n.id = id;
  if (n.depends_on) {
    n.depends_on = n.depends_on.map((d: string) => {
      if (s.ids.has(d)) s.touched?.(d);
      return s.ids.get(d) ?? d;
    });
  }
  switch (n.type) {
    case 'tool':
      if (n.arguments) n.arguments = rewriteRecord(n.arguments, s);
      if (n.guard) n.guard = rewriteCel(n.guard, s);
      break;
    case 'agent':
      if (n.input !== undefined) n.input = rewriteValue(n.input, s);
      if (n.workspace) {
        for (const k of ['repo', 'ref', 'base_ref', 'merge_ref', 'from'] as const) {
          if (n.workspace[k] !== undefined) n.workspace[k] = rewriteValue(n.workspace[k] as Value, s);
        }
      }
      break;
    case 'script':
    case 'subworkflow':
      if (n.input !== undefined) n.input = rewriteValue(n.input, s);
      break;
    case 'retrieve':
      n.query = rewriteValue(n.query, s);
      if (n.filters) n.filters = rewriteRecord(n.filters, s);
      break;
    case 'report':
      if (n.input !== undefined) n.input = rewriteValue(n.input, s);
      if (n.summary !== undefined) n.summary = rewriteValue(n.summary, s);
      break;
    case 'condition':
      n.expression = rewriteCel(n.expression, s);
      n.routes = Object.fromEntries(Object.entries(n.routes as Record<string, string[]>).map(([route, members]) => [route, members.map((m) => s.ids.get(m) ?? m)]));
      break;
  }
  return n;
}

const isBlock = (n: unknown): n is LoopBlockNode => !!n && (n as { type?: unknown }).type === 'loop' && 'body' in (n as object);

/** Every node id a step outside a loop names, in its expressions and its dependencies. */
function namedByOuterStep(n: NodeDef): Set<string> {
  const { description: _description, ...rest } = n as NodeDef & { description?: string };
  const text = JSON.stringify(rest).replace(/\\"/g, '"');
  const ids = new Set<string>([...((n.depends_on ?? []) as string[])]);
  for (const m of text.matchAll(/(?<![\w.])nodes\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) ids.add(m[1]!);
  for (const m of text.matchAll(/(?<![\w.])nodes\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) ids.add(m[1]!);
  if (n.type === 'condition') for (const members of Object.values(n.routes)) for (const m of members) ids.add(m);
  return ids;
}

export function expandLoops(authored: WorkflowDefinition): LoopExpansion {
  const origins = new Map<string, LoopOrigin>();
  const diagnostics: Diagnostic[] = [];
  if (!authored.nodes.some(isBlock)) return { def: authored, origins, diagnostics };
  const err = (code: string, message: string, node?: string, path?: string) => diagnostics.push({ severity: 'error', code, message, node, path });

  const outerIds = new Set(authored.nodes.map((n) => n.id));
  /** Per loop: the first steps of round 1, which take its place on any route that names it. */
  const entriesOf = new Map<string, string[]>();
  const generatedBy = new Map<string, string>();
  const expanded = new Map<string, Array<NodeDef | LoopJoinNode>>();
  const roundContexts: Record<string, Record<string, Value>> = {};
  const usedByBody = new Set<string>();

  for (const raw of authored.nodes) {
    if (!isBlock(raw)) continue;
    const loop = raw;
    const bad = (code: string, message: string, path?: string) => err(code, message, loop.id, path);
    for (const f of IGNORED_FIELDS) if ((loop as unknown as Record<string, unknown>)[f] !== undefined) bad('loop_invalid', `loop '${loop.id}' cannot set '${f}': it would apply to no step. Set it on the steps of the body`, f);
    if (!loop.body?.length) bad('loop_invalid', `loop '${loop.id}' has no steps in its body`, 'body');
    if (!Array.isArray(loop.exit) || !loop.exit.length) bad('loop_invalid', `loop '${loop.id}' needs a list of exit rules, or nothing could ever end it early`, 'exit');
    if (loop.initial !== undefined && (loop.initial === null || typeof loop.initial !== 'object' || Array.isArray(loop.initial) || isValueExpr(loop.initial as Value))) bad('loop_invalid', `the initial of loop '${loop.id}' must be an object of keys, each a ref, a cel or a literal`, 'initial');
    if (!Number.isInteger(loop.max_iterations) || loop.max_iterations < 1) bad('loop_invalid', `loop '${loop.id}' needs a max_iterations of 1 or more`, 'max_iterations');
    const reasons: Record<string, string> = {};
    for (const rule of Array.isArray(loop.exit) ? loop.exit : []) {
      if (!LOOP_OUTCOMES.includes(rule.outcome)) bad('loop_invalid', `outcome '${String(rule.outcome)}' is not one of: ${LOOP_OUTCOMES.join(', ')}. Another round is what happens when no rule holds`, 'exit');
      if (rule.reason === undefined) continue;
      if (reasons[rule.outcome] !== undefined && reasons[rule.outcome] !== rule.reason) bad('loop_reason_conflict', `outcome '${rule.outcome}' has two different reasons, and the round records only the outcome. Use one reason`, 'exit');
      reasons[rule.outcome] = rule.reason;
    }
    const body = loop.body ?? [];
    const seen = new Set<string>();
    let bodyOk = true;
    for (const step of body) {
      const invalid = (code: string, message: string) => {
        bad(code, message, `body.${step.id}`);
        bodyOk = false;
      };
      if (seen.has(step.id)) invalid('loop_step_invalid', `step '${step.id}' is in the body of loop '${loop.id}' more than once`);
      seen.add(step.id);
      if (step.id === 'gate') invalid('loop_step_invalid', `'gate' is the name of each round's generated gate; rename the step`);
      if (!BODY_TYPES.has(step.type)) invalid('loop_body_unsupported', `a '${step.type}' step cannot be in a loop body yet`);
      if (outerIds.has(step.id)) invalid('loop_step_shadows', `step '${step.id}' in loop '${loop.id}' has the same id as a step outside it, so 'nodes.${step.id}' would be ambiguous`);
    }
    for (const round of Object.keys(loop.overrides ?? {})) {
      const n = Number(round);
      if (!Number.isInteger(n) || n < 1 || n > loop.max_iterations) bad('loop_invalid', `overrides name round ${round}, and the rounds are 1 to ${loop.max_iterations}`, `overrides.${round}`);
      for (const [stepId, fields] of Object.entries(loop.overrides![n] ?? {})) {
        if (!seen.has(stepId)) bad('loop_invalid', `overrides name step '${stepId}', which is not in the body`, `overrides.${round}.${stepId}`);
        for (const f of ['id', 'type'] as const) if (f in fields) bad('loop_invalid', `an override cannot change a step's ${f}`, `overrides.${round}.${stepId}.${f}`);
      }
    }
    for (const key of Object.keys(loop.next ?? {})) if (!(key in (loop.initial ?? {}))) bad('loop_unknown_state', `next sets 'state.${key}', which initial does not: every state key needs a value for round 1`, `next.${key}`);
    if (!bodyOk || diagnostics.length) continue;

    const problem = (message: string) => bad('loop_unknown_state', `loop '${loop.id}': ${message}`);
    const idFor = (round: number, step: string) => `${loop.id}_${round}_${step}`;
    const roundIds = (round: number) => new Map(body.map((s) => [s.id, idFor(round, s.id)]));
    const nodes: Array<NodeDef | LoopJoinNode> = [];
    const rounds: LoopJoinNode['rounds'] = [];
    const entries: string[][] = [];
    const gates: Array<NodeDef & Record<string, any>> = [];
    let state: Record<string, Value> = structuredClone(loop.initial ?? {});

    for (let round = 1; round <= loop.max_iterations; round++) {
      const ids = roundIds(round);
      const iteration = round - 1;
      // A first step reads no step of its round and is on no route inside it. Only first steps can go on the route into the round.
      const waiting = new Set<string>();
      for (const step of body) {
        if (step.type !== 'condition') continue;
        for (const members of Object.values(step.routes)) for (const m of members) if (ids.has(m)) waiting.add(m);
      }
      const stepNodes = body.map((step) => {
        const merged = { ...step, ...(loop.overrides?.[round]?.[step.id] ?? {}) } as NodeDef & { context?: string[] };
        const stepScope: RoundScope = { ids, state, iteration, touched: () => waiting.add(step.id), problem };
        // A bundle can read the round's steps and state, so each round has its own copy. An unknown name stays, and is reported where bundles are.
        if (merged.context) {
          merged.context = merged.context.map((name) => {
            const bundle = authored.contexts?.[name];
            if (!bundle) return name;
            const copy = `${loop.id}_${round}_${name}`;
            roundContexts[copy] = rewriteRecord(bundle, stepScope);
            usedByBody.add(name);
            return copy;
          });
        }
        const node = rewriteStep(merged, ids.get(step.id)!, stepScope);
        origins.set(node.id, { loop: loop.id, round, step: step.id });
        return node;
      });
      const first = body.filter((s) => !waiting.has(s.id)).map((s) => ids.get(s.id)!);
      if (round === 1 && !first.length) bad('loop_invalid', `every step in the body of loop '${loop.id}' waits on another, so no round could start`, 'body');
      entries.push(first);

      const scope: RoundScope = { ids, state, iteration: round, problem };
      const last = round === loop.max_iterations ? 'exhausted' : 'retry';
      const expression = [...(loop.exit ?? [])].reverse().reduce((rest, rule, i) => `(${rewriteCel(rule.when, scope)}) ? '${rule.outcome}' : ${i === 0 ? rest : `(${rest})`}`, `'${last}'`);
      const gate = {
        id: idFor(round, 'gate'),
        type: 'condition',
        description: `Decides how round ${round} of ${loop.id} ends.`,
        merge: 'any',
        depends_on: stepNodes.map((n) => n.id),
        expression,
        routes: { done: [], stop: [], no_progress: [], [last]: [] as string[] },
        default: 'stop',
      } as unknown as NodeDef & Record<string, any>;
      origins.set(gate.id, { loop: loop.id, round, step: 'gate' });
      gates.push(gate);
      nodes.push(...stepNodes, gate);
      rounds.push({
        gate: gate.id,
        steps: Object.fromEntries(body.filter((s) => s.type !== 'condition').map((s) => [s.id, { ref: `nodes.${ids.get(s.id)}.output` }])),
      });
      // The next round's state reads this round's steps, and may read the state it replaces.
      if (round < loop.max_iterations) state = { ...state, ...rewriteRecord(loop.next ?? {}, { ids, state, iteration, problem }) };
    }

    for (let r = 0; r + 1 < gates.length; r++) gates[r]!.routes.retry = entries[r + 1]!;
    if (loop.depends_on?.length) {
      for (const id of entries[0] ?? []) {
        const node = nodes.find((n) => n.id === id) as NodeDef;
        node.depends_on = [...loop.depends_on, ...(node.depends_on ?? [])];
      }
    }
    entriesOf.set(loop.id, entries[0] ?? []);
    for (const id of nodes.map((n) => n.id)) {
      if (outerIds.has(id)) bad('loop_step_shadows', `loop '${loop.id}' generates step '${id}', which the workflow already has; rename one`);
      generatedBy.set(id, loop.id);
    }
    const join: LoopJoinNode = {
      id: loop.id,
      type: 'loop',
      ...(loop.description ? { description: loop.description } : {}),
      merge: 'any',
      depends_on: gates.map((g) => g.id),
      max_iterations: loop.max_iterations,
      ...(loop.on_max ? { on_max: loop.on_max } : {}),
      reasons,
      rounds,
    };
    expanded.set(loop.id, [...nodes, join]);
  }

  // A step reads a loop through its join, and only through it.
  for (const raw of authored.nodes) {
    if (isBlock(raw)) {
      const named = new Set<string>();
      for (const s of raw.body ?? []) for (const id of namedByOuterStep(s)) named.add(id);
      for (const rule of raw.exit ?? []) for (const m of rule.when.matchAll(/(?<![\w.])nodes\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) named.add(m[1]!);
      if (named.has(raw.id)) err('loop_self_reference', `a step in loop '${raw.id}' reads the loop's own output, which exists only after the last round. Use 'state' to pass values between rounds`, raw.id);
      continue;
    }
    for (const id of namedByOuterStep(raw)) {
      const owner = generatedBy.get(id);
      if (owner) err('loop_internal_ref', `step '${raw.id}' reads '${id}', a step inside loop '${owner}'. Read 'nodes.${owner}.output' instead: its 'last' and 'rounds' hold the steps of the rounds that ran`, raw.id);
    }
  }
  if (diagnostics.length) return { def: authored, origins: new Map(), diagnostics };

  const nodes = authored.nodes.flatMap((n) => {
    if (isBlock(n)) return expanded.get(n.id) as NodeDef[];
    if (n.type !== 'condition') return [n];
    const routes = Object.fromEntries(Object.entries(n.routes).map(([route, members]) => [route, members.flatMap((m) => entriesOf.get(m) ?? [m])]));
    return [{ ...n, routes }];
  });
  // A bundle only rounds use is replaced by their copies, so it is not reported as unused.
  const outside = new Set(nodes.flatMap((n) => (n as { context?: string[] }).context ?? []));
  const kept = Object.entries(authored.contexts ?? {}).filter(([name]) => !usedByBody.has(name) || outside.has(name));
  const contexts = { ...Object.fromEntries(kept), ...roundContexts };
  return { def: { ...authored, nodes, ...(Object.keys(contexts).length ? { contexts } : {}) }, origins, diagnostics };
}
