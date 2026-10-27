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
  executeChild,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { evaluateCel } from '../cel/evaluator.js';
import type { PlanNode } from '../compiler/plan.js';
import type { AgentNode, ApprovalNode, LoopNode, RetrieveNode, NotifyNode, ParallelNode, ReportNode, ScriptNode, SubworkflowNode, ToolNode } from '../definition/types.js';
import { parseDuration } from '../lib/duration.js';
import { NON_RETRYABLE } from '../lib/errors.js';
import type { ApprovalDecision, ApprovalSignal, ExecActivities, GatewayActivities } from './activity-types.js';
import type { NodeError, NodeStatus, RunFlags, RunInput, RunState, RunStatus } from './types.js';
import { resolveValue, type ValueScope } from './values.js';
import { isHarness, type HarnessExecutor } from '../executors/capabilities.js';

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

/** One model turn per activity; transient provider errors retry, contract and budget errors don't. */
function agentOn(queue: string, node: PlanNode) {
  return proxyActivities<GatewayActivities>({
    taskQueue: queue,
    startToCloseTimeout: '5m',
    heartbeatTimeout: '30s',
    cancellationType: ActivityCancellationType.TRY_CANCEL,
    retry: { initialInterval: '2s', backoffCoefficient: 2, maximumInterval: '1m', maximumAttempts: node.maxAttempts, nonRetryableErrorTypes: NON_RETRYABLE },
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
  const testNode = snapshot.test_node;
  setHandler(statusQuery, () => status);
  // First decision per node wins; the API has already checked the approver's role and schema.
  const decisions = new Map<string, ApprovalDecision>();
  const rejected = new Set<string>();
  const pendingApprovals = new Map<string, string>();
  setHandler(approvalSignal, (s) => {
    if (!decisions.has(s.node) && pendingApprovals.has(s.node)) decisions.set(s.node, { decision: s.decision, by: s.by, at: s.at, data: s.data });
  });

  const outputs: Record<string, { output?: unknown }> = {};
  if (testNode) {
    // test-node: upstream outputs come from the fixture; nothing else runs.
    for (const n of plan.nodes) {
      if (n.id === testNode.node) continue;
      if (n.id in testNode.fixtures) {
        outputs[n.id] = { output: testNode.fixtures[n.id] };
        status.nodes[n.id] = { status: 'succeeded' };
      } else status.nodes[n.id] = { status: 'skipped' };
    }
  }
  const asOf: Record<string, string> = {};
  const scope = (): ValueScope => ({ inputs: input.inputs, nodes: outputs, config: plan.config, now: snapshot.reference_time, run: { id: runId, attempt: workflowInfo().attempt } });
  // The run token is shared by activities, while each gateway call still verifies the calling
  // node. Include both deterministic tool nodes and agent-declared tools so harness bridges such
  // as OpenCode can invoke the catalog tools assigned to their own agent node.
  const allowedTools = [...new Set(plan.nodes.flatMap((n) => [...(n.tool ? [n.tool.ref] : []), ...(n.agentTools ?? []).map((t) => t.ref)]))];
  let deliveryFailed = false;
  let fatal: NodeError | undefined;

  const setState = async (state: RunState, extra: { flags?: RunFlags; error?: NodeError; event?: string } = {}) => {
    status.state = state;
    if (extra.flags) status.flags = extra.flags;
    if (extra.error) status.error = extra.error;
    await bookkeeping.recordRun(runId, workspaceId, { state, flags: status.flags, ...(extra.error ? { error: extra.error } : {}), event: { kind: extra.event ?? `run.${state}` } });
  };
  const setNode = async (id: string, s: NodeStatus, data: { output?: unknown; error?: NodeError; route?: string; attempt?: boolean } = {}) => {
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

  const pinned = (refs: string[]) =>
    refs.map((ref) => {
      const revision = snapshot.dataset_revisions?.[ref];
      if (revision === undefined) throw ApplicationFailure.create({ type: 'invalid_input', message: `dataset ${ref} was not pinned when the run was created`, nonRetryable: true });
      return { ref, revision };
    });

  /** Harness executors run on a worker; the gateway stays the only way out (bridged over MCP). */
  const runHarness = async (executor: string, node: PlanNode, def: AgentNode, s: ValueScope, act: GatewayActivities, tools: Array<{ ref: string }>) => {
    try {
      const ws = def.workspace;
      const workspace = ws
        ? {
            host: ws.host ?? 'https://github.com',
            repo: String(resolveValue(ws.repo, s) ?? ''),
            ref: String(resolveValue(ws.ref, s) ?? ''),
            ...(ws.base_ref !== undefined ? { baseRef: String(resolveValue(ws.base_ref, s) ?? '') } : {}),
            ...(ws.credential ? { credential: ws.credential } : {}),
            ...(ws.depth ? { depth: ws.depth } : {}),
            ...(ws.mode === 'write' ? { mode: 'write' as const } : {}),
            ...(ws.mode === 'write' && ws.test ? { test: { command: ws.test.command, timeoutMs: ws.test.timeout ? parseDuration(ws.test.timeout) : 600_000, attempts: ws.test.attempts ?? 1 } } : {}),
          }
        : undefined;
      const prep = await act.harnessPrepare({
        runId,
        workspaceId,
        nodeId: node.id,
        packageHash: snapshot.package_hash,
        profile: def.profile,
        executor,
        outputSchema: (node.outputSchema ?? { type: 'object' }) as Record<string, unknown>,
        tools: tools as never,
        input: resolveValue(def.input, s) ?? null,
        inputSources: node.dataDeps,
        ...(def.datasets?.length ? { datasets: pinned(def.datasets), principal: snapshot.principal } : {}),
        ...(snapshot.model_defaults?.provider ? { modelDefaults: snapshot.model_defaults } : {}),
        ...(workspace ? { workspace: { repo: workspace.repo, ref: workspace.ref, ...(workspace.baseRef ? { baseRef: workspace.baseRef } : {}) } } : {}),
      });
      const queue = await selectWorker(node.id, executor, 1);
      const runToken = await bookkeeping.issueRunToken(workspaceId, runId, node.id, tools.map((t) => t.ref), [prep.credential, ...(workspace?.credential ? [workspace.credential] : [])]);
      const r = await exec(node, queue).runHarness({
        runId,
        workspaceId,
        nodeId: node.id,
        packageHash: snapshot.package_hash,
        executor: executor as HarnessExecutor,
        provider: prep.provider,
        runToken,
        credential: prep.credential,
        providerUrl: prep.providerUrl,
        ...(prep.endpointModels ? { endpointModels: prep.endpointModels } : {}),
        model: prep.model,
        system: prep.system,
        prompt: prep.prompt,
        tools: prep.tools,
        outputSchema: prep.outputSchema,
        maxToolCalls: def.budget?.max_tool_calls,
        timeoutMs: node.timeoutMs,
        profile: def.profile,
        ...(workspace ? { workspace } : {}),
      });
      const overBudget = def.budget?.max_output_tokens !== undefined && r.usage.output_tokens !== null && r.usage.output_tokens > def.budget.max_output_tokens;
      const error = r.error ?? (overBudget ? { class: 'budget_exceeded', message: `output tokens ${r.usage.output_tokens} exceeded the budget of ${def.budget!.max_output_tokens} (measured after the run; harness budgets are not hard caps)` } : undefined);
      await bookkeeping.harnessRecord({ runId, workspaceId, nodeId: node.id, packageHash: snapshot.package_hash, profile: def.profile, executor, tainted: plan.taint.tainted[node.id], ...(snapshot.model_defaults?.provider ? { modelDefaults: snapshot.model_defaults } : {}), result: { ...r, ...(error ? { error } : {}) } });
      // Harnesses make side calls of their own (titles, compaction) that they may not report, so totals are partial.
      if (!status.flags.usage_incomplete) await setState(status.state, { flags: { ...status.flags, usage_incomplete: true }, event: 'run.usage_incomplete' });
      if (error) throw ApplicationFailure.create({ type: error.class, message: error.message, nonRetryable: true });
      return r.output;
    } catch (err) {
      if (!isCancellation(err)) await bookkeeping.agentFailed(runId, workspaceId, node.id, toNodeError(err));
      throw err;
    }
  };

  const runAgent = async (node: PlanNode, def: AgentNode, s: ValueScope) => {
    const executor = def.executor ?? 'model-agent';
    if (executor !== 'model-agent' && !isHarness(executor)) {
      throw ApplicationFailure.create({ type: 'unsupported_capability', message: `executor '${executor}' is not available on this interpreter build`, nonRetryable: true });
    }
    const act = agentOn(gatewayQueue, node);
    const tools = (node.agentTools ?? []).map((t) => ({ ref: t.ref, effect: t.effect, safeForTainted: t.safeForTainted, revision: snapshot.tool_revisions[t.ref] ?? t.revision }));
    if (isHarness(executor)) return runHarness(executor, node, def, s, act, tools);
    const deadline = Date.now() + node.timeoutMs;
    try {
      let state = await act.agentBegin({
        runId,
        workspaceId,
        nodeId: node.id,
        packageHash: snapshot.package_hash,
        profile: def.profile,
        outputSchema: (node.outputSchema ?? { type: 'object' }) as Record<string, unknown>,
        tools,
        input: resolveValue(def.input, s) ?? null,
        inputSources: node.dataDeps,
        ...(def.datasets?.length ? { datasets: pinned(def.datasets), principal: snapshot.principal } : {}),
        ...(snapshot.model_defaults?.provider ? { modelDefaults: snapshot.model_defaults } : {}),
      });
      for (;;) {
        if (Date.now() > deadline) throw ApplicationFailure.create({ type: 'transient', message: `agent node ${node.id} passed its ${node.timeoutMs} ms deadline`, nonRetryable: true });
        const r = await act.agentTurn({
          runId,
          workspaceId,
          nodeId: node.id,
          packageHash: snapshot.package_hash,
          tools,
          tainted: plan.taint.tainted[node.id],
          budget: def.budget,
          mockWrites: input.mockWrites,
          state,
        });
        if (!r.usageKnown && !status.flags.usage_incomplete) await setState(status.state, { flags: { ...status.flags, usage_incomplete: true }, event: 'run.usage_incomplete' });
        if (r.done) return r.output;
        state = r.state;
      }
    } catch (err) {
      if (!isCancellation(err)) await bookkeeping.agentFailed(runId, workspaceId, node.id, toNodeError(err));
      throw err;
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
          outputSchema: (node.type === 'parallel' || node.type === 'loop' ? undefined : node.outputSchema) ?? def.output_schema,
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
      case 'loop': {
        const def = node.def as LoopNode;
        let state = resolveValue(def.initial, s);
        const iterations: unknown[] = [];
        let exited = false;
        for (let i = 0; i < def.max_iterations && !exited; i++) {
          const scoped = { ...s, state: state ?? null, iteration: i };
          const out =
            def.node.type === 'tool'
              ? await runTool(node, def.node as Omit<ToolNode, 'id'>, scoped, i)
              : await runScript(node, def.node as Omit<ScriptNode, 'id'>, resolveValue((def.node as ScriptNode).input, scoped), i);
          state = out;
          iterations.push(out);
          // After the iteration, `state` is its output and `iteration` the number completed.
          exited = evaluateCel(def.exit, { ...s, state: out, iteration: i + 1 }) === true;
        }
        if (!exited && (def.on_max ?? 'fail') === 'fail') {
          throw ApplicationFailure.create({ type: 'contract_violation', message: `loop '${node.id}' reached max_iterations (${def.max_iterations}) without meeting its exit condition: ${def.exit}`, nonRetryable: true });
        }
        return { output: { state: state ?? null, iterations, count: iterations.length, exited } };
      }
      case 'subworkflow': {
        const def = node.def as SubworkflowNode;
        const prep = await gateway(node).prepareChildRun({ runId, workspaceId, nodeId: node.id, workflow: def.workflow, inputs: (resolveValue(def.input, s) ?? {}) as Record<string, unknown>, mock: input.mockWrites });
        // The child is a run of its own (own plan, ledger and page). Cancelling this run cancels it.
        await executeChild('azhiRun', {
          workflowId: prep.run.runId,
          taskQueue: workflowInfo().taskQueue,
          args: [prep.run],
          parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
          workflowExecutionTimeout: node.timeoutMs + 60_000,
        });
        const result = await gateway(node).childResult(workspaceId, prep.run.runId);
        if (result.state !== 'succeeded') {
          throw ApplicationFailure.create({
            type: result.error?.class ?? 'internal',
            message: `subworkflow '${prep.workflow}' (run ${prep.run.runId}) ended ${result.state}${result.error ? `: ${result.error.message}` : ''}`,
            nonRetryable: true,
          });
        }
        return { output: { run_id: prep.run.runId, workflow: prep.workflow, version: prep.version, state: result.state, nodes: result.nodes } };
      }
      case 'retrieve': {
        const def = node.def as RetrieveNode;
        if (def.filters && Object.keys(def.filters).length) {
          throw ApplicationFailure.create({ type: 'unsupported_capability', message: 'retrieve filters arrive with document-level ACL in the first release', nonRetryable: true });
        }
        const query = resolveValue(def.query, s);
        return {
          output: await gateway(node).retrieveNode({
            runId,
            workspaceId,
            nodeId: node.id,
            pinned: pinned(def.datasets),
            query: typeof query === 'string' ? query : JSON.stringify(query),
            topK: def.top_k,
            principal: snapshot.principal,
          }),
        };
      }
      case 'agent':
        return { output: await runAgent(node, node.def as AgentNode, s) };
      case 'approval':
        return { output: await awaitApproval(node, node.def as ApprovalNode, s) };
      default:
        throw ApplicationFailure.create({ type: 'unsupported_capability', message: `node type '${node.type}' cannot run on this interpreter build yet`, nonRetryable: true });
    }
  };

  const shouldSkip = (node: PlanNode): boolean => {
    if (testNode?.node === node.id) return false;
    if (node.route) {
      const cond = status.nodes[node.route.condition];
      if (cond?.status === 'skipped' || cond?.route !== node.route.route) return true;
    }
    // A rejected approval skips everything downstream of it.
    const blocked = (d: string) => status.nodes[d]?.status === 'skipped' || status.nodes[d]?.status === 'failed' || rejected.has(d);
    // A merge node joins alternative branches: it runs when any upstream node got through.
    if (node.def.merge === 'any') return node.deps.length > 0 && node.deps.every(blocked);
    return node.deps.some(blocked);
  };

  const runNode = async (node: PlanNode) => {
    await setNode(node.id, 'running');
    try {
      const r = await execute(node);
      outputs[node.id] = { output: r.output };
      await setNode(node.id, 'succeeded', { output: r.output, route: r.route, attempt: node.type === 'loop' || node.type === 'subworkflow' });
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
    if (testNode) for (const n of plan.nodes) if (status.nodes[n.id]!.status === 'skipped') await setNode(n.id, 'skipped');
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
