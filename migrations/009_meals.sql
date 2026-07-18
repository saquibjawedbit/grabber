-- 009: calorie tracking. Meals are their own table, not `health` rows — one meal
-- carries four numbers (kcal + three macros) that must stay together, and the
-- dashboard stacks them per day; four parallel health series would let them drift.
CREATE TABLE IF NOT EXISTS meals (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,               -- "2 eggs + 2 rotis + milk"
  kcal      REAL NOT NULL,
  protein_g REAL,                        -- macros optional: the agent estimates when
  carbs_g   REAL,                        -- the owner doesn't state them
  fat_g     REAL,
  note      TEXT,
  at        TEXT NOT NULL                -- UTC ISO; the dashboard buckets by IST day
);

CREATE INDEX IF NOT EXISTS idx_meals_at ON meals(at);
