import type { Message } from '../agents/providers.js';
import { runConfirmedAction, trimHistory } from '../assistant/actions.js';
import { assistantTurn } from '../assistant/assistant.js';
import type { AssistantDeps } from '../assistant/tools.js';
import { postMessage, updateMessage } from '../gateway/tools/slack.js';
import { clip, decidedCard, escapeMrkdwn, proposalBlocks, replyBlocks, toMrkdwn } from '../gateway/tools/slack-format.js';
import { newId } from '../lib/ids.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';
import { resolveSecret } from './secrets.js';
import { linkedSlackUser } from './slack-start.js';

/**
 * The assistant in Slack (docs/slack-assistant.md): a DM or an `@azhi` mention starts a conversation
 * that lives in one Slack thread, owned by the person who started it and run with their role. The
 * transcript is kept in `slack_conversations` because Slack has no browser to keep it. An action the
 * assistant proposes is a card with Confirm and Dismiss; the stored arguments run, not anything Slack sends.
 * Message text is untrusted: it only becomes the person's words to the model.
 */
export interface SlackAssistantSettings {
  enabled?: boolean;
}

export async function slackAssistantSettings(ctx: AppContext, workspaceId: string): Promise<SlackAssistantSettings> {
  return ((await ctx.pool.query(`SELECT settings->'slack_assistant' AS s FROM workspaces WHERE id=$1`, [workspaceId])).rows[0]?.s ?? {}) as SlackAssistantSettings;
}

const BUSY_MINUTES = 5;
const MAX_TEXT = 8_000;

/** The text of the last assistant message: what the person is shown. */
function lastReply(messages: Message[]): string {
  const m = [...messages].reverse().find((x) => x.role === 'assistant');
  return (m?.content ?? [])
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n\n')
    .trim();
}

