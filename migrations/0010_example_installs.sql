-- What a marketplace install put in place, so a later update can tell the marketplace's own
-- changes from the edits made locally. `base_files` is the package as installed (path to base64),
-- `template_hash` identifies the marketplace template it came from, `options` holds the install
-- choices (GitHub Enterprise addresses and setting values) so an update fills the template the
-- same way.
CREATE TABLE example_installs (
  workspace_id  text NOT NULL,
  example_id    text NOT NULL,
  workflow_slug text NOT NULL,
  template_hash text NOT NULL,
  base_files    jsonb NOT NULL,
  options       jsonb NOT NULL DEFAULT '{}',
  installed_by  text,
  installed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, example_id)
);
