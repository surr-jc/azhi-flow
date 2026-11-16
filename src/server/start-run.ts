import { z } from 'zod';
import { MODEL_PROVIDERS, modelDefaultsProblems } from '../agents/profile.js';
import type { Principal } from '../api/auth.js';
import { EXECUTORS } from '../executors/capabilities.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { preflight } from '../plan/preflight.js';
import { buildRunPlan } from '../plan/run-plan.js';
import type { AppContext } from './context.js';
import { createRun } from './runs.js';
import { resolveVersion } from './workflows.js';

/**
 * Starting a run, from POST /v1/runs and the assistant alike: the run plan must have no blockers
 * (test runs are exempt), and with `preflight` the live checks must pass too. The caller checks the role.
 */
export const startRunBody = z.object({
  version: z.string(),
  inputs: z.record(z.string(), z.unknown()).default({}),
  test: z.boolean().optional(),
  node: z.string().optional(),
  fixtures: z.record(z.string(), z.unknown()).optional(),
  /** Also check the tools, tokens and repositories live, and refuse the run if one fails. */
  preflight: z.boolean().optional(),
  /** Provider and model for steps whose profile says `name: default`; steps that name a model keep it. Overrides the workflow's model_defaults. */
  // `force` also replaces steps that name their own model; `executor` is the harness for every step that can run on it.
  model_defaults: z.object({ provider: z.enum(MODEL_PROVIDERS), name: z.string().optional(), force: z.boolean().optional(), executor: z.string().optional() }).strict().optional(),
});
export type StartRunBody = z.infer<typeof startRunBody>;

export async function startRun(ctx: AppContext, p: Extract<Principal, { kind: 'user' }>, body: StartRunBody, interpreterBuild: string): Promise<{ runId: string }> {
  if (body.model_defaults) {
    const { force: _f, executor, ...choice } = body.model_defaults;
    if (executor && !EXECUTORS[executor]) throw new AzhiError(ErrorClass.invalidInput, `unknown executor ${executor}`);
    const problems = modelDefaultsProblems(choice);
    if (problems.length) throw new AzhiError(ErrorClass.invalidInput, problems.join('; '));
  }
  if (body.node && !body.test) throw new AzhiError(ErrorClass.invalidInput, 'running a single node requires test: true (writes are mocked)');
  const v = await resolveVersion(ctx, p.workspaceId, body.version);
  if (!v) throw new AzhiError(ErrorClass.invalidInput, `workflow version ${body.version} not found`);
  // A run whose plan has blockers is refused before anything executes. Test runs are exempt:
  // `azhi test-node` mocks writes and is how authors debug an incomplete setup.
  const plan = await buildRunPlan(ctx, p.workspaceId, v, { userId: p.userId, role: p.role }, body.model_defaults);
  if (!body.test) {
    if (!plan.ok) {
      const first = plan.blockers[0]!;
      throw new AzhiError(first.code === 'worker_trust_denied' ? ErrorClass.workerTrustDenied : ErrorClass.unsupportedCapability, `run plan has ${plan.blockers.length} blocker(s): ${plan.blockers.map((b) => (b.node ? `${b.node}: ` : '') + b.message).join('; ')}`, { blockers: plan.blockers });
    }
    if (body.preflight) {
      const pre = await preflight(ctx, p.workspaceId, v, { inputs: body.inputs, principal: { userId: p.userId, role: p.role } });
      if (!pre.ok) {
        const failed = pre.checks.filter((c) => c.status === 'fail');
        throw new AzhiError(ErrorClass.unsupportedCapability, `preflight failed: ${failed.map((c) => (c.node ? `${c.node}: ` : '') + c.message).join('; ')}`, { checks: pre.checks });
      }
    }
  }
  const r = await createRun(ctx, p.workspaceId, { version: v, inputs: body.inputs, trigger: body.test ? 'test' : 'api', test: body.test, createdBy: p.userId, interpreterBuild, plan, ...(body.model_defaults ? { modelDefaults: body.model_defaults } : {}), ...(body.node ? { testNode: { node: body.node, fixtures: body.fixtures ?? {} } } : {}) });
  return { runId: r.runId };
}
