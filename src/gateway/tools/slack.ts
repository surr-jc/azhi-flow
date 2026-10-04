/**
 * Slack Web API calls used by the `slack.post-message` tool. Slack posting is treated as
 * write-dedupable: every post carries the ledger action ID in message metadata, and before any
 * retry the gateway reads channel history looking for that ID.
 */
export interface SlackConfig {
  token: string;
  apiUrl?: string;
}

const DEDUPE_EVENT = 'azhi_action';

async function call(cfg: SlackConfig, method: string, body: Record<string, unknown>) {
  const res = await fetch(`${cfg.apiUrl ?? 'https://slack.com/api'}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw Object.assign(new Error('slack rate limited'), { retryable: true });
  const text = await res.text();
  let json: { ok: boolean; error?: string; [k: string]: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    // Not a Slack API answer (a proxy or gateway error): the outcome of a post is unknown.
    throw new Error(`slack ${method}: HTTP ${res.status}, non-JSON response: ${text.slice(0, 80)}`);
  }
  if (!json.ok) throw Object.assign(new Error(`slack ${method}: ${json.error}`), { slackError: json.error });
  return json;
}

export async function postMessage(
  cfg: SlackConfig,
  args: { channel: string; text: string; blocks?: unknown; dedupeKey: string },
): Promise<{ channel: string; ts: string }> {
  const r = await call(cfg, 'chat.postMessage', {
    channel: args.channel,
    text: args.text,
    blocks: args.blocks,
    unfurl_links: false,
    metadata: { event_type: DEDUPE_EVENT, event_payload: { action_id: args.dedupeKey } },
  });
  return { channel: String(r.channel), ts: String(r.ts) };
}

/** Looks back through recent channel history for a message carrying this dedupe key. */
export async function findByDedupeKey(
  cfg: SlackConfig,
  args: { channel: string; dedupeKey: string; oldest?: number },
): Promise<{ channel: string; ts: string } | null> {
  const r = await call(cfg, 'conversations.history', {
    channel: args.channel,
    oldest: args.oldest ? String(args.oldest) : undefined,
    include_all_metadata: true,
    limit: 200,
  });
  const messages = (r.messages ?? []) as Array<{ ts: string; metadata?: { event_type: string; event_payload?: { action_id?: string } } }>;
  const hit = messages.find((m) => m.metadata?.event_type === DEDUPE_EVENT && m.metadata.event_payload?.action_id === args.dedupeKey);
  return hit ? { channel: args.channel, ts: hit.ts } : null;
}
