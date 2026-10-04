-- Azhi Flow core schema. Every table is workspace-scoped (spec section 10).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE workspaces (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'UTC',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  email         text,
  display_name  text,
  oidc_issuer   text,
  oidc_subject  text,
  role          text NOT NULL CHECK (role IN ('owner','admin','author','operator','viewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, oidc_issuer, oidc_subject)
);

CREATE TABLE api_tokens (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  user_id       text NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE TABLE secrets (
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  version       int NOT NULL,
  ciphertext    bytea NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, name, version)
);

CREATE TABLE artifacts (
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  hash          text NOT NULL,
  size          bigint NOT NULL,
  media_type    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, hash)
);

CREATE TABLE tools (
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  tool_id       text NOT NULL,
  version       int NOT NULL,
  revision      int NOT NULL,
  spec          jsonb NOT NULL,
  spec_hash     text NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, tool_id, version, revision)
);

CREATE TABLE workflows (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  slug          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE workflow_versions (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  workflow_id   text NOT NULL REFERENCES workflows(id),
  version       int NOT NULL,
  package_hash  text NOT NULL,
  manifest      jsonb NOT NULL,
  definition    jsonb NOT NULL,
  plan          jsonb NOT NULL,
  draft         boolean NOT NULL DEFAULT true,
  signature     jsonb,
  published_by  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version),
  UNIQUE (workflow_id, package_hash)
);

CREATE TABLE schedules (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL REFERENCES workspaces(id),
  workflow_id         text NOT NULL REFERENCES workflows(id),
  cron                text NOT NULL,
  timezone            text NOT NULL,
  inputs              jsonb NOT NULL DEFAULT '{}',
  enabled             boolean NOT NULL DEFAULT true,
  next_occurrence_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id                   text PRIMARY KEY,
  workspace_id         text NOT NULL REFERENCES workspaces(id),
  workflow_version_id  text NOT NULL REFERENCES workflow_versions(id),
  state                text NOT NULL CHECK (state IN ('queued','running','waiting','cancelling','succeeded','delivery_failed','failed','cancelled','expired')),
  flags                jsonb NOT NULL DEFAULT '{}',
  inputs               jsonb NOT NULL DEFAULT '{}',
  snapshot             jsonb NOT NULL,
  interpreter_build    text,
  trigger              text NOT NULL,
  occurrence_id        text UNIQUE,
  parent_run_id        text REFERENCES runs(id),
  parent_node_id       text,
  test                 boolean NOT NULL DEFAULT false,
  error                jsonb,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  ended_at             timestamptz
);
CREATE INDEX runs_workspace_created ON runs (workspace_id, created_at DESC);
CREATE INDEX runs_open ON runs (interpreter_build) WHERE state IN ('queued','running','waiting','cancelling');

CREATE TABLE run_events (
  seq           bigserial PRIMARY KEY,
  workspace_id  text NOT NULL,
  run_id        text NOT NULL REFERENCES runs(id),
  at            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL,
  node_id       text,
  data          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX run_events_run ON run_events (run_id, seq);

CREATE TABLE node_attempts (
  workspace_id  text NOT NULL,
  run_id        text NOT NULL REFERENCES runs(id),
  node_id       text NOT NULL,
  attempt       int NOT NULL,
  state         text NOT NULL CHECK (state IN ('running','succeeded','failed','skipped','cancelled')),
  worker_id     text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  error         jsonb,
  output        jsonb,
  observations  jsonb,
  PRIMARY KEY (run_id, node_id, attempt)
);

-- The action ledger (spec section 8): one row per logical external write, across attempts.
CREATE TABLE actions (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL,
  run_id           text NOT NULL REFERENCES runs(id),
  node_id          text NOT NULL,
  tool             text NOT NULL,
  effect           text NOT NULL CHECK (effect IN ('write-idempotent','write-dedupable','write-unsafe')),
  operation_hash   text NOT NULL,
  idempotency_key  text NOT NULL,
  target           jsonb NOT NULL DEFAULT '{}',
  state            text NOT NULL CHECK (state IN ('planned','dispatched','confirmed','failed','outcome_unknown')),
  fence            int NOT NULL,
  receipt          jsonb,
  error            jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actions_run ON actions (run_id);

CREATE TABLE action_transitions (
  seq        bigserial PRIMARY KEY,
  action_id  text NOT NULL REFERENCES actions(id),
  state      text NOT NULL,
  fence      int NOT NULL,
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workers (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id),
  name            text NOT NULL,
  owner_id        text,
  task_queue      text NOT NULL,
  capabilities    jsonb NOT NULL DEFAULT '{}',
  trust_policy    jsonb NOT NULL DEFAULT '{"kind":"workspace-publishers"}',
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_heartbeat  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interpreter_builds (
  build_id    text PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);

-- Outbox: run creation and delivery are committed with the row that caused them,
-- then dispatched to Temporal by the server.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  workspace_id  text NOT NULL,
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_pending ON outbox (id) WHERE processed_at IS NULL;

CREATE TABLE audit_events (
  seq           bigserial PRIMARY KEY,
  workspace_id  text NOT NULL,
  actor         text,
  kind          text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL DEFAULT now()
);
