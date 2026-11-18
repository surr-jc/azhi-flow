-- Chatting with the assistant from Slack (docs/slack-assistant.md). A conversation is one Slack thread,
-- owned by the person who started it; the transcript is kept here because Slack has no browser to keep it.
CREATE TABLE slack_conversations (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  channel       text NOT NULL,
  thread_ts     text NOT NULL,
  owner_user_id text NOT NULL,
  slack_user_id text NOT NULL,
  messages      jsonb NOT NULL DEFAULT '[]',
  busy_until    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel, thread_ts)
);

-- An action the assistant proposed in a thread, run only when its owner presses Confirm.
CREATE TABLE slack_assistant_proposals (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES slack_conversations(id) ON DELETE CASCADE,
  tool_use_id     text NOT NULL,
  tool            text NOT NULL,
  args            jsonb NOT NULL DEFAULT '{}',
  title           text NOT NULL,
  danger          boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','dismissed','failed')),
  channel         text NOT NULL,
  ts              text,
  decided_at      timestamptz
);
CREATE INDEX slack_assistant_proposals_conversation ON slack_assistant_proposals (conversation_id);

-- Events already seen, so a resent delivery is acknowledged once. Pruned after a day.
CREATE TABLE slack_events (
  event_id     text PRIMARY KEY,
  workspace_id text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slack_events_received ON slack_events (received_at);
