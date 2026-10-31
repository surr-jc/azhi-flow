-- Remote MCP OAuth by discovery: the resource indicator, issuer and dynamic-registration details the
-- server published, the client's token auth method, and when a pending sign-in expires. No backfill:
-- existing connections keep their hand-entered values and NULL means unavailable.
ALTER TABLE mcp_connections
  ADD COLUMN oauth_resource              text,
  ADD COLUMN oauth_issuer                text,
  ADD COLUMN oauth_registration_endpoint text,
  ADD COLUMN oauth_auth_method           text,
  ADD COLUMN oauth_registration_token    bytea,
  ADD COLUMN oauth_state_expires_at      timestamptz;
