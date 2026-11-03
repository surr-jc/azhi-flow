import type { ExecutionPlan, PlanNode } from '../compiler/plan.js';
import { profilePath } from '../compiler/compile.js';
import type { PackageManifest } from '../definition/package.js';
import { contentHash } from '../lib/hash.js';

/** A resume onto another version is refused when more than this share of the steps that already succeeded would have to run again. */
export const MAX_RESUME_DEVIATION = 0.5;

export type StepChange = 'same' | 'changed' | 'added' | 'removed';

export interface ResumeStep {
  id: string;
  change: StepChange;
  /** How the step ended in the run being resumed; `not_run` when it never started. */
  was: 'succeeded' | 'skipped' | 'failed' | 'not_run';
  /** `carry`: its output is kept. `rerun`: it runs again. `drop`: the step is gone from the new version. */
  action: 'carry' | 'rerun' | 'drop';
  reason?: string;
}

export interface ResumeCheck {
  possible: boolean;
  /** Why the resume is refused; unset when it is possible. */
  reason?: string;
  /** The share (0..1) of the steps that succeeded before that the new version makes run again. Unknown when nothing had succeeded. */
  deviation: number | null;
  max_deviation: number;
  steps: ResumeStep[];
  carried: string[];
  rerun: string[];
  /** Files that changed but that no step names (a shared module, a data file): steps that use them are not detected. */
  other_files_changed: string[];
  warnings: string[];
}

export interface ResumeCheckInput {
  oldPlan: ExecutionPlan;
  oldManifest: PackageManifest;
  newPlan: ExecutionPlan;
  newManifest: PackageManifest;
  /** Steps of the run being resumed, by how their latest attempt ended. */
  succeeded: Set<string>;
  skipped: Set<string>;
  failed: Set<string>;
  fromNode?: string;
  /** Set when the run's inputs do not fit the new version. */
  inputsProblem?: string;
}

