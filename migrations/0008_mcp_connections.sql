-- Shared remote MCP connections. OAuth material is encrypted in application code and never
-- returned from the API; registered tools reference a connection by id.
CREATE TABLE mcp_connections (
  id                    text PRIMARY KEY,
  workspace_id          text NOT NULL,
  name                  text NOT NULL,
  url                   text NOT NULL,
  auth_kind             text NOT NULL,
  oauth_authorization_url text,
  oauth_token_url       text,
  oauth_client_id       text,
  oauth_client_secret   bytea,
  oauth_scopes          text,
  oauth_tokens          bytea,
  oauth_state           text,
  oauth_verifier        bytea,
  status                text NOT NULL DEFAULT 'ready',
  last_error            text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);
CREATE INDEX mcp_connections_workspace_idx ON mcp_connections(workspace_id, name);
