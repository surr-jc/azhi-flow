import { requireRole } from '../api/auth.js';
import type { Role } from '../db/schema.js';
import { postMessage } from '../gateway/tools/slack.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';
import { resolveSecret } from './secrets.js';
import { isAllowed, parseRunCommand, slackCommandSettings } from './slack-runs.js';
import { startRun } from './start-run.js';

/** The enabled Azhi Flow user whose Slack user id this is, if the Users page links one. */
export async function linkedSlackUser(ctx: AppContext, workspace: string, slackUser: string) {
  return (await ctx.pool.query(`SELECT id, role FROM users WHERE workspace_id=$1 AND slack_user_id=$2 AND disabled_at IS NULL`, [workspace, slackUser])).rows[0] as { id: string; role: Role } | undefined;
}

/**
 * Starts a run for a Slack request, from the `/azhi` slash command and from an `@azhi` mention alike:
 * the Slack user must be linked to an enabled Azhi Flow user with the operator role, the workflow must be
 * on the workspace's allowlist, and the run starts through the same path as `POST /v1/runs`.
 *
 * `threadTs` is set for a mention: the run follows that message's thread. Without it (a slash command has
 * no message) a message is posted to open the thread. `say` delivers a refusal or a problem to the person.
 */
export async function startFromSlack(
  ctx: AppContext,
  workspace: string,
  a: { slackUser: string; text: string; channel: string; threadTs?: string; interpreterBuild: string; say: (text: string) => Promise<unknown> },
): Promise<void> {
  try {
    const settings = await slackCommandSettings(ctx, workspace);
    const linked = await linkedSlackUser(ctx, workspace, a.slackUser);
    if (!linked) return void (await a.say('Your Slack user is not linked to Azhi Flow, so nothing was started. An admin can link it on the Users page.'));
    const principal = { kind: 'user', workspaceId: workspace, userId: linked.id, role: linked.role } as const;
    requireRole(principal, 'operator');
    const { workflow, inputs } = parseRunCommand(a.text);
    if (!isAllowed(settings, workflow)) {
      const allowed = (settings.workflows ?? []).map((s) => `\`${s}\``).join(', ') || 'none';
      return void (await a.say(`\`${workflow}\` cannot be started from Slack. Allowed: ${allowed}.`));
    }
    const { runId } = await startRun(ctx, principal, { version: `${workflow}@latest`, inputs }, a.interpreterBuild);
    const link = `${ctx.settings.publicUrl.replace(/\/$/, '')}/ui/runs/${encodeURIComponent(runId)}`;
    // A mention is answered in its own thread; a slash command opens one in the configured or invoking channel.
    const channel = a.threadTs ? a.channel : (settings.channel ?? a.channel);
    await ctx.pool.query(`INSERT INTO slack_run_threads(run_id, workspace_id, channel, thread_ts, requested_by, slack_user_id) VALUES ($1,$2,$3,$4,$5,$6)`, [runId, workspace, channel, a.threadTs ?? null, linked.id, a.slackUser]);
    await audit(ctx, workspace, linked.id, 'slack.run_started', { run: runId, workflow, slack_user: a.slackUser, via: a.threadTs ? 'mention' : 'command' });
    try {
      const token = await resolveSecret(ctx, workspace, 'slack-bot-token');
      if (!token) throw new Error("the secret 'slack-bot-token' is not set");
      const posted = await postMessage(
        { token: token.value, apiUrl: ctx.settings.slackApiUrl },
        { channel, ...(a.threadTs ? { threadTs: a.threadTs } : {}), text: `<@${a.slackUser}> started ${workflow} (${runId}). Approvals and the result will appear in this thread.\n<${link}|Open in mission control>`, dedupeKey: `run-start:${runId}` },
      );
      if (!a.threadTs) await ctx.pool.query(`UPDATE slack_run_threads SET channel=$2, thread_ts=$3 WHERE run_id=$1`, [runId, posted.channel, posted.ts]);
    } catch (e) {
      await a.say(`Started ${runId}, but it could not be announced in Slack: ${(e as Error).message}. Follow it in mission control: ${link}`);
    }
  } catch (e) {
    await a.say(`Not started: ${(e as Error).message}`);
  }
}
