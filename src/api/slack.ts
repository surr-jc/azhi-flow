import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AssistantDeps } from '../assistant/tools.js';
import type { Role } from '../db/schema.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { approvalAsk, approvalModal, approvalSettings, commentModal, decideApproval, decidedBlocks, formFields, modalData } from '../server/approvals.js';
import { openView, postMessage } from '../gateway/tools/slack.js';
import { clip, escapeMrkdwn } from '../gateway/tools/slack-format.js';
import { audit } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { resolveSecret } from '../server/secrets.js';
import { decideProposal, handleSlackChat, proposalWorkspace, slackAssistantSettings } from '../server/slack-assistant.js';
import { parseRunCommand, slackCommandSettings, stripMentions } from '../server/slack-runs.js';
import { startFromSlack } from '../server/slack-start.js';
import { requireRole } from './auth.js';

/**
 * Approvals from Slack buttons (Phase 4 item 5). A waiting approval is posted to the workspace's
 * approvals channel with Approve and Reject buttons. Slack sends each click here, signed with the
 * app's signing secret (the workspace secret `slack-signing-secret`). The clicking Slack user must
 * be linked to an Azhi Flow user (Users page), and the decision then goes through the same checks
 * as the API: that user's role, the decision schema, and "first decision wins".
 */
export const SLACK_INTERACTIONS = '/v1/slack/interactions';
export const SLACK_COMMANDS = '/v1/slack/commands';
export const SLACK_EVENTS = '/v1/slack/events';
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
  /** The approval message the button sits on, so its layout can be kept when it is replaced. */
  message?: { blocks?: unknown[] };
  /** A submitted modal (`view_submission`): the metadata we put on it and the values typed. */
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, any>> } };
}

