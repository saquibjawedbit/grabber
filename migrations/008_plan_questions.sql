-- 008: the planner asks back.
-- A mature plan needs facts the System may not have (waist size, hours free, equipment,
-- budget, current skill level). The planner now emits up to 3 targeted questions per
-- plan/adapt; they surface on Telegram, in chat, and on the dashboard. An answer is
-- stored here AND as a memory, then the goal is re-planned immediately with the new
-- context — the ask → answer → better-plan loop.
CREATE TABLE IF NOT EXISTS plan_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     INTEGER NOT NULL REFERENCES goals(id),
  question    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',   -- open | answered | dismissed
  answer      TEXT,
  announced   INTEGER NOT NULL DEFAULT 0,     -- sent to Telegram yet?
  asked_at    TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_plan_questions_goal ON plan_questions(goal_id, status);
