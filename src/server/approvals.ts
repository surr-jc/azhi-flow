import type { Client } from '@temporalio/client';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ExecutionPlan } from '../compiler/plan.js';
import type { Role } from '../db/schema.js';
import type { ApprovalNode } from '../definition/types.js';
import { postMessage } from '../gateway/tools/slack.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { TERMINAL_STATES } from '../runtime/types.js';
import { requireRole, type Principal } from '../api/auth.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';
import { resolveSecret } from './secrets.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });

/**
 * Deciding an approval (spec section 7), from the API, mission control or a Slack button alike:
 * the approver's role and the decision schema are checked, then the interpreter is signalled and
 * records the first decision. `via` only labels the audit entry.
 */
export async function decideApproval(
  ctx: AppContext,
  temporal: Client | undefined,
  p: Principal,
  runId: string,
  b: { node: string; decision: 'approved' | 'rejected'; data: Record<string, unknown> },
  via: 'api' | 'slack' = 'api',
) {
  if (p.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot decide approvals');
  const row = (await ctx.pool.query(`SELECT r.state, v.plan FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id=$1 AND r.workspace_id=$2`, [runId, p.workspaceId])).rows[0];
  if (!row) throw new AzhiError(ErrorClass.invalidInput, 'run not found');
  const node = (row.plan as ExecutionPlan).nodes.find((n) => n.id === b.node);
  if (!node || node.type !== 'approval') throw new AzhiError(ErrorClass.invalidInput, `run ${runId} has no approval node '${b.node}'`);
  const def = node.def as ApprovalNode;
  requireRole(p, (def.role ?? 'operator') as Role);
  if (b.decision === 'approved' && def.decision_schema) {
    const validate = ajv.compile(def.decision_schema);
    if (!validate(b.data)) throw new AzhiError(ErrorClass.invalidInput, `decision data does not match the decision schema: ${ajv.errorsText(validate.errors)}`);
  }
  const decided = (await ctx.pool.query(`SELECT decision FROM approvals WHERE run_id=$1 AND node_id=$2`, [runId, b.node])).rows[0];
  if (decided) throw new AzhiError(ErrorClass.invalidInput, `approval '${b.node}' was already decided: ${decided.decision}`);
  const requested = (await ctx.pool.query(`SELECT 1 FROM run_events WHERE run_id=$1 AND node_id=$2 AND kind='approval.requested'`, [runId, b.node])).rowCount;
  if (!requested || TERMINAL_STATES.includes(row.state)) throw new AzhiError(ErrorClass.invalidInput, `approval '${b.node}' is not waiting for a decision (run is ${row.state})`);
  if (!temporal) throw new AzhiError(ErrorClass.transient, 'not connected to Temporal');
  await temporal.workflow.getHandle(runId).signal('approval', { node: b.node, decision: b.decision, by: p.userId, at: new Date().toISOString(), data: b.data });
  await audit(ctx, p.workspaceId, p.userId, 'approval.submitted', { run: runId, node: b.node, decision: b.decision, ...(via === 'api' ? {} : { via }) });
}

export interface ApprovalSettings { slack_channel?: string }

export async function approvalSettings(ctx: AppContext, workspaceId: string): Promise<ApprovalSettings> {
  return ((await ctx.pool.query(`SELECT settings->'approvals' AS a FROM workspaces WHERE id=$1`, [workspaceId])).rows[0]?.a ?? {}) as ApprovalSettings;
}

const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The Slack message for a waiting approval: what is asked, who may decide, and the two buttons. */
export function approvalBlocks(a: { runId: string; nodeId: string; workflow: string; message: unknown; payload: unknown; role: string; expires_at: string; baseUrl: string }) {
  const value = JSON.stringify({ run: a.runId, node: a.nodeId });
  const link = `${a.baseUrl.replace(/\/$/, '')}/ui/runs/${encodeURIComponent(a.runId)}`;
  const payload = text(a.payload);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:raised_hand: *Approval needed* on *${a.workflow}* (${a.nodeId})\n${clip(text(a.message) || 'Approve this step?', 2500)}` } },
    ...(payload ? [{ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${clip(payload, 2500)}\`\`\`` } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Role ${a.role} or higher decides. Expires ${a.expires_at}. <${link}|Open in mission control>` }] },
    {
      type: 'actions',
      block_id: 'azhi_approval',
      elements: [
        { type: 'button', action_id: 'approve', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', value },
        { type: 'button', action_id: 'reject', text: { type: 'plain_text', text: 'Reject' }, style: 'danger', value },
      ],
    },
  ];
}

/**
 * Posts a waiting approval to the workspace's approvals channel, once (retried activities find
 * the row and skip). Best effort: deciding in mission control or the API works without it.
 */
export async function postApprovalToSlack(ctx: AppContext, workspaceId: string, runId: string, nodeId: string, request: { message: unknown; payload: unknown; role: string; expires_at: string }) {
  const s = await approvalSettings(ctx, workspaceId);
  if (!s.slack_channel) return;
  const claimed = await ctx.pool.query(`INSERT INTO approval_messages(run_id, node_id, workspace_id, channel) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [runId, nodeId, workspaceId, s.slack_channel]);
  if (!claimed.rowCount) return;
  try {
    const token = await resolveSecret(ctx, workspaceId, 'slack-bot-token');
    if (!token) throw new Error("the secret 'slack-bot-token' is not set");
    const workflow = (await ctx.pool.query(`SELECT w.slug FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id WHERE r.id=$1`, [runId])).rows[0]?.slug ?? 'workflow';
    const blocks = approvalBlocks({ runId, nodeId, workflow, ...request, baseUrl: ctx.settings.publicUrl });
    const r = await postMessage({ token: token.value, apiUrl: ctx.settings.slackApiUrl }, { channel: s.slack_channel, text: `Approval needed on ${workflow} (${nodeId})`, blocks, dedupeKey: `approval:${runId}:${nodeId}` });
    await ctx.pool.query(`UPDATE approval_messages SET ts=$3, channel=$4 WHERE run_id=$1 AND node_id=$2`, [runId, nodeId, r.ts, r.channel]);
  } catch (e) {
    await audit(ctx, workspaceId, null, 'approval.slack_failed', { run: runId, node: nodeId, error: (e as Error).message });
  }
}
