-- The System's work log — powers the dashboard "what I'm doing to hit your goals" feed.
-- Additive and safe on a live DB:
--   wrangler d1 execute grabber --remote --file migrations/003_activity.sql

CREATE TABLE IF NOT EXISTS activity (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  kind     TEXT NOT NULL,
  summary  TEXT NOT NULL,
  detail   TEXT,
  goal_id  INTEGER,
  quest_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);
