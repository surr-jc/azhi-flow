import { Context } from '@temporalio/activity';
import { agentBegin, agentTurn, estimateCost, harnessPrepare, loadProfile, resolveModelName, type AgentBeginInput } from '../agents/model-agent.js';
import { COPILOT_PRICING_REVISION, copilotCredits, copilotRate } from '../agents/copilot-pricing.js';
import type { AgentProfile } from '../agents/profile.js';
import type { HarnessResult } from '../worker/harness-activity.js';
import { retrieve } from '../knowledge/datasets.js';
import { ARTIFACT_THRESHOLD_BYTES } from '../artifacts/store.js';
import { asArtifact, callTool } from '../gateway/gateway.js';
import { byteSize } from '../lib/json.js';
import { signRunToken } from '../security/tokens.js';
import type { AppContext } from '../server/context.js';
import { packageFile } from '../server/packages.js';
import { postApprovalToSlack } from '../server/approvals.js';
import { createRun, loadRunInput } from '../server/runs.js';
import { evaluateWorkerTrust } from '../server/trust.js';
import { resolveVersion } from '../server/workflows.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import type { GatewayActivities, NotifyNodeInput, RecordRunPatch, ReportNodeInput, ToolNodeInput } from './activity-types.js';
import { toFailure } from './activity-errors.js';
import { citationIds, renderReport } from './report.js';
import { TERMINAL_STATES, type NodeError, type RunSnapshot } from './types.js';

/** How many workflows deep a subworkflow may nest; a workflow may not appear twice in its own chain. */
const MAX_SUBWORKFLOW_DEPTH = 4;

const SLACK_TOOL = 'slack.post-message@1';

