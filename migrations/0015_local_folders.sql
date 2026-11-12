-- Local folders (src/server/local-folders.ts). A workflow names one (workspace.local); the path is
-- on the worker's machine and is set by an admin, never taken from a workflow, ticket or pull request.
-- A run's git worktree of a folder is recorded so the run page can show where it is.
CREATE TABLE IF NOT EXISTS local_folders (
  workspace_id text NOT NULL,
  name text NOT NULL,
  path text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS run_worktrees (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  folder text NOT NULL,
  path text NOT NULL,
  branch text NOT NULL,
  base_sha text NOT NULL,
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (run_id, folder)
);
