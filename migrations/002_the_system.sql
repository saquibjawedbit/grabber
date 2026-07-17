-- The System: goals + quests. Apply with:
--   wrangler d1 execute grabber --remote --file migrations/002_the_system.sql
--
-- This migration is ADDITIVE and safe to run on a live DB — it only creates the two
-- new tables. The old opportunity-engine tables (postings, idf, alerts, outcomes,
-- drafts, calibration) are now inert (no code writes them) but are NOT dropped here,
-- so no data is lost and the dashboard keeps working. A later cleanup migration will
-- drop them once the dashboard has been reshaped around The System.

CREATE TABLE IF NOT EXISTS goals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  why        TEXT,
  target     TEXT,
  deadline   TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id       INTEGER REFERENCES goals(id),
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'daily',
  status        TEXT NOT NULL DEFAULT 'issued',
  xp            INTEGER NOT NULL DEFAULT 10,
  due_at        TEXT,
  issued_at     TEXT NOT NULL,
  resolved_at   TEXT,
  tg_message_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_quests_issued ON quests(issued_at);
CREATE INDEX IF NOT EXISTS idx_quests_goal ON quests(goal_id);
