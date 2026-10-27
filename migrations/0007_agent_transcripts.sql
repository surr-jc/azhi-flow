-- Agent transcripts: each agent step's prompts, model text and reasoning, and tool calls with
-- their inputs and results, redacted. Entries stream in while the step runs; an entry id seen
-- again replaces the earlier entry and gets a new version, which is the cursor readers follow.
CREATE SEQUENCE agent_transcripts_version;
CREATE TABLE agent_transcripts (
  ord           bigserial,
  version       bigint NOT NULL DEFAULT nextval('agent_transcripts_version'),
  workspace_id  text NOT NULL,
  run_id        text NOT NULL REFERENCES runs(id),
  node_id       text NOT NULL,
  attempt       integer NOT NULL DEFAULT 1,
  entry_id      text NOT NULL,
  kind          text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, node_id, attempt, entry_id)
);
CREATE INDEX agent_transcripts_version_idx ON agent_transcripts (run_id, version);
