-- Arbitrary numeric metrics the agent logs to track + chart over time. Additive:
--   wrangler d1 execute grabber --remote --file migrations/005_metrics.sql

CREATE TABLE IF NOT EXISTS metrics (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  value   REAL NOT NULL,
  unit    TEXT,
  note    TEXT,
  goal_id INTEGER,
  at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name, at);