export async function handleSlackChat(d: AssistantDeps, workspace: string, a: { slackUser: string; channel: string; threadTs: string; text: string }): Promise<void> {
  const { ctx, log } = d;
  const token = await resolveSecret(ctx, workspace, 'slack-bot-token');
  if (!token) log?.("slack assistant: the secret 'slack-bot-token' is not set");
  if (!token) return void (await audit(ctx, workspace, null, 'assistant.slack_failed', { error: "the secret 'slack-bot-token' is not set", channel: a.channel }));
  const cfg = { token: token.value, apiUrl: ctx.settings.slackApiUrl };
  const post = (text: string, blocks?: unknown) =>
    postMessage(cfg, { channel: a.channel, threadTs: a.threadTs, text, blocks, dedupeKey: `assistant:${a.channel}:${a.threadTs}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` });

  let placeholder: { channel: string; ts: string } | undefined;
  let conversation: string | undefined;
  let owner: string | undefined;
  try {
    const linked = await linkedSlackUser(ctx, workspace, a.slackUser);
    if (!linked) return void (await post('Your Slack user is not linked to Azhi Flow. An admin can link it on the Users page.'));
    owner = linked.id;

    await ctx.pool.query(
      `INSERT INTO slack_conversations(id, workspace_id, channel, thread_ts, owner_user_id, slack_user_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id, channel, thread_ts) DO NOTHING`,
      [newId('scv'), workspace, a.channel, a.threadTs, linked.id, a.slackUser],
    );
    const conv = (await ctx.pool.query(`SELECT id, slack_user_id FROM slack_conversations WHERE workspace_id=$1 AND channel=$2 AND thread_ts=$3`, [workspace, a.channel, a.threadTs])).rows[0] as { id: string; slack_user_id: string };
    if (conv.slack_user_id !== a.slackUser) return void (await post('This conversation belongs to someone else. Start your own thread to talk to me.'));

    // One turn at a time per thread; a turn that died frees the thread after BUSY_MINUTES.
    const claimed = (
      await ctx.pool.query(`UPDATE slack_conversations SET busy_until = now() + make_interval(mins => $2) WHERE id=$1 AND (busy_until IS NULL OR busy_until < now()) RETURNING messages`, [conv.id, BUSY_MINUTES])
    ).rows[0] as { messages: Message[] } | undefined;
    if (!claimed) return void (await post('Still working on your last message. I will reply here when it is done.'));
    conversation = conv.id;

    placeholder = await post('Thinking…');
    const principal = { kind: 'user', workspaceId: workspace, userId: linked.id, role: linked.role } as const;
    const r = await assistantTurn(d, principal, { messages: claimed.messages, text: clip(a.text, MAX_TEXT), surface: 'slack' });
    const proposal = r.event.kind === 'action_proposal' ? r.event.proposal : undefined;
    const text = lastReply(r.messages) || (proposal ? 'This needs your confirmation:' : '(no reply)');
    await updateMessage(cfg, { ...placeholder, text: clip(toMrkdwn(text), 3000), blocks: replyBlocks(text) });

    // Saved before the card goes out, so a click that arrives at once finds the transcript.
    await ctx.pool.query(`UPDATE slack_conversations SET messages=$2::jsonb, updated_at=now() WHERE id=$1`, [conv.id, JSON.stringify(trimHistory(r.messages))]);
    if (proposal) {
      const id = newId('sap');
      await ctx.pool.query(`INSERT INTO slack_assistant_proposals(id, conversation_id, tool_use_id, tool, args, title, danger, channel) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, [
        id,
        conv.id,
        proposal.tool_use_id,
        proposal.tool,
        JSON.stringify(proposal.args),
        proposal.title,
        proposal.danger === true,
        a.channel,
      ]);
      const card = await post(clip(proposal.title, 200), proposalBlocks({ id, title: proposal.title, detail: proposal.detail, danger: proposal.danger }));
      await ctx.pool.query(`UPDATE slack_assistant_proposals SET ts=$2 WHERE id=$1`, [id, card.ts]);
    }
    await audit(ctx, workspace, linked.id, 'assistant.turn', { via: 'slack', provider: r.provider, model: r.model, event: r.event.kind, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens });
  } catch (e) {
    log?.(`slack assistant: turn failed: ${clip((e as Error).message, 200)}`);
    const note = `Sorry, I could not answer that: ${escapeMrkdwn(clip((e as Error).message, 300))}`;
    if (placeholder) await updateMessage(cfg, { ...placeholder, text: note }).catch(() => undefined);
    else await post(note).catch(() => undefined);
    await audit(ctx, workspace, owner ?? null, 'assistant.slack_failed', { error: clip((e as Error).message, 500), channel: a.channel });
  } finally {
    if (conversation) await ctx.pool.query(`UPDATE slack_conversations SET busy_until=NULL WHERE id=$1`, [conversation]).catch(() => undefined);
  }
}

/** The workspace a card's button belongs to, so the click's signature can be checked with its secret. */
export async function proposalWorkspace(ctx: AppContext, proposalId: string): Promise<string | undefined> {
  return (await ctx.pool.query(`SELECT c.workspace_id FROM slack_assistant_proposals p JOIN slack_conversations c ON c.id = p.conversation_id WHERE p.id=$1`, [proposalId])).rows[0]?.workspace_id as string | undefined;
}

/** The note the web adds when a card is decided, so the model learns the outcome in the next message. */
async function addNote(ctx: AppContext, conversationId: string, text: string) {
  const messages = ((await ctx.pool.query(`SELECT messages FROM slack_conversations WHERE id=$1`, [conversationId])).rows[0]?.messages ?? []) as Message[];
  const last = messages.at(-1);
  if (last?.role === 'user') last.content.push({ type: 'text', text });
  else messages.push({ role: 'user', content: [{ type: 'text', text }] });
  await ctx.pool.query(`UPDATE slack_conversations SET messages=$2::jsonb, updated_at=now() WHERE id=$1`, [conversationId, JSON.stringify(messages)]);
}

/**
 * A press of Confirm or Dismiss. Only the conversation's owner, still linked, may decide; the first
 * press wins. `reply` shows something only to the person who pressed, `replace` swaps the card.
 */
export async function decideProposal(
  d: AssistantDeps,
  a: { proposalId: string; slackUser: string; decision: 'confirm' | 'dismiss'; reply: (text: string) => Promise<unknown>; replace: (text: string, blocks: unknown) => Promise<unknown> },
): Promise<void> {
  const { ctx } = d;
  try {
    const row = (
      await ctx.pool.query(
        `SELECT p.id, p.conversation_id, p.tool, p.args, p.title, c.workspace_id, c.owner_user_id, c.slack_user_id
         FROM slack_assistant_proposals p JOIN slack_conversations c ON c.id = p.conversation_id WHERE p.id=$1`,
        [a.proposalId],
      )
    ).rows[0] as { id: string; conversation_id: string; tool: string; args: Record<string, unknown>; title: string; workspace_id: string; owner_user_id: string; slack_user_id: string } | undefined;
    if (!row) return void (await a.reply('This action is no longer available.'));
    const linked = await linkedSlackUser(ctx, row.workspace_id, a.slackUser);
    if (a.slackUser !== row.slack_user_id || !linked || linked.id !== row.owner_user_id) return void (await a.reply('Only the person who started this conversation can decide this action.'));

    const status = a.decision === 'confirm' ? 'confirmed' : 'dismissed';
    const claimed = (await ctx.pool.query(`UPDATE slack_assistant_proposals SET status=$2, decided_at=now() WHERE id=$1 AND status='pending' RETURNING id`, [row.id, status])).rowCount;
    if (!claimed) return void (await a.reply('This action was already decided.'));

    if (a.decision === 'dismiss') {
      await a.replace(`Dismissed: ${row.title}`, decidedCard(row.title, ':no_entry_sign: Dismissed'));
      return await addNote(ctx, row.conversation_id, `(I dismissed "${row.title}"; it did not run.)`);
    }
    try {
      const principal = { kind: 'user', workspaceId: row.workspace_id, userId: linked.id, role: linked.role } as const;
      const result = await runConfirmedAction(d, principal, row.tool, row.args, 'slack');
      const shown = JSON.stringify(result) ?? 'null';
      await a.replace(`Confirmed: ${row.title}`, decidedCard(row.title, `:white_check_mark: Confirmed\n\`\`\`${escapeMrkdwn(clip(shown, 1500))}\`\`\``));
      await addNote(ctx, row.conversation_id, `(I confirmed "${row.title}". Result: ${shown})`);
    } catch (e) {
      const message = (e as Error).message;
      await ctx.pool.query(`UPDATE slack_assistant_proposals SET status='failed' WHERE id=$1`, [row.id]);
      await a.replace(`Failed: ${row.title}`, decidedCard(row.title, `:x: Failed: ${escapeMrkdwn(clip(message, 500))}`));
      await addNote(ctx, row.conversation_id, `(I confirmed "${row.title}" but it failed: ${message})`);
    }
  } catch (e) {
    await a.reply(`Not recorded: ${(e as Error).message}`).catch(() => undefined);
  }
}
