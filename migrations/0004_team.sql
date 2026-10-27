-- Team management in mission control (docs/mission-control-plan.md, increment 4).
-- A disabled user can no longer sign in or use any of their tokens.
ALTER TABLE users ADD COLUMN disabled_at timestamptz;
-- The Slack user that may decide approvals from Slack buttons on this user's behalf.
ALTER TABLE users ADD COLUMN slack_user_id text;
CREATE UNIQUE INDEX users_slack_user ON users (workspace_id, slack_user_id) WHERE slack_user_id IS NOT NULL;

-- One Slack message per approval request, so a retried activity never posts twice and a
-- button click can be traced back to its run.
CREATE TABLE approval_messages (
  run_id        text NOT NULL,
  node_id       text NOT NULL,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  channel       text NOT NULL,
  ts            text,
  posted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, node_id)
);