export function verifySlackSignature(secret: string, timestamp: string | undefined, signature: string | undefined, body: string, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_S) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** The headers Slack sends with a signed request; Socket Mode uses them to hand an envelope to our own routes. */
export function signSlackRequest(secret: string, body: string, now = Date.now()): Record<string, string> {
  const ts = String(Math.floor(now / 1000));
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}` };
}

async function respond(url: string | undefined, body: Record<string, unknown>) {
  // The URL comes from a payload whose signature was checked, so it is Slack's.
  if (!url) return;
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
}

export function registerSlackRoutes(app: FastifyInstance, d: AssistantDeps) {
  const { ctx, temporal, interpreterBuild, log } = d;
  app.get('/v1/settings/slack-commands', async (req) => {
    const p = user(req);
    const s = await slackCommandSettings(ctx, p.workspaceId);
    const secrets = (await ctx.pool.query(`SELECT DISTINCT name FROM secrets WHERE workspace_id=$1 AND name = ANY($2)`, [p.workspaceId, ['slack-bot-token', 'slack-signing-secret']])).rows.map((r) => r.name);
    return {
      enabled: s.enabled === true,
      workflows: s.workflows ?? [],
      channel: s.channel ?? null,
      slack_token_set: secrets.includes('slack-bot-token'),
      signing_secret_set: secrets.includes('slack-signing-secret'),
      command_url: `${ctx.settings.publicUrl.replace(/\/$/, '')}${SLACK_COMMANDS}`,
      events_url: `${ctx.settings.publicUrl.replace(/\/$/, '')}${SLACK_EVENTS}`,
    };
  });

  app.put('/v1/settings/slack-commands', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ enabled: z.boolean(), workflows: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(50), channel: z.string().trim().max(80).nullable() }).parse(req.body);
    const value = { enabled: b.enabled, workflows: [...new Set(b.workflows)], ...(b.channel ? { channel: b.channel } : {}) };
    await ctx.pool.query(`UPDATE workspaces SET settings = jsonb_set(settings, '{slack_commands}', $2::jsonb) WHERE id=$1`, [p.workspaceId, JSON.stringify(value)]);
    await audit(ctx, p.workspaceId, p.userId, 'settings.slack_commands_changed', value);
    return value;
  });

  app.get('/v1/settings/slack-assistant', async (req) => ({ enabled: (await slackAssistantSettings(ctx, user(req).workspaceId)).enabled === true }));

  app.put('/v1/settings/slack-assistant', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ enabled: z.boolean() }).parse(req.body);
    const value = { enabled: b.enabled };
    await ctx.pool.query(`UPDATE workspaces SET settings = jsonb_set(settings, '{slack_assistant}', $2::jsonb) WHERE id=$1`, [p.workspaceId, JSON.stringify(value)]);
    await audit(ctx, p.workspaceId, p.userId, 'settings.slack_assistant_changed', value);
    return value;
  });

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

    // A signed Slack request names no run, so the workspace is the one with Slack commands or the Slack assistant enabled whose signing secret verifies it.
    const verifiedWorkspace = async (req: FastifyRequest, raw: string) => {
      const enabled = (await ctx.pool.query(`SELECT id FROM workspaces WHERE settings->'slack_commands'->>'enabled' = 'true' OR settings->'slack_assistant'->>'enabled' = 'true'`)).rows as Array<{ id: string }>;
      for (const w of enabled) {
        const secret = await resolveSecret(ctx, w.id, 'slack-signing-secret');
        if (secret && verifySlackSignature(secret.value, req.headers['x-slack-request-timestamp'] as string, req.headers['x-slack-signature'] as string, raw)) return w.id;
      }
      return undefined;
    };

    // `/azhi run <workflow> key=value ...`: starts an allowlisted workflow as the linked Azhi Flow user.
    sub.post(SLACK_COMMANDS, async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const form = new URLSearchParams(raw);
      const workspace = await verifiedWorkspace(req, raw);
      if (!workspace) return reply.status(401).send({ error: 'authorization', message: 'invalid Slack signature' });
      // Slack resends a command it thinks timed out; the first delivery is already being handled.
      if (req.headers['x-slack-retry-num']) return reply.status(200).send();
      const responseUrl = form.get('response_url') ?? undefined;
      void startFromSlack(ctx, workspace, {
        slackUser: form.get('user_id') ?? '',
        text: form.get('text') ?? '',
        channel: form.get('channel_id') ?? '',
        interpreterBuild,
        say: (text) => respond(responseUrl, { response_type: 'ephemeral', replace_original: false, text }),
      });
      return reply.status(200).send({ response_type: 'ephemeral', text: 'Starting your run…' });
    });

    // `@azhi run <workflow> key=value ...` in a channel (Events API `app_mention`): the same start, answered in the
    // thread of the message. Slack signs the raw JSON body, so it is read unparsed here.
    sub.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    sub.post(SLACK_EVENTS, async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const workspace = await verifiedWorkspace(req, raw);
      if (!workspace) return reply.status(401).send({ error: 'authorization', message: 'invalid Slack signature' });
      let body: { type?: string; challenge?: string; event_id?: string; event?: { type?: string; subtype?: string; channel_type?: string; user?: string; bot_id?: string; text?: string; channel?: string; ts?: string; thread_ts?: string } };
      try {
        body = JSON.parse(raw);
      } catch {
        return reply.status(400).send({ error: 'invalid_input', message: 'not JSON' });
      }
      // Slack checks the request URL once with a challenge it expects back.
      if (body.type === 'url_verification') return reply.status(200).send({ challenge: String(body.challenge ?? '') });
      // The app's own messages never start anything.
      const e = body.event;
      // Dropped events are logged by type only: no text, no ids.
      const skip = (why: string) => {
        log?.(`slack events: ${e?.type ?? body.type ?? 'unknown'}${e?.channel_type ? ` (${e.channel_type})` : ''} not handled: ${why}`);
        return reply.status(200).send();
      };
      if (body.type !== 'event_callback' || !e || e.bot_id || !e.user || !e.channel || !e.ts) return skip(e?.bot_id ? 'bot message' : 'not a user message event');
      const isMention = e.type === 'app_mention';
      const isDirect = e.type === 'message' && e.channel_type === 'im' && !e.subtype;
      if (!isMention && !isDirect) return skip('not a mention or direct message');
      const { user: slackUser, channel, ts } = e;
      const threadTs = e.thread_ts ?? ts;
      const text = isMention ? stripMentions(e.text ?? '') : (e.text ?? '').trim();

      // `@azhi run <workflow> ...` starts a run when Slack commands are on; anything else is a question for the assistant.
      let runRequest = false;
      if (isMention) {
        try {
          parseRunCommand(text);
          runRequest = (await slackCommandSettings(ctx, workspace)).enabled === true;
        } catch {
          // Not a run command.
        }
      }
      // A resent run mention is already being handled: its first delivery started the run.
      if (runRequest && req.headers['x-slack-retry-num']) return skip('run request resent by Slack (retry)');
      // Every other event is recorded first, so a resend of one that was received is acknowledged and nothing more.
      if (body.event_id) {
        const fresh = await ctx.pool.query(`INSERT INTO slack_events(event_id, workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [body.event_id, workspace]);
        if (!fresh.rowCount) return skip('duplicate event_id');
      }

      if (runRequest) {
        void startFromSlack(ctx, workspace, {
          slackUser,
          text,
          channel,
          threadTs,
          interpreterBuild,
          // A mention has no private reply, so problems are answered in the thread.
          say: async (note) => {
            const token = await resolveSecret(ctx, workspace, 'slack-bot-token');
            if (token) await postMessage({ token: token.value, apiUrl: ctx.settings.slackApiUrl }, { channel, threadTs, text: note, dedupeKey: `mention-reply:${channel}:${ts}:${Date.now()}` }).catch(() => undefined);
          },
        });
      } else if (!text) {
        log?.(`slack events: ${e.type} not handled: empty text`);
      } else if ((await slackAssistantSettings(ctx, workspace)).enabled === true) {
        void handleSlackChat(d, workspace, { slackUser, channel, threadTs, text });
      } else {
        log?.(`slack events: ${e.type} not handled: the Slack assistant is off (turn it on under Approvals)`);
        // The request is signed, so the workspace is real: say why nothing happens.
        const token = await resolveSecret(ctx, workspace, 'slack-bot-token');
        if (token) {
          await postMessage(
            { token: token.value, apiUrl: ctx.settings.slackApiUrl },
            { channel, threadTs, text: 'The assistant is turned off for Slack. An admin can turn it on under Approvals, Chat with the assistant in Slack. To start a workflow, use `@azhi run <workflow>`.', dedupeKey: `assistant-off:${channel}:${ts}` },
          ).catch(() => undefined);
        }
      }
      return reply.status(200).send();
    });
    sub.post(SLACK_INTERACTIONS, async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const form = new URLSearchParams(raw);
      let payload: BlockAction;
      try {
        payload = JSON.parse(form.get('payload') ?? '');
      } catch {
        return reply.status(400).send({ error: 'invalid_input', message: 'no Slack payload' });
      }
      // Confirm and Dismiss on an assistant card: the proposal names the workspace, and the stored arguments are what run.
      const press = payload.type === 'block_actions' ? payload.actions?.[0] : undefined;
      if (press?.action_id === 'azhi_assistant_confirm' || press?.action_id === 'azhi_assistant_dismiss') {
        let value: unknown;
        try {
          value = JSON.parse(press.value ?? '');
        } catch {
          return reply.status(200).send();
        }
        const id = z.object({ proposal: z.string() }).safeParse(value);
        if (!id.success) return reply.status(200).send();
        const ws = await proposalWorkspace(ctx, id.data.proposal);
        const secret = ws ? await resolveSecret(ctx, ws, 'slack-signing-secret') : undefined;
        if (!ws || !secret || !verifySlackSignature(secret.value, req.headers['x-slack-request-timestamp'] as string, req.headers['x-slack-signature'] as string, raw)) {
          return reply.status(401).send({ error: 'authorization', message: 'invalid Slack signature' });
        }
        const responseUrl = payload.response_url;
        void decideProposal(d, {
          proposalId: id.data.proposal,
          slackUser: payload.user?.id ?? '',
          decision: press.action_id === 'azhi_assistant_confirm' ? 'confirm' : 'dismiss',
          reply: (note) => respond(responseUrl, { response_type: 'ephemeral', replace_original: false, text: note }),
          replace: (note, blocks) => respond(responseUrl, { replace_original: true, text: note, blocks }),
        });
        return reply.status(200).send();
      }
      const submitted = payload.type === 'view_submission' && payload.view?.callback_id === 'azhi_approval_form';
      const commented = payload.type === 'view_submission' && payload.view?.callback_id === 'azhi_approval_comment';
      const action = payload.actions?.[0];
      let target: { run: string; node: string; response_url?: string };
      try {
        target = z.object({ run: z.string(), node: z.string(), response_url: z.string().optional() }).parse(JSON.parse(submitted || commented ? (payload.view?.private_metadata ?? '') : (action?.value ?? '')));
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

      // A submitted comment: posted under the approval message and kept in the audit log. It decides nothing.
      if (commented) {
        const refuse = (message: string) => reply.status(200).send({ response_action: 'errors', errors: { comment: message } });
        if (!principal) return refuse('Your Slack user is not linked to Azhi Flow. An admin can link it on the Users page.');
        const note = String(payload.view?.state?.values?.comment?.text?.value ?? '').trim();
        if (!note) return refuse('Write a comment first.');
        const row = (await ctx.pool.query(`SELECT channel, ts FROM approval_messages WHERE run_id=$1 AND node_id=$2`, [target.run, target.node])).rows[0] as { channel: string; ts: string | null } | undefined;
        const token = await resolveSecret(ctx, ws, 'slack-bot-token');
        if (!row?.ts || !token) return refuse(`This comment cannot be posted to Slack. Comment in mission control: ${link}`);
        try {
          await postMessage(
            { token: token.value, apiUrl: ctx.settings.slackApiUrl },
            {
              channel: row.channel,
              threadTs: row.ts,
              text: `Comment from <@${slackUser}> on ${target.node}: ${clip(note, 300)}`,
              blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:speech_balloon: *Comment from <@${slackUser}>*
${escapeMrkdwn(clip(note, 2800))}` } }],
              dedupeKey: `approval-comment:${target.run}:${target.node}:${Date.now()}`,
            },
          );
        } catch (e) {
          return refuse((e as Error).message);
        }
        await audit(ctx, ws, principal.userId, 'approval.commented', { run: target.run, node: target.node, via: 'slack', comment: clip(note, 2000) });
        return reply.status(200).send();
      }

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
        await respond(responseUrl, { replace_original: true, text: `Approved by <@${slackUser}> (${target.node} on ${target.run}).`, blocks: decidedBlocks(undefined, `:white_check_mark: *Approved* by <@${slackUser}> with their answers.`) });
        return reply.status(200).send();
      }

      if (!principal) {
        await respond(responseUrl, { response_type: 'ephemeral', replace_original: false, text: `Your Slack user is not linked to Azhi Flow, so this was not recorded. An admin can link it on the Users page, or decide in mission control: ${link}` });
        return reply.status(200).send();
      }
      // Comment opens a modal and decides nothing.
      if (action!.action_id === 'comment') {
        try {
          if (!payload.trigger_id) throw new Error('Slack sent no trigger to open the form');
          const token = await resolveSecret(ctx, ws, 'slack-bot-token');
          if (!token) throw new Error("the secret 'slack-bot-token' is not set");
          const ask = await approvalAsk(ctx, target.run, target.node);
          const intro = [ask?.message || `Comment on ${target.node}`, `<${link}|Open the run in mission control>`].join(String.fromCharCode(10));
          await openView({ token: token.value, apiUrl: ctx.settings.slackApiUrl }, { trigger_id: payload.trigger_id, view: commentModal({ run: target.run, node: target.node, intro }) });
        } catch (e) {
          await respond(responseUrl, { response_type: 'ephemeral', replace_original: false, text: `Not posted: ${(e as Error).message}. You can comment in mission control: ${link}` });
        }
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
          text: `${decision === 'approved' ? 'Approved' : 'Rejected'} by <@${slackUser}> (${target.node} on ${target.run}).`,
          blocks: decidedBlocks(payload.message?.blocks, `${decision === 'approved' ? ':white_check_mark: *Approved*' : ':x: *Rejected*'} by <@${slackUser}>`),
        });
      } catch (e) {
        await say(`Not recorded: ${(e as Error).message}. You can decide in mission control: ${link}`);
      }
      return reply.status(200).send();
    });
  });
}
