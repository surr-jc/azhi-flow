import type { Client } from '@temporalio/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Role } from '../db/schema.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { approvalAsk, approvalModal, approvalSettings, decideApproval, formFields, modalData } from '../server/approvals.js';
import { openView } from '../gateway/tools/slack.js';
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
  trigger_id?: string;
  /** A submitted modal (`view_submission`): the metadata we put on it and the values typed. */
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, any>> } };
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
      const submitted = payload.type === 'view_submission' && payload.view?.callback_id === 'azhi_approval_form';
      const action = payload.actions?.[0];
      let target: { run: string; node: string; response_url?: string };
      try {
        target = z.object({ run: z.string(), node: z.string(), response_url: z.string().optional() }).parse(JSON.parse(submitted ? (payload.view?.private_metadata ?? '') : (action?.value ?? '')));
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
      const responseUrl = submitted ? target.response_url : payload.response_url;
      const principal = linked ? ({ kind: 'user', workspaceId: ws, userId: linked.id, role: linked.role } as const) : undefined;

      // A submitted answer form: validate it like the web form does, then record the approval.
      if (submitted) {
        const values = payload.view?.state?.values;
        const firstBlock = Object.keys(values ?? {})[0];
        const refuse = (message: string, block = firstBlock) => reply.status(200).send({ response_action: 'errors', errors: { [block ?? 'f_answers']: message } });
        if (!principal) return refuse('Your Slack user is not linked to Azhi Flow. An admin can link it on the Users page.');
        const ask = await approvalAsk(ctx, target.run, target.node);
        const fields = formFields(ask?.def.decision_schema);
        if (!ask || !fields) return refuse(`This approval cannot be answered here. Decide in mission control: ${link}`);
        let data: Record<string, unknown>;
        try {
          data = modalData(ask.def.decision_schema, fields, values);
        } catch (e) {
          return refuse((e as Error).message, `f_${(e as { field?: string }).field ?? ''}`);
        }
        try {
          await decideApproval(ctx, temporal, principal, target.run, { node: target.node, decision: 'approved', data }, 'slack');
        } catch (e) {
          return refuse((e as Error).message);
        }
        await respond(responseUrl, { replace_original: true, text: `:white_check_mark: Approved by <@${slackUser}> with their answers (${target.node} on ${target.run}).` });
        return reply.status(200).send();
      }

      if (!principal) {
        await respond(responseUrl, { response_type: 'ephemeral', replace_original: false, text: `Your Slack user is not linked to Azhi Flow, so this was not recorded. An admin can link it on the Users page, or decide in mission control: ${link}` });
        return reply.status(200).send();
      }
      const decision = action!.action_id === 'approve' ? 'approved' : 'rejected';
      const say = (text: string) => respond(responseUrl, { response_type: 'ephemeral', replace_original: false, text });

      // Approve on a step that needs answers opens a form (Slack gives three seconds to open it).
      if (decision === 'approved') {
        const ask = await approvalAsk(ctx, target.run, target.node);
        const schema = ask?.def.decision_schema as { required?: string[] } | undefined;
        if (ask && schema?.required?.length) {
          const fields = formFields(ask.def.decision_schema);
          try {
            requireRole(principal, (ask.def.role ?? 'operator') as Role);
            if (!fields?.length) throw new Error('this approval needs answers that Slack cannot collect');
            if (!payload.trigger_id) throw new Error('Slack sent no trigger to open the form');
            const token = await resolveSecret(ctx, ws, 'slack-bot-token');
            if (!token) throw new Error("the secret 'slack-bot-token' is not set");
            const intro = [ask.message || `Approve ${target.node}?`, ask.payload ? `\`\`\`${ask.payload.slice(0, 2000)}\`\`\`` : '', `<${link}|Open the run in mission control>`].filter(Boolean).join('\n');
            await openView({ token: token.value, apiUrl: ctx.settings.slackApiUrl }, { trigger_id: payload.trigger_id, view: approvalModal({ run: target.run, node: target.node, responseUrl: payload.response_url, fields, intro }) });
          } catch (e) {
            await say(`Not recorded: ${(e as Error).message}. You can decide in mission control: ${link}`);
          }
          return reply.status(200).send();
        }
      }
      try {
        await decideApproval(ctx, temporal, principal, target.run, { node: target.node, decision, data: {} }, 'slack');
        await respond(responseUrl, {
          replace_original: true,
          text: `${decision === 'approved' ? ':white_check_mark: Approved' : ':x: Rejected'} by <@${slackUser}> (${target.node} on ${target.run}).`,
        });
      } catch (e) {
        await say(`Not recorded: ${(e as Error).message}. You can decide in mission control: ${link}`);
      }
      return reply.status(200).send();
    });
  });
}
