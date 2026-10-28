-- OpenCode keeps MCP servers in a global config (all projects) and a project config (one repository).
-- Library assets get the same split: global = every workflow in the workspace, project = bound to one workflow.
ALTER TABLE portable_assets ADD COLUMN scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'project'));
ALTER TABLE portable_assets ADD COLUMN project_workflow text;
