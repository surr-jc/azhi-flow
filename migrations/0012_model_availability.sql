-- Missing availability policies remain unrestricted; no workspace backfill is needed.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
