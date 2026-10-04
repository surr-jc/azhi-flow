/**
 * The Azhi interpreter: a Temporal workflow that executes a compiled ExecutionPlan.
 *
 * Determinism rules: everything here must replay identically. Time comes from the run snapshot
 * (ADR-08) or Temporal's workflow clock; all side effects happen in Activities. Each run stays on
 * the interpreter build whose task queue started it (ADR-07).
 */
import {
  ActivityCancellationType,
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { evaluateCel } from '../cel/evaluator.js';
import type { PlanNode } from '../compiler/plan.js';
import type { ApprovalNode, NotifyNode, ParallelNode, ReportNode, ScriptNode, ToolNode } from '../definition/types.js';
import { NON_RETRYABLE } from '../lib/errors.js';
import type { ApprovalDecision, ApprovalSignal, ExecActivities, GatewayActivities } from './activity-types.js';
import type { NodeError, NodeStatus, RunFlags, RunInput, RunState, RunStatus } from './types.js';
import { resolveValue, type ValueScope } from './values.js';

export const statusQuery = defineQuery<RunStatus>('status');
export const approvalSignal = defineSignal<[ApprovalSignal]>('approval');

const WORKER_OFFLINE_EXPIRY_MS = 30 * 60_000;

const bookkeepingFor = (queue: string) =>
  proxyActivities<GatewayActivities>({
    taskQueue: queue,
    startToCloseTimeout: '30s',
    retry: { initialInterval: '1s', maximumInterval: '30s' },
  });

function gatewayOn(queue: string, node: PlanNode) {
  return proxyActivities<GatewayActivities>({
    taskQueue: queue,
    startToCloseTimeout: node.timeoutMs,
    heartbeatTimeout: node.type === 'notify' || node.tool?.effect !== 'read' ? '20s' : undefined,
    retry: { initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '1m', maximumAttempts: node.maxAttempts, nonRetryableErrorTypes: NON_RETRYABLE },
  });
}

/**
 * Scripts go to one chosen worker's own queue. Temporal retries are off here: the interpreter
 * retries, re-selecting a worker each time, so a dead worker's queue never strands an attempt.
 */
function exec(node: PlanNode, queue: string) {
  return proxyActivities<ExecActivities>({
    taskQueue: queue,
    scheduleToStartTimeout: '1m',
    startToCloseTimeout: node.timeoutMs + 60_000,
    heartbeatTimeout: '30s',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });
}

export async function azhiRun(input: RunInput): Promise<RunStatus> {
  const { plan, runId, workspaceId, snapshot } = input;
  // The gateway queue travels in the snapshot, never in module state: a reused V8 context shares it.
  const gatewayQueue = snapshot.gateway_queue ?? 'azhi-gateway';
  const bookkeeping = bookkeepingFor(gatewayQueue);
  const gateway = (node: PlanNode) => gatewayOn(gatewayQueue, node);
  const status: RunStatus = { state: 'running', flags: {}, nodes: {} };
  for (const n of plan.nodes) status.nodes[n.id] = { status: 'pending' };
  setHandler(statusQuery, () => status);
  // First decision per node wins; the API has already checked the approver's role and schema.
  const decisions = new Map<string, ApprovalDecision>();
  const rejected = new Set<string>();
  const pendingApprovals = new Map<string, string>();
  setHandler(approvalSignal, (s) => {
    if (!decisions.has(s.node) && pendingApprovals.has(s.node)) decisions.set(s.node, { decision: s.decision, by: s.by, at: s.at, data: s.data });
  });

  const outputs: Record<string, { output?: unknown }> = {};
  const asOf: Record<string, string> = {};
  const scope = (): ValueScope => ({ inputs: input.inputs, nodes: outputs, config: plan.config, now: snapshot.reference_time, run: { id: runId, attempt: workflowInfo().attempt } });
  const allowedTools = [...new Set(plan.nodes.flatMap((n) => (n.tool ? [n.tool.ref] : [])))];
  let deliveryFailed = false;
  let fatal: NodeError | undefined;

  const setState = async (state: RunState, extra: { flags?: RunFlags; error?: NodeError; event?: string } = {}) => {
    status.state = state;
    if (extra.flags) status.flags = extra.flags;
    if (extra.error) status.error = extra.error;
    await bookkeeping.recordRun(runId, workspaceId, { state, flags: status.flags, ...(extra.error ? { error: extra.error } : {}), event: { kind: extra.event ?? `run.${state}` } });
  };
  const setNode = async (id: string, s: NodeStatus, data: { output?: unknown; error?: NodeError; route?: string } = {}) => {
    status.nodes[id] = { status: s, ...(data.error ? { error: data.error } : {}), ...(data.route ? { route: data.route } : {}) };
    await bookkeeping.recordNode(runId, workspaceId, id, s, data);
  };

  const refreshWaiting = async () => {
    const waiting = status.flags.waiting_reason;
    const [first] = pendingApprovals;
    if (first && waiting?.reason !== 'approval') {
      await setState('waiting', { flags: { ...status.flags, waiting_reason: { reason: 'approval', node: first[0], expires_at: first[1] } } });
    } else if (!first && waiting?.reason === 'approval') {
      const { waiting_reason: _cleared, ...flags } = status.flags;
      await setState('running', { flags, event: 'run.resumed' });
    }
  };

  const awaitApproval = async (node: PlanNode, def: ApprovalNode, s: ValueScope) => {
    const expiresAt = new Date(Date.now() + node.timeoutMs).toISOString();
    const onExpiry = def.on_expiry ?? 'fail';
    await bookkeeping.requestApproval(runId, workspaceId, node.id, {
      message: resolveValue(def.message, s) ?? null,
      payload: resolveValue(def.payload, s) ?? null,
      role: def.role ?? 'operator',
      expires_at: expiresAt,
      on_expiry: onExpiry,
    });
    pendingApprovals.set(node.id, expiresAt);
    await refreshWaiting();
    let decided: boolean;
    try {
      decided = await condition(() => decisions.has(node.id), node.timeoutMs);
    } finally {
      pendingApprovals.delete(node.id);
    }
    await refreshWaiting();
    if (!decided) {
      const at = new Date().toISOString();
      await bookkeeping.recordApproval(runId, workspaceId, node.id, { decision: 'rejected', by: 'expiry', at, data: {}, recorded: 'expired' });
      if (onExpiry === 'fail') throw ApplicationFailure.create({ type: 'expired', message: `approval '${node.id}' expired at ${expiresAt}`, nonRetryable: true });
      rejected.add(node.id);
      return { decision: 'rejected' as const, by: 'expiry', at, data: {} };
    }
    const d = decisions.get(node.id)!;
    await bookkeeping.recordApproval(runId, workspaceId, node.id, { ...d, recorded: d.decision });
    if (d.decision === 'rejected') rejected.add(node.id);
    return d;
  };

  const selectWorker = async (nodeId: string, runtime: string, attempt: number): Promise<string> => {
    let sel = await bookkeeping.checkWorkers(workspaceId, snapshot.package_hash, runtime);
    if (sel.online > 0 && sel.accepted.length === 0) {
      throw ApplicationFailure.create({
        type: 'worker_trust_denied',
        message: `no online worker will run this package: ${sel.refused.map((r) => `${r.id}: ${r.reason}`).join('; ')}`,
        nonRetryable: true,
      });
    }
    if (sel.accepted.length === 0) {
      const expiresAt = Date.now() + WORKER_OFFLINE_EXPIRY_MS;
      await setState('waiting', { flags: { ...status.flags, waiting_reason: { reason: 'worker_offline', node: nodeId, expires_at: new Date(expiresAt).toISOString() } } });
      while (sel.accepted.length === 0) {
        if (Date.now() >= expiresAt) throw ApplicationFailure.create({ type: 'expired', message: `no worker came online for node ${nodeId} within 30 minutes`, nonRetryable: true });
        await sleep('10s');
        sel = await bookkeeping.checkWorkers(workspaceId, snapshot.package_hash, runtime);
      }
      const { waiting_reason: _cleared, ...flags } = status.flags;
      await setState('running', { flags, event: 'run.worker_online' });
    }
    // Spread attempts across accepting workers; deterministic because the list comes from history.
    return sel.accepted[(attempt - 1) % sel.accepted.length]!.queue;
  };

  const runScript = async (node: PlanNode, def: Omit<ScriptNode, 'id'>, value: unknown, ordinal?: number) => {
    const nodeId = ordinal === undefined ? node.id : `${node.id}[${ordinal}]`;
    for (let attempt = 1; ; attempt++) {
      const queue = await selectWorker(node.id, def.runtime, attempt);
      const runToken = await bookkeeping.issueRunToken(workspaceId, runId, node.id, allowedTools);
      try {
        return await exec(node, queue).runScript({
          runId,
          workspaceId,
          nodeId,
          packageHash: snapshot.package_hash,
          runtime: def.runtime,
          entrypoint: def.entrypoint,
          lockfile: def.lockfile,
          input: value,
          outputSchema: (node.type === 'parallel' ? undefined : node.outputSchema) ?? def.output_schema,
          limits: { timeMs: node.timeoutMs, memoryMb: def.limits?.memory_mb },
          runToken,
          attempt,
        });
      } catch (err) {
        if (isCancellation(err)) throw err;
        const e = toNodeError(err);
        if (NON_RETRYABLE.includes(e.class as never) || attempt >= node.maxAttempts) throw err;
        await sleep(Math.min(2000 * 2 ** (attempt - 1), 60_000));
      }
    }
  };

  const runTool = async (node: PlanNode, def: Omit<ToolNode, 'id'>, s: ValueScope, ordinal?: number) => {
    const args = (resolveValue(def.arguments as never, s) ?? {}) as Record<string, unknown>;
    if (def.guard && evaluateCel(def.guard, { ...s, args }) !== true) {
      throw ApplicationFailure.create({ type: 'authorization', message: `guard rejected the call to ${def.tool}: ${def.guard}`, nonRetryable: true });
    }
    const r = await gateway(node).toolNode({
      runId,
      workspaceId,
      nodeId: node.id,
      tool: def.tool,
      revision: snapshot.tool_revisions[def.tool],
      args,
      project: def.project,
      allowed: allowedTools,
      ordinal,
      mock: input.mockWrites && node.tool?.effect !== 'read',
    });
    asOf[r.observation.source] = r.observation.observed_at;
    return r.output;
  };

  const execute = async (node: PlanNode): Promise<{ output?: unknown; route?: string }> => {
    const s = scope();
    switch (node.type) {
      case 'tool':
        return { output: await runTool(node, node.def as ToolNode, s) };
      case 'script': {
        const def = node.def as ScriptNode;
        return { output: await runScript(node, def, resolveValue(def.input, s)) };
      }
      case 'condition': {
        const def = node.def as { expression: string; routes: Record<string, string[]>; default?: string };
        const raw = evaluateCel(def.expression, s);
        const route = typeof raw === 'string' ? raw : raw === true ? Object.keys(def.routes)[0]! : def.default;
        if (route === undefined || !(route in def.routes)) {
          if (def.default === undefined) throw ApplicationFailure.create({ type: 'contract_violation', message: `condition chose route '${String(raw)}', which does not exist and there is no default`, nonRetryable: true });
          return { output: { route: def.default }, route: def.default };
        }
        return { output: { route }, route };
      }
      case 'report': {
        const def = node.def as ReportNode;
        return {
          output: await gateway(node).reportNode({
            runId,
            workspaceId,
            nodeId: node.id,
            packageHash: snapshot.package_hash,
            template: def.template,
            format: def.format ?? 'markdown',
            input: resolveValue(def.input, s),
            summary: resolveValue(def.summary, s),
            asOf: { ...asOf },
          }),
        };
      }
      case 'notify': {
        const def = node.def as NotifyNode;
        const destination = String(resolveValue(def.destination, s) ?? '');
        const message = resolveValue(def.message, s);
        const text = typeof message === 'string' ? message : JSON.stringify(message);
        if (def.guard && evaluateCel(def.guard, { ...s, args: { channel: destination, destination, text } }) !== true) {
          throw ApplicationFailure.create({ type: 'authorization', message: `guard rejected the notification: ${def.guard}`, nonRetryable: true });
        }
        return { output: await gateway(node).notifyNode({ runId, workspaceId, nodeId: node.id, channel: def.channel, destination, text, mock: input.mockWrites }) };
      }
      case 'parallel': {
        const def = node.def as ParallelNode;
        let items = resolveValue(def.for_each, s);
        if (!Array.isArray(items)) throw ApplicationFailure.create({ type: 'contract_violation', message: 'for_each did not produce a list', nonRetryable: true });
        if (def.max_items && items.length > def.max_items) {
          throw ApplicationFailure.create({ type: 'contract_violation', message: `for_each produced ${items.length} items, above max_items ${def.max_items}`, nonRetryable: true });
        }
        const results: unknown[] = new Array(items.length);
        let completed = 0;
        let failed = 0;
        let next = 0;
        const worker = async () => {
          while (next < items.length) {
            const i = next++;
            const itemScope = { ...s, item: items[i] };
            try {
              results[i] =
                def.node.type === 'tool'
                  ? await runTool(node, def.node as Omit<ToolNode, 'id'>, itemScope, i)
                  : await runScript(node, def.node as Omit<ScriptNode, 'id'>, resolveValue((def.node as ScriptNode).input, itemScope), i);
              completed++;
              if (def.join === 'any') next = items.length;
            } catch (err) {
              if (isCancellation(err)) throw err;
              failed++;
              if ((def.join ?? 'all') === 'all') throw err;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(def.max_concurrency ?? 4, Math.max(items.length, 1)) }, worker));
        if (def.join === 'any' && completed === 0 && items.length > 0) {
          throw ApplicationFailure.create({ type: 'transient', message: `all ${failed} parallel items failed`, nonRetryable: true });
        }
        return { output: { items: results, completed, failed } };
      }
      case 'approval':
        return { output: await awaitApproval(node, node.def as ApprovalNode, s) };
      default:
        throw ApplicationFailure.create({ type: 'unsupported_capability', message: `node type '${node.type}' cannot run on this interpreter build yet`, nonRetryable: true });
    }
  };

  const shouldSkip = (node: PlanNode): boolean => {
    if (node.route) {
      const cond = status.nodes[node.route.condition];
      if (cond?.status === 'skipped' || cond?.route !== node.route.route) return true;
    }
    // A rejected approval skips everything downstream of it.
    return node.deps.some((d) => status.nodes[d]?.status === 'skipped' || status.nodes[d]?.status === 'failed' || rejected.has(d));
  };

  const runNode = async (node: PlanNode) => {
    await setNode(node.id, 'running');
    try {
      const r = await execute(node);
      outputs[node.id] = { output: r.output };
      await setNode(node.id, 'succeeded', { output: r.output, route: r.route });
    } catch (err) {
      if (isCancellation(err)) {
        status.nodes[node.id] = { status: 'cancelled' };
        throw err;
      }
      const e = toNodeError(err);
      await setNode(node.id, 'failed', { error: e });
      if (e.class === 'expired') throw err;
      if (node.type === 'notify') deliveryFailed = true;
      else fatal ??= { ...e, details: { ...(e.details ?? {}), node: node.id } };
    }
  };

  try {
    await setState('running', { event: 'run.started' });
    await CancellationScope.cancellable(async () => {
      const inFlight = new Map<string, Promise<void>>();
      for (;;) {
        if (!fatal) {
          for (const node of plan.nodes) {
            if (status.nodes[node.id]!.status !== 'pending' || inFlight.has(node.id)) continue;
            const depsDone = node.deps.every((d) => ['succeeded', 'skipped', 'failed'].includes(status.nodes[d]!.status));
            if (!depsDone) continue;
            if (shouldSkip(node)) {
              await setNode(node.id, 'skipped');
              continue;
            }
            const p = runNode(node).finally(() => inFlight.delete(node.id));
            inFlight.set(node.id, p);
          }
        }
        if (inFlight.size === 0) {
          // Nothing running: either everything is settled or a skip unblocked more nodes.
          const progress = plan.nodes.some(
            (n) => status.nodes[n.id]!.status === 'pending' && !fatal && n.deps.every((d) => ['succeeded', 'skipped', 'failed'].includes(status.nodes[d]!.status)),
          );
          if (!progress) break;
          continue;
        }
        await Promise.race(inFlight.values());
      }
    });
  } catch (err) {
    if (isCancellation(err)) {
      await CancellationScope.nonCancellable(async () => {
        await setState('cancelling');
        for (const [id, n] of Object.entries(status.nodes)) if (n.status === 'pending') await setNode(id, 'skipped');
        await setState('cancelled');
      });
      return status;
    }
    const e = toNodeError(err);
    if (e.class === 'expired') {
      await setState('expired', { error: e });
      return status;
    }
    await setState('failed', { error: e });
    return status;
  }

  for (const [id, n] of Object.entries(status.nodes)) if (n.status === 'pending') await setNode(id, 'skipped');
  if (fatal) await setState('failed', { error: fatal });
  else if (deliveryFailed) await setState('delivery_failed');
  else await setState('succeeded');
  return status;
}

function toNodeError(err: unknown): NodeError {
  let e: any = err;
  // ActivityFailure wraps the ApplicationFailure thrown by the activity.
  while (e && e.cause && !(e instanceof ApplicationFailure)) e = e.cause;
  if (e instanceof ApplicationFailure) {
    const details = (e.details?.[0] ?? undefined) as Record<string, unknown> | undefined;
    return { class: e.type ?? 'internal', message: e.message, ...(details ? { details } : {}) };
  }
  return { class: 'internal', message: (err as Error)?.message ?? String(err) };
}
