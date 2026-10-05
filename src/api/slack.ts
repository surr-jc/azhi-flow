import type { Client } from '@temporalio/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Role } from '../db/schema.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { approvalSettings, decideApproval } from '../server/approvals.js';
import { audit } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { resolveSecret } from '../server/secrets.js';
import { requireRole } from './auth.js';

/**
 * Approvals from Slack buttons (Phase 4 item 5). A waiting approval is posted to the workspace's
 * approvals channel with Approve and Reject buttons. Slack sends each click here, signed with the
 * app's signing secret (the workspace secret `slack-signing-secret`). The clicking Slack user must
 * be linked to an Azhi Flow user (Users page), and the decision then goes through the same checks
 * as the API: that user's role, the decision schema, and "first decision wins".
 */
export const SLACK_INTERACTIONS = '/v1/slack/interactions';
const MAX_SKEW_S = 5 * 60;

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

interface BlockAction {
  type: string;
  user?: { id: string; username?: string };
  actions?: Array<{ action_id: string; value?: string }>;
  response_url?: string;
}

export function verifySlackSignature(secret: string, timestamp: string | undefined, signature: string | undefined, body: string, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_S) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function respond(url: string | undefined, body: Record<string, unknown>) {
  // The URL comes from a payload whose signature was checked, so it is Slack's.
  if (!url) return;
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
}

export function registerSlackRoutes(app: FastifyInstance, ctx: AppContext, temporal: Client | undefined) {
  app.get('/v1/settings/approvals', async (req) => {
    const p = user(req);
    const s = await approvalSettings(ctx, p.workspaceId);
    const secrets = (await ctx.pool.query(`SELECT DISTINCT name FROM secrets WHERE workspace_id=$1 AND name = ANY($2)`, [p.workspaceId, ['slack-bot-token', 'slack-signing-secret']])).rows.map((r) => r.name);
    return {
      slack_channel: s.slack_channel ?? null,
      slack_token_set: secrets.includes('slack-bot-token'),
      signing_secret_set: secrets.includes('slack-signing-secret'),
      interactivity_url: `${ctx.settings.publicUrl.replace(/\/$/, '')}${SLACK_INTERACTIONS}`,
    };
  });

  app.put('/v1/settings/approvals', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ slack_channel: z.string().trim().max(80).nullable() }).parse(req.body);
    const value = b.slack_channel ? { slack_channel: b.slack_channel } : {};
    await ctx.pool.query(`UPDATE workspaces SET settings = jsonb_set(settings, '{approvals}', $2::jsonb) WHERE id=$1`, [p.workspaceId, JSON.stringify(value)]);
    await audit(ctx, p.workspaceId, p.userId, 'settings.approvals_changed', value);
    return value;
  });

  // Slack signs the raw form body, so this route reads it unparsed.
  app.register(async (sub) => {
    sub.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    sub.post(SLACK_INTERACTIONS, async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const form = new URLSearchParams(raw);
      let payload: BlockAction;
      try {
        payload = JSON.parse(form.get('payload') ?? '');
      } catch {
        return reply.status(400).send({ error: 'invalid_input', message: 'no Slack payload' });
      }
      const action = payload.actions?.[0];
      let target: { run: string; node: string };
      try {
        target = z.object({ run: z.string(), node: z.string() }).parse(JSON.parse(action?.value ?? ''));
      } catch {
        return reply.status(200).send();
      }
      // The run names the workspace, whose signing secret must have signed this request.
      const ws = (await ctx.pool.query(`SELECT workspace_id FROM approval_messages WHERE run_id=$1 AND node_id=$2`, [target.run, target.node])).rows[0]?.workspace_id as string | undefined;
      const secret = ws ? await resolveSecret(ctx, ws, 'slack-signing-secret') : undefined;
      if (!ws || !secret || !verifySlackSignature(secret.value, req.headers['x-slack-request-timestamp'] as string, req.headers['x-slack-signature'] as string, raw)) {
        return reply.status(401).send({ error: 'authorization', message: 'invalid Slack signature' });
      }

      const slackUser = payload.user?.id;
      const linked = slackUser
        ? ((await ctx.pool.query(`SELECT id, role FROM users WHERE workspace_id=$1 AND slack_user_id=$2 AND disabled_at IS NULL`, [ws, slackUser])).rows[0] as { id: string; role: Role } | undefined)
        : undefined;
      const link = `${ctx.settings.publicUrl.replace(/\/$/, '')}/ui/runs/${encodeURIComponent(target.run)}`;
      if (!linked) {
        await respond(payload.response_url, { response_type: 'ephemeral', replace_original: false, text: `Your Slack user is not linked to Azhi Flow, so this was not recorded. An admin can link it on the Users page, or decide in mission control: ${link}` });
        return reply.status(200).send();
      }
      const decision = action!.action_id === 'approve' ? 'approved' : 'rejected';
      try {
        await decideApproval(ctx, temporal, { kind: 'user', workspaceId: ws, userId: linked.id, role: linked.role }, target.run, { node: target.node, decision, data: {} }, 'slack');
        await respond(payload.response_url, {
          replace_original: true,
          text: `${decision === 'approved' ? ':white_check_mark: Approved' : ':x: Rejected'} by <@${slackUser}> (${target.node} on ${target.run}).`,
        });
      } catch (e) {
        await respond(payload.response_url, { response_type: 'ephemeral', replace_original: false, text: `Not recorded: ${(e as Error).message}. You can decide in mission control: ${link}` });
      }
      return reply.status(200).send();
    });
  });
}
