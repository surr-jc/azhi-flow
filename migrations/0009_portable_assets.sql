-- Reusable, versioned definitions that can be attached to workflows and rendered for providers.
CREATE TABLE portable_assets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mcp', 'agent', 'skill', 'command')),
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  current_version integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, kind, slug)
);
CREATE TABLE portable_asset_versions (
  id text PRIMARY KEY,
  asset_id text NOT NULL REFERENCES portable_assets(id) ON DELETE CASCADE,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  published boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asset_id, version)
);
CREATE TABLE workflow_portable_assets (
  workspace_id text NOT NULL,
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES portable_assets(id),
  asset_version_id text NOT NULL REFERENCES portable_asset_versions(id),
  enabled boolean NOT NULL DEFAULT true,
  bindings jsonb NOT NULL DEFAULT '{}',
  attached_by text,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workflow_id, asset_id)
);
CREATE INDEX portable_assets_workspace_kind_idx ON portable_assets(workspace_id, kind, slug);
CREATE INDEX workflow_portable_assets_workspace_idx ON workflow_portable_assets(workspace_id, workflow_id);
