-- Phase 2: package signing, approvals, agent usage and context manifests, knowledge datasets.

-- ADR-11: a workspace root key certifies per-publisher keys.
CREATE TABLE workspace_keys (
  workspace_id  text PRIMARY KEY REFERENCES workspaces(id),
  public_key    text NOT NULL,
  private_key   bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publisher_keys (
  key_id        text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  user_id       text NOT NULL REFERENCES users(id),
  public_key    text NOT NULL,
  certificate   jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE TABLE approvals (
  run_id        text NOT NULL REFERENCES runs(id),
  node_id       text NOT NULL,
  workspace_id  text NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('approved','rejected','expired')),
  decided_by    text,
  data          jsonb NOT NULL DEFAULT '{}',
  decided_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, node_id)
);

-- Usage: unknown is NULL, never zero (spec section 11).
CREATE TABLE usage_records (
  seq                bigserial PRIMARY KEY,
  workspace_id       text NOT NULL,
  run_id             text NOT NULL REFERENCES runs(id),
  node_id            text NOT NULL,
  attempt            int NOT NULL,
  turn               int NOT NULL,
  executor           text NOT NULL,
  provider           text,
  model              text,
  input_tokens       int,
  output_tokens      int,
  cache_read_tokens  int,
  cache_write_tokens int,
  reasoning_tokens   int,
  cost               numeric(14, 6),
  currency           text,
  cost_label         text NOT NULL CHECK (cost_label IN ('reported','estimated','unavailable')),
  pricing_revision   text,
  at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_id, attempt, turn)
);

-- What the agent saw, per attempt and turn.
CREATE TABLE context_manifests (
  workspace_id  text NOT NULL,
  run_id        text NOT NULL REFERENCES runs(id),
  node_id       text NOT NULL,
  attempt       int NOT NULL,
  turn          int NOT NULL,
  tainted       boolean NOT NULL DEFAULT false,
  items         jsonb NOT NULL,
  total_tokens  int,
  token_source  text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, node_id, attempt, turn)
);

CREATE TABLE datasets (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  trusted       boolean NOT NULL DEFAULT true,
  acl           jsonb NOT NULL DEFAULT '{"roles":["viewer"]}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE dataset_documents (
  dataset_id    text NOT NULL REFERENCES datasets(id),
  path          text NOT NULL,
  content_hash  text NOT NULL,
  artifact      text NOT NULL,
  media_type    text NOT NULL,
  revoked       boolean NOT NULL DEFAULT false,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, path)
);

-- An index revision is immutable once published.
CREATE TABLE dataset_revisions (
  dataset_id     text NOT NULL REFERENCES datasets(id),
  revision       int NOT NULL,
  parser         text NOT NULL,
  chunker        text NOT NULL,
  embedder       text NOT NULL,
  dimensions     int NOT NULL,
  documents      int NOT NULL,
  chunks         int NOT NULL,
  published_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, revision)
);

CREATE TABLE dataset_tags (
  dataset_id  text NOT NULL REFERENCES datasets(id),
  tag         text NOT NULL,
  revision    int NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, tag)
);

CREATE TABLE chunks (
  id            text PRIMARY KEY,
  dataset_id    text NOT NULL,
  revision      int NOT NULL,
  path          text NOT NULL,
  content_hash  text NOT NULL,
  heading       text,
  text          text NOT NULL,
  start_offset  int NOT NULL,
  end_offset    int NOT NULL,
  tsv           tsvector NOT NULL,
  embedding     vector,
  FOREIGN KEY (dataset_id, revision) REFERENCES dataset_revisions(dataset_id, revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX chunks_rev ON chunks (dataset_id, revision);
CREATE INDEX chunks_tsv ON chunks USING gin (tsv);