/** Activities that run in the server process on the `azhi-gateway` task queue. */
export function gatewayActivities(ctx: AppContext): GatewayActivities {
  const withChunks = (input: AgentBeginInput) => withChunksFor(ctx, input);
  /** Records one attempt of an activity-backed node in node_attempts. */
  async function attempt<T>(runId: string, workspaceId: string, nodeId: string, fn: () => Promise<T>): Promise<T> {
    const n = Context.current().info.attempt;
    await ctx.pool.query(
      `INSERT INTO node_attempts(workspace_id, run_id, node_id, attempt, state, worker_id) VALUES ($1,$2,$3,$4,'running',$5)
       ON CONFLICT (run_id, node_id, attempt) DO UPDATE SET state='running', started_at=now()`,
      [workspaceId, runId, nodeId, n, `server:${process.pid}`],
    );
    try {
      const out = await fn();
      const stored = byteSize(out) > ARTIFACT_THRESHOLD_BYTES ? asArtifact(ctx, workspaceId, out) : out;
      await ctx.pool.query(`UPDATE node_attempts SET state='succeeded', ended_at=now(), output=$4 WHERE run_id=$1 AND node_id=$2 AND attempt=$3`, [
        runId,
        nodeId,
        n,
        JSON.stringify(stored ?? null),
      ]);
      return out;
    } catch (err) {
      const f = toFailure(err);
      await ctx.pool.query(`UPDATE node_attempts SET state='failed', ended_at=now(), error=$4 WHERE run_id=$1 AND node_id=$2 AND attempt=$3`, [
        runId,
        nodeId,
        n,
        JSON.stringify({ class: f.type, message: f.message, retryable: !f.nonRetryable }),
      ]);
      throw f;
    }
  }

  return {
    async recordRun(runId, workspaceId, patch: RecordRunPatch) {
      const sets: string[] = [];
      const vals: unknown[] = [runId, workspaceId];
      if (patch.state) {
        vals.push(patch.state);
        sets.push(`state=$${vals.length}`);
        if (patch.state === 'running') sets.push('started_at=COALESCE(started_at, now())');
        if (TERMINAL_STATES.includes(patch.state)) sets.push('ended_at=COALESCE(ended_at, now())');
      }
      if (patch.flags) {
        vals.push(JSON.stringify(patch.flags));
        sets.push(`flags=$${vals.length}`);
      }
      if (patch.error !== undefined) {
        vals.push(JSON.stringify(patch.error));
        sets.push(`error=$${vals.length}`);
      }
      if (sets.length) {
        // Terminal states are final: a replayed or late update never moves a finished run.
        await ctx.pool.query(
          `UPDATE runs SET ${sets.join(', ')} WHERE id=$1 AND workspace_id=$2 AND state NOT IN ('succeeded','delivery_failed','failed','cancelled','expired')`,
          vals,
        );
      }
      if (patch.event) {
        await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, node_id, data) VALUES ($1,$2,$3,$4,$5)`, [
          workspaceId,
          runId,
          patch.event.kind,
          patch.event.node ?? null,
          JSON.stringify({ ...(patch.event.data ?? {}), ...(patch.state ? { state: patch.state } : {}), ...(patch.flags ? { flags: patch.flags } : {}), ...(patch.error ? { error: patch.error } : {}) }),
        ]);
      }
    },

    async recordNode(runId, workspaceId, nodeId, status, data = {}) {
      const output = data.output === undefined ? undefined : byteSize(data.output) > ARTIFACT_THRESHOLD_BYTES ? asArtifact(ctx, workspaceId, data.output) : data.output;
      await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, node_id, data) VALUES ($1,$2,$3,$4,$5)`, [
        workspaceId,
        runId,
        `node.${status}`,
        nodeId,
        JSON.stringify({ ...(data.error ? { error: data.error } : {}), ...(data.route ? { route: data.route } : {}) }),
      ]);
      // Nodes the interpreter evaluates itself (conditions, skips) get a synthetic attempt row.
      if (status === 'skipped' || (status === 'succeeded' && (data.route !== undefined || data.attempt))) {
        await ctx.pool.query(
          `INSERT INTO node_attempts(workspace_id, run_id, node_id, attempt, state, ended_at, output) VALUES ($1,$2,$3,1,$4,now(),$5)
           ON CONFLICT (run_id, node_id, attempt) DO NOTHING`,
          [workspaceId, runId, nodeId, status, output === undefined ? null : JSON.stringify(output)],
        );
      }
    },

    async toolNode(input: ToolNodeInput) {
      return attempt(input.runId, input.workspaceId, input.nodeId, async () => {
        const hb = setInterval(() => Context.current().heartbeat(), 5000);
        try {
          if (input.mock) return { output: null, observation: { source: 'mock', observed_at: new Date().toISOString() } };
          const r = await callTool(ctx, { ...input, attempt: Context.current().info.attempt });
          return r as unknown as { output: unknown; observation: { source: string; observed_at: string } & Record<string, unknown>; action?: { id: string; reused: boolean } };
        } finally {
          clearInterval(hb);
        }
      });
    },

    async notifyNode(input: NotifyNodeInput) {
      return attempt(input.runId, input.workspaceId, input.nodeId, async () => {
        if (input.mock) return { action_id: 'mock', delivered: false, receipt: { mocked: true } };
        const hb = setInterval(() => Context.current().heartbeat(), 5000);
        try {
          const r = await callTool(ctx, {
            workspaceId: input.workspaceId,
            runId: input.runId,
            nodeId: input.nodeId,
            attempt: Context.current().info.attempt,
            tool: SLACK_TOOL,
            args: { channel: input.destination, text: input.text },
            allowed: [SLACK_TOOL],
          });
          return { action_id: r.action!.id, delivered: true, receipt: r.output as object };
        } finally {
          clearInterval(hb);
        }
      });
    },

    async reportNode(input: ReportNodeInput) {
      return attempt(input.runId, input.workspaceId, input.nodeId, async () => {
        const template = (await packageFile(ctx, input.workspaceId, input.packageHash, input.template)).toString('utf8');
        // Citation IDs in the input resolve to their immutable excerpts (dataset, revision, offsets).
        const ids = citationIds(input.input);
        const sources = ids.length
          ? (
              await ctx.pool.query(
                `SELECT c.id, d.name AS dataset, c.revision, c.path AS document, coalesce(c.heading, '') AS heading, c.start_offset AS start, c.end_offset AS "end"
                 FROM chunks c JOIN datasets d ON d.id = c.dataset_id WHERE d.workspace_id=$1 AND c.id = ANY($2)`,
                [input.workspaceId, ids],
              )
            ).rows
          : [];
        return renderReport(template, input.input, { summary: input.summary, asOf: input.asOf, format: input.format, sources });
      });
    },

    async checkWorkers(workspaceId, packageHash, runtime) {
      const sig = (await ctx.pool.query(`SELECT signature FROM workflow_versions WHERE workspace_id=$1 AND package_hash=$2 AND signature IS NOT NULL LIMIT 1`, [workspaceId, packageHash])).rows[0]
        ?.signature;
      const trust = await evaluateWorkerTrust(ctx, workspaceId, sig ?? null, packageHash);
      const rows = (
        await ctx.pool.query(`SELECT id, task_queue, capabilities FROM workers WHERE workspace_id=$1 AND task_queue LIKE 'azhi-exec-%' AND last_heartbeat > now() - interval '30 seconds' ORDER BY id`, [
          workspaceId,
        ])
      ).rows as Array<{ id: string; task_queue: string; capabilities: { runtimes?: Record<string, unknown> } }>;
      const accepted: Array<{ id: string; queue: string }> = [];
      const refused: Array<{ id: string; reason: string }> = [];
      for (const w of rows) {
        const t = trust.workers.find((x) => x.worker === w.id);
        if (!w.capabilities.runtimes?.[runtime]) refused.push({ id: w.id, reason: `no ${runtime} runtime` });
        else if (!t?.accepted) refused.push({ id: w.id, reason: t?.reason ?? 'trust policy refused the package' });
        else accepted.push({ id: w.id, queue: w.task_queue });
      }
      return { online: rows.length, accepted, refused };
    },

    async issueRunToken(workspaceId, runId, nodeId, tools, creds) {
      return signRunToken(ctx.secretKey, { ws: workspaceId, run: runId, node: nodeId, tools, ...(creds?.length ? { creds } : {}), exp: Math.floor(Date.now() / 1000) + 3600 });
    },

    async agentBegin(input) {
      await ctx.pool.query(
        `INSERT INTO node_attempts(workspace_id, run_id, node_id, attempt, state, worker_id) VALUES ($1,$2,$3,1,'running',$4)
         ON CONFLICT (run_id, node_id, attempt) DO UPDATE SET state='running'`,
        [input.workspaceId, input.runId, input.nodeId, `model-agent:${process.pid}`],
      );
      try {
        return await agentBegin(ctx, await withChunks(input));
      } catch (err) {
        throw toFailure(err);
      }
    },

    async agentTurn(input) {
      const c = Context.current();
      const hb = setInterval(() => c.heartbeat(), 5000);
      try {
        const r = await agentTurn(ctx, input, { fence: c.info.attempt, signal: c.cancellationSignal });
        if (r.done) {
          const stored = byteSize(r.output) > ARTIFACT_THRESHOLD_BYTES ? asArtifact(ctx, input.workspaceId, r.output) : r.output;
          await ctx.pool.query(`UPDATE node_attempts SET state='succeeded', ended_at=now(), output=$4 WHERE run_id=$1 AND node_id=$2 AND attempt=$3`, [
            input.runId,
            input.nodeId,
            1,
            JSON.stringify(stored ?? null),
          ]);
        }
        return r;
      } catch (err) {
        throw toFailure(err);
      } finally {
        clearInterval(hb);
      }
    },

    async harnessPrepare(input) {
      await ctx.pool.query(
        `INSERT INTO node_attempts(workspace_id, run_id, node_id, attempt, state, worker_id) VALUES ($1,$2,$3,1,'running',NULL)
         ON CONFLICT (run_id, node_id, attempt) DO UPDATE SET state='running'`,
        [input.workspaceId, input.runId, input.nodeId],
      );
      try {
        return await harnessPrepare(ctx, await withChunks(input), input.executor ?? 'opencode');
      } catch (err) {
        throw toFailure(err);
      }
    },

    async harnessRecord(input) {
      const r = input.result;
      const { profile } = await loadProfile(ctx, input.workspaceId, input.packageHash, input.profile);
      const model = resolveModelName(ctx, profile);
      const priced = harnessCost(ctx, profile, model, r);
      const cost = priced?.cost ?? null;
      await ctx.pool.query(
        `INSERT INTO usage_records(workspace_id, run_id, node_id, attempt, turn, executor, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, currency, cost_label, pricing_revision, credits)
         VALUES ($1,$2,$3,1,1,$4,$15,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$16) ON CONFLICT (run_id, node_id, attempt, turn) DO NOTHING`,
        [
          input.workspaceId,
          input.runId,
          input.nodeId,
          `${r.harness.name}@${r.harness.version}`,
          model,
          r.usage.input_tokens,
          r.usage.output_tokens,
          r.usage.cache_read_tokens,
          r.usage.cache_write_tokens,
          r.usage.reasoning_tokens,
          cost,
          priced?.currency ?? null,
          cost === null ? 'unavailable' : profile.model.provider === 'openai-chatgpt' ? 'reported' : 'estimated',
          priced?.revision ?? null,
          profile.model.provider,
          priced?.credits ?? null,
        ],
      );
      await ctx.pool.query(`UPDATE context_manifests SET tainted=$4, total_tokens=$5, token_source=$6 WHERE run_id=$1 AND node_id=$2 AND attempt=$3`, [
        input.runId,
        input.nodeId,
        1,
        Boolean(input.tainted),
        r.usage.input_tokens,
        r.usage.input_tokens === null ? 'estimated' : 'reported',
      ]);
      const ok = r.output !== undefined && !r.error;
      const stored = ok ? (byteSize(r.output) > ARTIFACT_THRESHOLD_BYTES ? asArtifact(ctx, input.workspaceId, r.output) : r.output) : null;
      await ctx.pool.query(`UPDATE node_attempts SET state=$4, ended_at=now(), output=$5, error=$6, worker_id=$7 WHERE run_id=$1 AND node_id=$2 AND attempt=$3`, [
        input.runId,
        input.nodeId,
        1,
        ok ? 'succeeded' : 'failed',
        JSON.stringify(stored),
        r.error ? JSON.stringify({ ...r.error, retryable: false }) : null,
        `${r.harness.name}@${r.harness.version}`,
      ]);
    },

    async prepareChildRun(input) {
      try {
        const parent = (
          await ctx.pool.query(`SELECT r.snapshot, r.created_by, w.slug FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id WHERE r.id=$1 AND r.workspace_id=$2`, [input.runId, input.workspaceId])
        ).rows[0] as { snapshot: RunSnapshot; created_by: string | null; slug: string } | undefined;
        if (!parent) throw new AzhiError(ErrorClass.invalidInput, `parent run ${input.runId} not found`);
        const target = await resolveVersion(ctx, input.workspaceId, input.workflow);
        if (!target || target.draft) throw new AzhiError(ErrorClass.invalidInput, `subworkflow '${input.workflow}' has no published version in this workspace`);
        const chain = [...(parent.snapshot.parent?.chain ?? []), parent.slug];
        if (chain.includes(target.slug)) throw new AzhiError(ErrorClass.invalidInput, `subworkflow '${target.slug}' would call itself (${[...chain, target.slug].join(' -> ')})`);
        if (chain.length >= MAX_SUBWORKFLOW_DEPTH) throw new AzhiError(ErrorClass.invalidInput, `subworkflows are nested more than ${MAX_SUBWORKFLOW_DEPTH} deep (${chain.join(' -> ')})`);
        const { runId } = await createRun(ctx, input.workspaceId, {
          version: target,
          inputs: input.inputs,
          trigger: 'subworkflow',
          // The child acts as whoever the parent run acts as, and is idempotent per parent node.
          createdBy: parent.snapshot.principal?.userId ?? parent.created_by,
          occurrenceId: `sub:${input.runId}:${input.nodeId}`,
          interpreterBuild: parent.snapshot.interpreter_build,
          test: input.mock,
          parent: { run_id: input.runId, node_id: input.nodeId, chain },
        });
        return { run: await loadRunInput(ctx, input.workspaceId, runId), workflow: target.slug, version: target.version };
      } catch (err) {
        throw toFailure(err);
      }
    },

    async childResult(workspaceId, runId) {
      const run = (await ctx.pool.query(`SELECT state, error FROM runs WHERE id=$1 AND workspace_id=$2`, [runId, workspaceId])).rows[0] as { state: string; error: NodeError | null } | undefined;
      const rows = (await ctx.pool.query(`SELECT DISTINCT ON (node_id) node_id, output FROM node_attempts WHERE run_id=$1 AND state='succeeded' ORDER BY node_id, attempt DESC`, [runId])).rows as Array<{ node_id: string; output: unknown }>;
      return { state: run?.state ?? 'failed', ...(run?.error ? { error: run.error } : {}), nodes: Object.fromEntries(rows.map((r) => [r.node_id, r.output])) };
    },

    async agentFailed(runId, workspaceId, nodeId, error) {
      await ctx.pool.query(`UPDATE node_attempts SET state='failed', ended_at=now(), error=$4 WHERE run_id=$1 AND node_id=$2 AND attempt=$3 AND workspace_id=$5`, [
        runId,
        nodeId,
        1,
        JSON.stringify(error),
        workspaceId,
      ]);
    },

    async retrieveNode(input) {
      return attempt(input.runId, input.workspaceId, input.nodeId, async () => ({
        chunks: await retrieve(ctx, input.workspaceId, { pinned: input.pinned, query: input.query, topK: input.topK, principal: input.principal }),
      }));
    },

    async requestApproval(runId, workspaceId, nodeId, request) {
      const output = byteSize(request) > ARTIFACT_THRESHOLD_BYTES ? asArtifact(ctx, workspaceId, request) : request;
      await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, node_id, data) VALUES ($1,$2,'approval.requested',$3,$4)`, [
        workspaceId,
        runId,
        nodeId,
        JSON.stringify(output),
      ]);
      await postApprovalToSlack(ctx, workspaceId, runId, nodeId, request);
    },

    async recordApproval(runId, workspaceId, nodeId, d) {
      // Idempotent under activity retries: the primary key holds one decision per approval node.
      await ctx.pool.query(
        `INSERT INTO approvals(run_id, node_id, workspace_id, decision, decided_by, data, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [runId, nodeId, workspaceId, d.recorded, d.by, JSON.stringify(d.data), d.at],
      );
      const output = { decision: d.decision, by: d.by, at: d.at, data: d.data };
      await ctx.pool.query(
        `INSERT INTO node_attempts(workspace_id, run_id, node_id, attempt, state, ended_at, output) VALUES ($1,$2,$3,1,'succeeded',now(),$4)
         ON CONFLICT (run_id, node_id, attempt) DO NOTHING`,
        [workspaceId, runId, nodeId, JSON.stringify(output)],
      );
      await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, node_id, data) VALUES ($1,$2,'approval.decided',$3,$4)`, [
        workspaceId,
        runId,
        nodeId,
        JSON.stringify({ decision: d.recorded, by: d.by }),
      ]);
    },
  };
}

export type { NodeError };

/** Every string and number in a value, as retrieval query text. */
function textOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(textOf).join(' ');
  if (typeof v === 'object') return Object.entries(v as object).map(([k, x]) => `${k} ${textOf(x)}`).join(' ');
  return '';
}

/** The context builder retrieves with the node input as the query (spec section 11). */
async function withChunksFor(ctx: AppContext, input: AgentBeginInput): Promise<AgentBeginInput> {
  if (!input.datasets?.length) return input;
  const found = await retrieve(ctx, input.workspaceId, { pinned: input.datasets, query: textOf(input.input), principal: input.principal });
  return { ...input, chunks: found.map((c) => ({ id: c.citation_id, dataset: c.dataset, revision: c.revision, heading: c.heading, text: c.text })) };
}

/**
 * A harness step's estimated cost. Copilot steps are counted in AI Credits (tokens at the model's
 * Copilot rate); other providers by the profile's token prices.
 */
export function harnessCost(ctx: Pick<AppContext, 'settings'>, profile: AgentProfile, model: string | null, r: Pick<HarnessResult, 'usage'>) {
  if (profile.model.provider === 'github-copilot') {
    const rate = model ? copilotRate(model, profile.pricing, ctx.settings) : undefined;
    const c = rate ? copilotCredits(r.usage, rate, ctx.settings.copilotCreditUsd) : null;
    if (!c) return null;
    return { cost: c.cost, currency: 'USD', credits: c.credits, revision: `${profile.pricing?.revision ?? COPILOT_PRICING_REVISION} at ${ctx.settings.copilotCreditUsd} USD/credit` };
  }
  // A ChatGPT plan has no per-token charge: the step uses the plan's usage limits, so its cost is 0.
  if (profile.model.provider === 'openai-chatgpt') return { cost: 0, currency: 'USD', credits: null, revision: 'ChatGPT plan (no per-token charge)' };
  const cost = estimateCost(r.usage, profile.pricing);
  return cost === null ? null : { cost, currency: profile.pricing!.currency ?? 'USD', credits: null, revision: profile.pricing!.revision ?? 'unversioned' };
}
