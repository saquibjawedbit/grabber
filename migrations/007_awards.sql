-- 007: awards — recognition for sustained effort, not just per-quest XP.
-- Streaks, quest totals, hunter-rank promotions, and the 30-day transformation
-- (a plan followed for a month with visible, measured change). Each award is
-- one-time: `key` is UNIQUE and grants are INSERT OR IGNORE.
CREATE TABLE IF NOT EXISTS awards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,             -- e.g. streak_30, rank_C, transform30_1
  title      TEXT NOT NULL,
  icon       TEXT,                             -- emoji badge
  detail     TEXT,                             -- what earned it, with the numbers
  goal_id    INTEGER REFERENCES goals(id),
  xp         INTEGER NOT NULL DEFAULT 25,      -- bonus XP granted with the award
  awarded_at TEXT NOT NULL
);
