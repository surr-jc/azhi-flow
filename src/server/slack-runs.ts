import { postMessage } from '../gateway/tools/slack.js';
import { clip, escapeMrkdwn, runLink } from '../gateway/tools/slack-format.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { TERMINAL_STATES } from '../runtime/types.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';
import { resolveSecret } from './secrets.js';

/**
 * Runs started from Slack (docs/slack-runs.md). The slash command text is untrusted data: it only
 * picks a workflow by exact slug from the workspace's allowlist and supplies string inputs.
 */
export interface SlackCommandSettings {
  enabled?: boolean;
  /** Workflow slugs that Slack may start. Empty means none. */
  workflows?: string[];
  /** Where the run's thread is created; the channel the command was typed in when unset. */
  channel?: string;
}

const USAGE = 'Usage: `/azhi run <workflow> key=value ...`';
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_PAIRS = 20;
const MAX_VALUE = 1000;

export async function slackCommandSettings(ctx: AppContext, workspaceId: string): Promise<SlackCommandSettings> {
  return ((await ctx.pool.query(`SELECT settings->'slack_commands' AS s FROM workspaces WHERE id=$1`, [workspaceId])).rows[0]?.s ?? {}) as SlackCommandSettings;
}

/** Splits on whitespace, keeping double-quoted stretches together (`topic="a b"`). */
function tokens(text: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"]+|"[^"]*")+/g;
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

/** `run <workflow> key=value ...` into a workflow slug and string inputs. Never builds anything executable. */
export function parseRunCommand(text: string): { workflow: string; inputs: Record<string, string> } {
  const [verb, workflow, ...rest] = tokens(text.trim());
  if (verb !== 'run') throw new AzhiError(ErrorClass.invalidInput, USAGE);
  if (!workflow || !SLUG.test(workflow)) throw new AzhiError(ErrorClass.invalidInput, `Name a workflow by its slug. ${USAGE}`);
  if (rest.length > MAX_PAIRS) throw new AzhiError(ErrorClass.invalidInput, `At most ${MAX_PAIRS} inputs.`);
  const inputs: Record<string, string> = {};
  for (const pair of rest) {
    const eq = pair.indexOf('=');
    const key = eq > 0 ? pair.slice(0, eq) : '';
    if (!KEY.test(key)) throw new AzhiError(ErrorClass.invalidInput, `"${clip(pair, 40)}" is not key=value. ${USAGE}`);
    let value = pair.slice(eq + 1);
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.length > MAX_VALUE) throw new AzhiError(ErrorClass.invalidInput, `Input ${key} is longer than ${MAX_VALUE} characters.`);
    if (Object.hasOwn(inputs, key)) throw new AzhiError(ErrorClass.invalidInput, `Input ${key} is given twice.`);
    inputs[key] = value;
  }
  return { workflow, inputs };
}

/** The text of an `@azhi ...` mention without the leading `<@U...>` mention(s), ready for `parseRunCommand`. */
export const stripMentions = (text: string) => text.replace(/^(\s*<@[A-Z0-9]+(\|[^>]*)?>)+\s*/, '').trim();

export const isAllowed =(s: SlackCommandSettings, slug: string) => s.enabled === true && (s.workflows ?? []).includes(slug);

/** One line for the thread: unknown values read "unavailable", never a guess. */
export function resultText(r: { workflow: string; state: string; started_at?: string | Date | null; ended_at?: string | Date | null; error?: { message?: unknown } | null }, link: string): string {
  const icon = r.state === 'succeeded' ? ':white_check_mark:' : r.state === 'cancelled' ? ':no_entry_sign:' : ':x:';
  const start = r.started_at ? new Date(r.started_at).getTime() : NaN;
  const end = r.ended_at ? new Date(r.ended_at).getTime() : NaN;
  const duration = Number.isFinite(start) && Number.isFinite(end) && end >= start ? `${Math.round((end - start) / 1000)}s` : 'unavailable';
  const message = typeof r.error?.message === 'string' && r.error.message ? `\nError: ${escapeMrkdwn(clip(r.error.message, 500))}` : '';
  return `${icon} *${escapeMrkdwn(r.workflow)}* ${r.state.replace('_', ' ')} (duration: ${duration})${message}\n<${link}|Open in mission control>`;
}

/** Thread to post into for a run, when it was started from Slack and its root message exists. */
export async function threadFor(ctx: AppContext, runId: string): Promise<{ channel: string; thread_ts: string } | undefined> {
  const row = (await ctx.pool.query(`SELECT channel, thread_ts FROM slack_run_threads WHERE run_id=$1`, [runId])).rows[0] as { channel: string; thread_ts: string | null } | undefined;
  return row?.thread_ts ? { channel: row.channel, thread_ts: row.thread_ts } : undefined;
}

/** Posts the final result of each finished Slack-started run into its thread, once. */
export async function postRunResults(ctx: AppContext, log: (m: string) => void = () => {}) {
  const due = (
    await ctx.pool.query(
      `SELECT t.run_id, t.workspace_id, t.channel, t.thread_ts, r.state, r.started_at, r.ended_at, r.error, w.slug AS workflow
       FROM slack_run_threads t JOIN runs r ON r.id = t.run_id JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
       WHERE t.result_posted_at IS NULL AND t.thread_ts IS NOT NULL AND r.state = ANY($1) ORDER BY r.ended_at LIMIT 20`,
      [TERMINAL_STATES],
    )
  ).rows;
  for (const r of due) {
    try {
      const token = await resolveSecret(ctx, r.workspace_id, 'slack-bot-token');
      if (!token) throw new Error("the secret 'slack-bot-token' is not set");
      const link = runLink(ctx.settings.publicUrl, r.run_id);
      await postMessage({ token: token.value, apiUrl: ctx.settings.slackApiUrl }, { channel: r.channel, threadTs: r.thread_ts, text: resultText(r, link), dedupeKey: `run-result:${r.run_id}` });
      await ctx.pool.query(`UPDATE slack_run_threads SET result_posted_at=now() WHERE run_id=$1`, [r.run_id]);
    } catch (e) {
      await audit(ctx, r.workspace_id, null, 'slack.run_result_failed', { run: r.run_id, error: (e as Error).message });
      log(`slack runs: could not post the result of ${r.run_id}: ${(e as Error).message}`);
    }
  }
}

export function startSlackRunNotifier(ctx: AppContext, log: (m: string) => void = () => {}, intervalMs = 5000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await postRunResults(ctx, log);
      // Seen event ids only need to outlive Slack's retries.
      await ctx.pool.query(`DELETE FROM slack_events WHERE received_at < now() - interval '1 day'`);
    } catch (err) {
      log(`slack runs: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return { tick, stop: () => clearInterval(timer) };
}
