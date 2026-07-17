-- The planner + autonomy + progress upgrade. Additive; safe on a live DB:
--   wrangler d1 execute grabber --remote --file migrations/004_planner.sql
--
-- SQLite ALTER can't add columns conditionally; if a column already exists the
-- statement errors — that's fine, run the ones you still need. On a DB created before
-- this migration, all of these are new.

-- The persistent roadmap.
CREATE TABLE IF NOT EXISTS milestones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     INTEGER NOT NULL REFERENCES goals(id),
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  done_when   TEXT,
  target_date TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_milestones_goal ON milestones(goal_id);

-- Goals gain a cached progress value.
ALTER TABLE goals ADD COLUMN progress REAL NOT NULL DEFAULT 0;

-- Quests aim at a milestone.
ALTER TABLE quests ADD COLUMN milestone_id INTEGER REFERENCES milestones(id);

-- Activity distinguishes owner vs autonomous, and carries the "why".
ALTER TABLE activity ADD COLUMN actor TEXT NOT NULL DEFAULT 'system';
ALTER TABLE activity ADD COLUMN reasoning TEXT;
