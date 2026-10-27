-- Per-repository run limit (src/server/repo-slots.ts). A run records the repositories its agent
-- steps check out; `admitted_at` marks the runs the dispatcher let start, which hold a slot while
-- they are open (runs already open when this lands were started without a limit and hold none).
-- An outbox entry held back for a slot keeps `held_at` and is retried in order.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS repos text[] NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS admitted_at timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS held_at timestamptz;
