-- Add the tenant discriminator `user_id` to every per-owner table whose primary key is
-- already a global autoincrement id (or a globally-unique external id, for emails/events —
-- gmail/gcal ids never collide across accounts). NOT NULL DEFAULT 1 backfills every
-- existing row to tenant #1 (the current owner) for free, so nothing breaks.
--
-- Tables whose PRIMARY KEY / UNIQUE is a NATURAL key that collides across tenants
-- (profile.key, state.key, accounts.name, people.name, ...) are rebuilt in 013.
-- The inert opportunity-engine tables (postings/idf/alerts/outcomes/drafts/calibration/
-- watchers) are intentionally left global — they carry no live per-tenant data.
ALTER TABLE memories       ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chat_history   ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reminders      ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE goals          ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE milestones     ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE quests         ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activity       ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE metrics        ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plan_questions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE research       ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE applications   ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE health         ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meals          ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications  ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE transactions   ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE interactions   ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE emails         ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events         ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

-- Composite indexes on the hot per-tenant read paths. (user_id, id) is universally valid
-- (every table above has an `id`, string or int) and keeps single-tenant scans cheap.
CREATE INDEX IF NOT EXISTS idx_memories_user      ON memories(user_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_history_user  ON chat_history(user_id, id);
CREATE INDEX IF NOT EXISTS idx_reminders_user     ON reminders(user_id, id);
CREATE INDEX IF NOT EXISTS idx_goals_user         ON goals(user_id, id);
CREATE INDEX IF NOT EXISTS idx_milestones_user    ON milestones(user_id, goal_id);
CREATE INDEX IF NOT EXISTS idx_quests_user        ON quests(user_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_activity_user      ON activity(user_id, id);
CREATE INDEX IF NOT EXISTS idx_metrics_user       ON metrics(user_id, id);
CREATE INDEX IF NOT EXISTS idx_research_user      ON research(user_id, id);
CREATE INDEX IF NOT EXISTS idx_transactions_user  ON transactions(user_id, id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
CREATE INDEX IF NOT EXISTS idx_emails_user        ON emails(user_id, id);
CREATE INDEX IF NOT EXISTS idx_events_user        ON events(user_id, id);