const norm = (p: string) => p.replace(/^\.\//, '');

function strings(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') out.add(norm(v));
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** The package files a step names: its script, schema, template and agent profile. */
function filesOf(n: PlanNode, manifest: PackageManifest): string[] {
  const known = new Set(manifest.files.map((f) => f.path));
  const named = strings(n.def);
  if (n.type === 'agent') named.add(profilePath((n.def as { profile: string }).profile));
  return [...named].filter((p) => known.has(p)).sort();
}

/**
 * What decides whether a step's old output still stands: the step as the interpreter runs it, the content of the
 * files it names, and the workflow config when it reads any. Tool revisions are left out: they move with the
 * catalog, not with the author's edit.
 */
function fingerprint(n: PlanNode, plan: ExecutionPlan, manifest: PackageManifest): string {
  const { tool, agentTools, ...rest } = n;
  const sha = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  return contentHash({
    node: {
      ...rest,
      ...(tool ? { tool: { ...tool, revision: undefined } } : {}),
      ...(agentTools ? { agentTools: agentTools.map((t) => ({ ...t, revision: undefined })) } : {}),
    },
    files: filesOf(n, manifest).map((p) => [p, sha.get(p)]),
    config: JSON.stringify(n.def).includes('config.') ? plan.config : undefined,
  });
}

/**
 * Whether a failed run can continue on another version of its workflow, and what it would keep. A step keeps its
 * old output only if it succeeded, its definition and files are the same in the new version, and everything it
 * depends on is kept too. Steps that changed, are new, or sit downstream of one run again. If too many of the steps
 * that had succeeded would run again, the new version is too different to save anything worth the risk.
 */
export function checkResume(o: ResumeCheckInput): ResumeCheck {
  const oldNodes = new Map(o.oldPlan.nodes.map((n) => [n.id, n]));
  const newNodes = new Map(o.newPlan.nodes.map((n) => [n.id, n]));
  const changeOf = (id: string): StepChange => {
    const a = oldNodes.get(id);
    const b = newNodes.get(id);
    if (!b) return 'removed';
    if (!a) return 'added';
    return fingerprint(a, o.oldPlan, o.oldManifest) === fingerprint(b, o.newPlan, o.newManifest) ? 'same' : 'changed';
  };
  const change = new Map([...new Set([...oldNodes.keys(), ...newNodes.keys()])].map((id) => [id, changeOf(id)]));

  // The plan lists a step after the steps it depends on.
  const carryFor = (from?: string) => {
    const again = new Set<string>(from ? [from] : []);
    const carried = new Set<string>();
    for (const n of o.newPlan.nodes) {
      if (change.get(n.id) !== 'same') again.add(n.id);
      if (n.deps.some((d) => again.has(d))) again.add(n.id);
      if (o.succeeded.has(n.id) && !again.has(n.id) && n.deps.every((d) => carried.has(d) || o.skipped.has(d))) carried.add(n.id);
    }
    return carried;
  };
  const carried = carryFor(o.fromNode);
  // A step the author asked to rerun is not deviation; only what the new version forces counts.
  const forced = carryFor();
  const lost = [...o.succeeded].filter((id) => !forced.has(id));
  const deviation = o.succeeded.size ? lost.length / o.succeeded.size : null;

  const was = (id: string): ResumeStep['was'] => (o.succeeded.has(id) ? 'succeeded' : o.skipped.has(id) ? 'skipped' : o.failed.has(id) ? 'failed' : 'not_run');
  const steps: ResumeStep[] = [
    ...o.newPlan.nodes.map((n): ResumeStep => {
      const c = change.get(n.id)!;
      const action = carried.has(n.id) ? 'carry' : 'rerun';
      const reason = action === 'carry' ? undefined
        : c === 'changed' ? 'the step changed'
        : c === 'added' ? 'the step is new'
        : n.id === o.fromNode ? 'chosen as the starting step'
        : o.succeeded.has(n.id) ? 'a step it depends on runs again'
        : was(n.id) === 'failed' ? 'it failed' : 'it did not finish';
      return { id: n.id, change: c, was: was(n.id), action, ...(reason ? { reason } : {}) };
    }),
    ...[...oldNodes.keys()].filter((id) => !newNodes.has(id)).map((id): ResumeStep => ({ id, change: 'removed', was: was(id), action: 'drop', reason: 'the step is not in the new version' })),
  ];

  const named = new Set([...o.oldPlan.nodes.flatMap((n) => filesOf(n, o.oldManifest)), ...o.newPlan.nodes.flatMap((n) => filesOf(n, o.newManifest))]);
  const oldSha = new Map(o.oldManifest.files.map((f) => [f.path, f.sha256]));
  const newSha = new Map(o.newManifest.files.map((f) => [f.path, f.sha256]));
  const other = [...new Set([...oldSha.keys(), ...newSha.keys()])]
    .filter((p) => oldSha.get(p) !== newSha.get(p) && !named.has(p) && p !== o.oldManifest.workflow && p !== o.newManifest.workflow && !/\.md$/i.test(p))
    .sort();

  const warnings: string[] = [];
  for (const s of steps) {
    const n = newNodes.get(s.id);
    if (s.action === 'rerun' && s.was === 'succeeded' && n?.tool && n.tool.effect !== 'read') warnings.push(`${s.id} already succeeded and runs again; its ${n.tool.effect} action may repeat`);
  }
  if (other.length) warnings.push(`${other.length} changed file(s) are not named by any step (${other.slice(0, 3).join(', ')}${other.length > 3 ? ', …' : ''}); a carried step that uses one keeps its old result`);

  let reason: string | undefined;
  if (o.inputsProblem) reason = `the run's inputs do not fit the new version: ${o.inputsProblem}`;
  else if (deviation !== null && deviation > MAX_RESUME_DEVIATION) {
    reason = `the new version is too different: ${lost.length} of ${o.succeeded.size} steps that already succeeded (${lost.join(', ')}) would run again, over the ${Math.round(MAX_RESUME_DEVIATION * 100)}% allowed. Start a new run instead`;
  }
  return {
    possible: !reason,
    ...(reason ? { reason } : {}),
    deviation,
    max_deviation: MAX_RESUME_DEVIATION,
    steps,
    carried: o.newPlan.nodes.filter((n) => carried.has(n.id)).map((n) => n.id),
    rerun: o.newPlan.nodes.filter((n) => !carried.has(n.id)).map((n) => n.id),
    other_files_changed: other,
    warnings,
  };
}
