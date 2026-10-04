import { Context } from '@temporalio/activity';
import { ARTIFACT_THRESHOLD_BYTES } from '../artifacts/store.js';
import { asArtifact, callTool } from '../gateway/gateway.js';
import { byteSize } from '../lib/json.js';
import { signRunToken } from '../security/tokens.js';
import type { AppContext } from '../server/context.js';
import { packageFile } from '../server/packages.js';
import { evaluateWorkerTrust } from '../server/trust.js';
import type { GatewayActivities, NotifyNodeInput, RecordRunPatch, ReportNodeInput, ToolNodeInput } from './activity-types.js';
import { toFailure } from './activity-errors.js';
import { renderReport } from './report.js';
import { TERMINAL_STATES, type NodeError } from './types.js';

const SLACK_TOOL = 'slack.post-message@1';

/** Activities that run in the server process on the `azhi-gateway` task queue. */
export function gatewayActivities(ctx: AppContext): GatewayActivities {
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
      if (status === 'skipped' || (status === 'succeeded' && data.route !== undefined)) {
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
        return renderReport(template, input.input, { summary: input.summary, asOf: input.asOf, format: input.format });
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

    async issueRunToken(workspaceId, runId, nodeId, tools) {
      return signRunToken(ctx.secretKey, { ws: workspaceId, run: runId, node: nodeId, tools, exp: Math.floor(Date.now() / 1000) + 3600 });
    },

    async requestApproval(runId, workspaceId, nodeId, request) {
      const output = byteSize(request) > ARTIFACT_THRESHOLD_BYTES ? asArtifact(ctx, workspaceId, request) : request;
      await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, node_id, data) VALUES ($1,$2,'approval.requested',$3,$4)`, [
        workspaceId,
        runId,
        nodeId,
        JSON.stringify(output),
      ]);
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
