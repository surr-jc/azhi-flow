-- Mission control, operations (docs/mission-control-plan.md): workspace settings, spend limits
-- and the alert history that drives Slack notifications.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';

-- A spend limit for one workflow, or for the whole workspace when workflow_id is NULL.
CREATE TABLE budgets (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  workflow_id   text REFERENCES workflows(id),
  period        text NOT NULL CHECK (period IN ('day','month')),
  limit_amount  numeric(14, 6) NOT NULL CHECK (limit_amount > 0),
  currency      text NOT NULL DEFAULT 'USD',
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (workspace_id, workflow_id, period)
);

-- Every alert the server has raised: when it was first and last seen, when it cleared, and
-- whether it was sent to Slack. One row per alert key while it stays open.
CREATE TABLE alert_state (
  workspace_id  text NOT NULL,
  key           text NOT NULL,
  level         text NOT NULL,
  kind          text NOT NULL,
  message       text NOT NULL,
  run_id        text,
  workflow      text,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  notified_at   timestamptz,
  notify_error  text,
  PRIMARY KEY (workspace_id, key)
);
CREATE INDEX alert_state_recent ON alert_state (workspace_id, last_seen DESC);
