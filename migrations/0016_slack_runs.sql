-- Runs started from a Slack slash command (docs/slack-runs.md). One row ties a run to the Slack
-- thread that follows it: approvals for the run are posted there, and so is its final result, once.
CREATE TABLE slack_run_threads (
  run_id           text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id),
  channel          text NOT NULL,
  thread_ts        text,
  requested_by     text NOT NULL,
  slack_user_id    text NOT NULL,
  result_posted_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slack_run_threads_open ON slack_run_threads (workspace_id) WHERE result_posted_at IS NULL;
