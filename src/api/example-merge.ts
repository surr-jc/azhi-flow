import { parse, stringify } from 'yaml';

/**
 * Updating an installed marketplace workflow without losing local edits: a three-way merge of the
 * package as installed (base), the package as it is now (local) and the marketplace's current
 * template (upstream). Where only the marketplace changed something it is applied, where only the
 * local copy changed it is kept, and where both changed the same setting differently the local
 * value stays and the difference is reported. Without a base (an install from before updates were
 * tracked) the merge only adds what the template has and the local copy lacks.
 */
export type Kind = 'updated' | 'added' | 'removed' | 'conflict';
export interface Change {
  scope: 'step' | 'workflow' | 'file';
  /** The step id or file path. */
  target: string;
  /** The setting changed, when the change is inside a step or the workflow. */
  field?: string;
  kind: Kind;
  detail?: string;
}
export interface MergeReport {
  changes: Change[];
  /** Local edits the update left alone, because the marketplace did not change them. */
  kept: number;
  /** The workflow file was rewritten, so its comments and YAML anchors are gone. */
  reformatted: boolean;
}

type Json = unknown;
type Obj = Record<string, Json>;
const isObj = (v: Json): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const same = (a: Json, b: Json) => stable(a) === stable(b);
function stable(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}
const brief = (v: Json) => {
  const s = typeof v === 'string' ? v : stable(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

interface Ctx {
  report: MergeReport;
  known: boolean;
  scope: 'step' | 'workflow';
  target: string;
}

/** Merges one setting. `undefined` means absent. */
function mergeValue(base: Json, local: Json, up: Json, path: string, c: Ctx): Json {
  if (same(local, up)) return local;
  if (!c.known) {
    // No base: only fill in what is missing, never overwrite.
    if (local === undefined) return note(c, path, 'added', up), up;
    if (isObj(local) && isObj(up)) return mergeObject(undefined, local, up, path, c);
    return local;
  }
  if (same(local, base)) {
    note(c, path, up === undefined ? 'removed' : base === undefined ? 'added' : 'updated', up);
    return up;
  }
  if (same(up, base)) {
    c.report.kept++;
    return local;
  }
  if (isObj(local) && isObj(up) && (isObj(base) || base === undefined)) return mergeObject(base as Obj | undefined, local, up, path, c);
  c.report.changes.push({ scope: c.scope, target: c.target, field: path, kind: 'conflict', detail: `kept yours (${brief(local)}); the marketplace now has ${brief(up)}` });
  return local;
}

function note(c: Ctx, path: string, kind: Kind, value: Json) {
  c.report.changes.push({ scope: c.scope, target: c.target, field: path || undefined, kind, detail: kind === 'removed' ? undefined : brief(value) });
}

function mergeObject(base: Obj | undefined, local: Obj, up: Obj, path: string, c: Ctx): Obj {
  const out: Obj = {};
  const keys = [...new Set([...Object.keys(local), ...Object.keys(up), ...Object.keys(base ?? {})])];
  // Keys keep the local order, then the marketplace's new ones in its order.
  const order = [...Object.keys(local), ...Object.keys(up).filter((k) => !(k in local)), ...keys.filter((k) => !(k in local) && !(k in up))];
  for (const k of order) {
    const v = mergeValue(base?.[k], local[k], up[k], path ? `${path}.${k}` : k, c);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

type Step = Obj & { id: string };
const steps = (def: Obj): Step[] => (Array.isArray(def.nodes) ? (def.nodes as Step[]).filter((n) => isObj(n) && typeof n.id === 'string') : []);

/** Merges two workflow definitions given the one they started from. */
export function mergeDefinitions(base: Obj | undefined, local: Obj, up: Obj, report: MergeReport): Obj {
  const known = base !== undefined;
  const baseSteps = new Map(steps(base ?? {}).map((n) => [n.id, n]));
  const localSteps = new Map(steps(local).map((n) => [n.id, n]));
  const upSteps = new Map(steps(up).map((n) => [n.id, n]));
  const merged = new Map<string, Step>();
  const stepCtx = (id: string): Ctx => ({ report, known, scope: 'step', target: id });

  for (const [id, l] of localSteps) {
    const u = upSteps.get(id);
    const b = baseSteps.get(id);
    if (!u) {
      if (known && b && !same(l, b)) report.changes.push({ scope: 'step', target: id, kind: 'conflict', detail: 'removed in the marketplace but you changed it, so it stays' });
      else if (known && b) report.changes.push({ scope: 'step', target: id, kind: 'removed' });
      if (!known || !b || !same(l, b)) merged.set(id, l);
      continue;
    }
    merged.set(id, mergeObject(b, l, u, '', stepCtx(id)) as Step);
  }
  for (const [id, u] of upSteps) {
    if (localSteps.has(id)) continue;
    if (known && baseSteps.has(id)) {
      // You deleted it and the marketplace did not change it: it stays deleted.
      if (same(u, baseSteps.get(id))) continue;
      report.changes.push({ scope: 'step', target: id, kind: 'conflict', detail: 'you removed this step and the marketplace changed it, so it stays removed' });
      continue;
    }
    merged.set(id, u);
    report.changes.push({ scope: 'step', target: id, kind: 'added', detail: String(u.description ?? u.type ?? '') || undefined });
  }

  // Order: your order, with the marketplace's new steps after the step they follow there.
  const result: Step[] = [...localSteps.keys()].filter((id) => merged.has(id)).map((id) => merged.get(id)!);
  const upOrder = [...upSteps.keys()];
  for (const id of upOrder) {
    if (localSteps.has(id) || !merged.has(id)) continue;
    const prev = upOrder.slice(0, upOrder.indexOf(id)).reverse().find((p) => result.some((r) => r.id === p));
    const at = prev ? result.findIndex((r) => r.id === prev) + 1 : 0;
    result.splice(at, 0, merged.get(id)!);
  }

  const { nodes: _ln, ...localRest } = local;
  const { nodes: _un, ...upRest } = up;
  const { nodes: _bn, ...baseRest } = base ?? {};
  const rest = mergeObject(known ? baseRest : undefined, localRest, upRest, '', { report, known, scope: 'workflow', target: 'workflow' });
  // Keep `nodes` where the local file had it.
  const out: Obj = {};
  for (const k of [...Object.keys(local), ...Object.keys(rest)]) {
    if (k in out) continue;
    if (k === 'nodes') out.nodes = result;
    else if (k in rest) out[k] = rest[k];
  }
  if (!('nodes' in out)) out.nodes = result;
  return out;
}

const text = (b: Buffer | undefined) => b?.toString('utf8');
const equal = (a: Buffer | undefined, b: Buffer | undefined) => (a === undefined || b === undefined ? a === b : a.equals(b));

/**
 * Merges whole packages (path to bytes). `workflow` is the path of the workflow file, merged
 * setting by setting; every other file is taken from the marketplace only when it is not
 * edited locally.
 */
export function mergePackages(base: Map<string, Buffer> | undefined, local: Map<string, Buffer>, up: Map<string, Buffer>, workflow: string): { files: Map<string, Buffer>; report: MergeReport } {
  const report: MergeReport = { changes: [], kept: 0, reformatted: false };
  const files = new Map<string, Buffer>();
  const paths = [...new Set([...local.keys(), ...up.keys()])];
  for (const path of paths) {
    const l = local.get(path);
    const u = up.get(path);
    const b = base?.get(path);
    if (path === workflow && l && u) {
      const lt = text(l)!;
      const ut = text(u)!;
      const bt = text(b);
      if (lt === ut) files.set(path, l);
      else if (base && bt !== undefined && lt === bt) {
        // Not edited locally: the marketplace's file as it is, comments and all.
        files.set(path, u);
        mergeDefinitions(parse(bt) as Obj, parse(lt) as Obj, parse(ut) as Obj, report);
      } else if (base && bt !== undefined && ut === bt) {
        files.set(path, l);
      } else {
        const merged = mergeDefinitions(bt !== undefined ? (parse(bt) as Obj) : undefined, parse(lt) as Obj, parse(ut) as Obj, report);
        if (stable(merged) === stable(parse(lt))) files.set(path, l);
        else {
          files.set(path, Buffer.from(stringify(merged, { lineWidth: 0 })));
          report.reformatted = true;
        }
      }
      continue;
    }
    if (l && !u) {
      // Only in the local copy: yours, unless the marketplace dropped a file you never touched.
      if (base && b && equal(l, b)) report.changes.push({ scope: 'file', target: path, kind: 'removed' });
      else files.set(path, l);
      continue;
    }
    if (!l && u) {
      if (base && b) {
        if (!equal(u, b)) report.changes.push({ scope: 'file', target: path, kind: 'conflict', detail: 'you deleted this file and the marketplace changed it, so it stays deleted' });
        continue;
      }
      files.set(path, u);
      report.changes.push({ scope: 'file', target: path, kind: 'added' });
      continue;
    }
    if (!l || !u) continue;
    if (equal(l, u)) files.set(path, l);
    else if (!base || !b) files.set(path, l);
    else if (equal(l, b)) {
      files.set(path, u);
      report.changes.push({ scope: 'file', target: path, kind: 'updated' });
    } else if (equal(u, b)) {
      files.set(path, l);
      report.kept++;
    } else {
      files.set(path, l);
      report.changes.push({ scope: 'file', target: path, kind: 'conflict', detail: 'you and the marketplace both changed this file, so yours stays' });
    }
  }
  return { files, report };
}

export const summarise = (r: MergeReport) => ({
  updated: r.changes.filter((c) => c.kind === 'updated').length,
  added: r.changes.filter((c) => c.kind === 'added').length,
  removed: r.changes.filter((c) => c.kind === 'removed').length,
  conflicts: r.changes.filter((c) => c.kind === 'conflict').length,
  kept: r.kept,
});
