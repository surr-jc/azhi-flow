-- Event triggers (src/server/triggers.ts). One row per `trigger.events` entry of a workflow, rewritten when a
-- version is published. Every delivery is recorded with its outcome, including the ones that start no run.
CREATE TABLE triggers (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  workflow_id   text NOT NULL REFERENCES workflows(id),
  source        text NOT NULL,
  events        text[] NOT NULL DEFAULT '{}',
  filter        text,
  input_map     jsonb NOT NULL DEFAULT '{}',
  secret_name   text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX triggers_workflow_idx ON triggers(workflow_id);

CREATE TABLE trigger_deliveries (
  id            bigserial PRIMARY KEY,
  trigger_id    text NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  workspace_id  text NOT NULL,
  delivery_id   text NOT NULL,
  event         text,
  outcome       text NOT NULL,
  reason        text,
  run_id        text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trigger_id, delivery_id)
);
